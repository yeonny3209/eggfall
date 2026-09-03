/**
 * 넷 클라이언트 — 접속 · 예측 적용 · 원격 플레이어 추적
 *
 * 설계 원칙: **서버가 없어도 게임은 돌아간다.**
 * GitHub Pages 같은 정적 호스팅에는 Colyseus 서버를 띄울 수 없으므로,
 * 접속에 실패하면 조용히 싱글플레이로 떨어진다. 접속 여부는 HUD 로만 알린다.
 *
 * 여기는 "연결"만 다룬다. 예측/보정 수학은 prediction.ts 에, 렌더링은 world/ 에 있다 (§13.6).
 */

import { Client, getStateCallbacks, type Room } from 'colyseus.js';
import type { WorldState, PlayerState, EggState } from './schema';
import {
  INTERP_DELAY,
  MSG_ABSORBED,
  MSG_DROP,
  MSG_INPUT,
  MSG_PICKUP,
  MSG_PICKUP_DENIED,
  ROOM_NAME,
  type AbsorbedEvent,
  type InputCommand,
  type PickupDeniedEvent,
} from './protocol';
import { InterpBuffer, type ServerSnapshot, type Snapshot } from './prediction';

export type NetStatus = 'offline' | 'connecting' | 'online' | 'error';

/** 원격 플레이어 하나 — 보간 버퍼와 겉모습 정보 */
export type RemotePlayer = {
  id: string;
  name: string;
  buffer: InterpBuffer;
  stage: number;
  tintElement: string;
  tintRatio: number;
  carriedRarity: string;
  carriedElement: string;
  /** 마지막으로 보간한 결과 — 렌더러가 읽는다 */
  render: Snapshot | null;
};

export type NetEvents = {
  onAbsorbed?: (e: AbsorbedEvent) => void;
  onPickupDenied?: (e: PickupDeniedEvent) => void;
  onStatusChange?: (s: NetStatus) => void;
};

export class NetClient {
  status: NetStatus = 'offline';
  room: Room<WorldState> | null = null;
  /** 내 sessionId. 오프라인이면 빈 문자열. */
  sessionId = '';

  readonly remotes = new Map<string, RemotePlayer>();
  /** 서버가 보낸 알 목록 (온라인일 때 스포너를 대체한다) */
  readonly eggs = new Map<string, EggState>();

  private events: NetEvents;
  /** 로컬 시각 기준으로 스냅샷에 찍는 타임스탬프 (초) */
  private clock = 0;

  constructor(events: NetEvents = {}) {
    this.events = events;
  }

  /**
   * 접속을 시도한다. 실패해도 예외를 던지지 않는다 — 싱글플레이로 계속 가야 하므로.
   * @param url ws:// 또는 wss:// 주소. 비어 있으면 아예 시도하지 않는다.
   */
  async connect(url: string, name = ''): Promise<boolean> {
    if (!url) {
      this.setStatus('offline');
      return false;
    }
    this.setStatus('connecting');
    try {
      const client = new Client(url);
      const room = await client.joinOrCreate<WorldState>(ROOM_NAME, { name });
      this.room = room;
      this.sessionId = room.sessionId;
      this.bind(room);
      this.setStatus('online');
      return true;
    } catch {
      // 서버가 없는 건 정상적인 상황이다. 조용히 싱글플레이로.
      this.room = null;
      this.setStatus('error');
      return false;
    }
  }

  private setStatus(s: NetStatus) {
    if (this.status === s) return;
    this.status = s;
    this.events.onStatusChange?.(s);
  }

  private bind(room: Room<WorldState>) {
    // Colyseus 0.16 부터 상태 콜백은 getStateCallbacks 를 거쳐 등록한다
    const $ = getStateCallbacks(room);

    $(room.state).players.onAdd((p: PlayerState, id: string) => {
      if (id === this.sessionId) return; // 내 것은 예측으로 굴린다
      this.remotes.set(id, {
        id,
        name: p.name,
        buffer: new InterpBuffer(),
        stage: p.stage,
        tintElement: p.tintElement,
        tintRatio: p.tintRatio,
        carriedRarity: p.carriedRarity,
        carriedElement: p.carriedElement,
        render: null,
      });
    });

    $(room.state).players.onRemove((_p: PlayerState, id: string) => {
      this.remotes.delete(id);
    });

    $(room.state).eggs.onAdd((e: EggState, nestId: string) => {
      this.eggs.set(nestId, e);
    });
    $(room.state).eggs.onRemove((_e: EggState, nestId: string) => {
      this.eggs.delete(nestId);
    });

    room.onMessage(MSG_ABSORBED, (e: AbsorbedEvent) => this.events.onAbsorbed?.(e));
    room.onMessage(MSG_PICKUP_DENIED, (e: PickupDeniedEvent) => this.events.onPickupDenied?.(e));

    room.onLeave(() => {
      this.room = null;
      this.remotes.clear();
      this.eggs.clear();
      this.setStatus('offline');
    });
  }

  /* ==========================================================================
     매 프레임
     ========================================================================== */

  /**
   * 원격 플레이어 스냅샷을 모으고 보간한다.
   * 서버 상태는 Colyseus 가 알아서 갱신해주므로, 우리는 "언제 그 값을 봤는지"만 기록하면 된다.
   */
  update(dt: number) {
    this.clock += dt;
    if (!this.room) return;

    const renderTime = this.clock - INTERP_DELAY;

    for (const [id, r] of this.remotes) {
      const p = this.room.state.players.get(id);
      if (!p) continue;

      // 값이 실제로 바뀌었을 때만 스냅샷을 쌓는다.
      // 매 프레임 넣으면 같은 값이 중복돼 보간이 계단처럼 끊긴다.
      const last = r.buffer.sample(Infinity);
      if (!last || last.x !== p.x || last.y !== p.y || last.z !== p.z) {
        r.buffer.push({ t: this.clock, x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch });
      }

      r.render = r.buffer.sample(renderTime);
      r.buffer.prune(renderTime);

      // 겉모습 정보는 보간할 필요가 없다 — 바뀔 때만 반영하면 된다
      r.name = p.name;
      r.stage = p.stage;
      r.tintElement = p.tintElement;
      r.tintRatio = p.tintRatio;
      r.carriedRarity = p.carriedRarity;
      r.carriedElement = p.carriedElement;
    }
  }

  /** 내 서버 권위 상태. 오프라인이거나 아직 못 받았으면 null. */
  myServerState(): ServerSnapshot | null {
    const p = this.room?.state.players.get(this.sessionId);
    if (!p) return null;
    return {
      x: p.x, y: p.y, z: p.z,
      vx: p.vx, vy: p.vy, vz: p.vz,
      yaw: p.yaw, pitch: p.pitch,
      lastSeq: p.lastSeq,
    };
  }

  /* ==========================================================================
     송신
     ========================================================================== */

  sendInput(cmd: InputCommand) {
    this.room?.send(MSG_INPUT, cmd);
  }

  sendPickup(nestId: string) {
    this.room?.send(MSG_PICKUP, { nestId });
  }

  sendDrop() {
    this.room?.send(MSG_DROP);
  }

  get online(): boolean {
    return this.room !== null && this.status === 'online';
  }

  /** 나를 포함한 접속 인원 */
  get playerCount(): number {
    return this.room ? this.room.state.players.size : 1;
  }

  dispose() {
    this.room?.leave();
    this.room = null;
    this.remotes.clear();
    this.eggs.clear();
  }
}

/**
 * 서버 주소를 정한다.
 * 1. VITE_SERVER_URL 빌드 환경변수 (배포용)
 * 2. ?server=ws://... 쿼리 파라미터 (테스트용)
 * 3. localhost 에서 개발 중이면 로컬 서버
 * 4. 그 외에는 빈 문자열 = 싱글플레이
 */
export function resolveServerUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get('server');
  if (fromQuery) return fromQuery;

  const fromEnv = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (fromEnv) return fromEnv;

  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
    return `ws://${location.hostname}:2567`;
  }
  return '';
}
