/**
 * 권위 서버 방 — 모든 판정은 여기서 난다
 *
 * 서버가 권위를 갖는 이유는 치트 방지만이 아니다. **알 하나를 두 명이 동시에
 * 주울 수 없어야** 하기 때문이다. 그게 §2 "알을 든 순간 곧 표적이 된다" 의 전제다.
 *
 * 핵심: 서버는 클라이언트와 **완전히 같은 stepFlight** 를 돌린다.
 * Phase 0 에서 시뮬레이션을 렌더링과 분리해둔 덕에(§13.3) 그대로 재사용할 수 있다.
 */

import { Room, type Client } from '@colyseus/core';
import { PlayerState, EggState, WorldState } from '../src/net/schema';
import {
  MAX_CLIENTS,
  MSG_ABSORBED,
  MSG_DROP,
  MSG_INPUT,
  MSG_PICKUP,
  MSG_PICKUP_DENIED,
  TICK_RATE,
  toFlightInput,
  type AbsorbedEvent,
  type InputCommand,
  type PickupDeniedEvent,
  type PickupRequest,
} from '../src/net/protocol';
import { createFlightState, stepFlight } from '../src/flight/simulate';
import { createSpawner, stepSpawner, takeEgg, activeEggs } from '../src/egg/spawn';
import {
  absorbCarried,
  carrySpeedMult,
  createProgress,
  drop,
  inHomeNest,
  normalizedAffinity,
  pickUp,
} from '../src/player/progress';
import balance from '../src/data/balance.json';
import type { Element, FlightState, PlayerProgress, SpawnerState, Stage } from '../src/types';
import { ELEMENTS } from '../src/types';

const C = balance.carry;
const G = balance.growth;

/** 클라이언트에 동기화되지 않는 서버 전용 플레이어 데이터 */
type ServerPlayer = {
  flight: FlightState;
  progress: PlayerProgress;
  /** 아직 처리하지 않은 입력 큐 */
  queue: InputCommand[];
  lastSeq: number;
  /** 홈 둥지에서 흡수 채널링 경과 (초) */
  absorbTimer: number;
};

export class WorldRoom extends Room<WorldState> {
  maxClients = MAX_CLIENTS;

  private spawner!: SpawnerState;
  private server = new Map<string, ServerPlayer>();

  onCreate() {
    this.state = new WorldState();

    // 스포너는 서버만 갖는다. 클라이언트가 각자 굴리면 서로 다른 알을 보게 된다.
    this.spawner = createSpawner(4242, Date.now());
    this.syncEggs();

    this.onMessage(MSG_INPUT, (client, cmd: InputCommand) => {
      const sp = this.server.get(client.sessionId);
      if (!sp) return;
      // 오래된/중복 입력은 버린다. 재전송이나 순서 뒤바뀜 방어.
      if (cmd.seq <= sp.lastSeq) return;
      // 큐가 폭주하면 렉 유발 클라이언트가 방 전체를 느리게 만든다. 상한을 둔다.
      if (sp.queue.length > 120) sp.queue.shift();
      sp.queue.push(cmd);
    });

    this.onMessage(MSG_PICKUP, (client, req: PickupRequest) => {
      this.handlePickup(client, req);
    });

    this.onMessage(MSG_DROP, (client) => {
      const sp = this.server.get(client.sessionId);
      if (!sp || !sp.progress.carried) return;
      drop(sp.progress);
      sp.absorbTimer = 0;
      this.writeCarried(client.sessionId, sp);
    });

    this.setSimulationInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  onJoin(client: Client, options?: { name?: string }) {
    const p = new PlayerState();
    p.id = client.sessionId;
    p.name = (options?.name ?? '').slice(0, 16) || `용사-${client.sessionId.slice(0, 4)}`;

    // 홈 둥지 근처에서 시작한다 — 핵심 루프의 출발점이자 종착점
    const angle = Math.random() * Math.PI * 2;
    const flight = createFlightState(
      balance.homeNest.x + Math.cos(angle) * 90,
      150,
      balance.homeNest.z + Math.sin(angle) * 90,
      angle,
    );
    p.x = flight.x;
    p.y = flight.y;
    p.z = flight.z;

    this.state.players.set(client.sessionId, p);
    this.server.set(client.sessionId, {
      flight,
      progress: createProgress(),
      queue: [],
      lastSeq: 0,
      absorbTimer: 0,
    });
  }

  onLeave(client: Client) {
    const sp = this.server.get(client.sessionId);
    // 들고 있던 알은 사라진다. 되돌려주면 "물고 로그아웃" 이 무손실 전략이 된다.
    if (sp?.progress.carried) drop(sp.progress);
    this.server.delete(client.sessionId);
    this.state.players.delete(client.sessionId);
  }

  /* ==========================================================================
     틱
     ========================================================================== */

  private tick() {
    const now = Date.now();

    for (const [id, sp] of this.server) {
      const ps = this.state.players.get(id);
      if (!ps) continue;

      const stageDef = stageDefOf(sp.progress.stage);

      // 이번 틱에 도착한 입력을 순서대로 소화한다.
      // 한 번에 너무 많이 처리하면 렉 후 몰아치기로 순간이동처럼 보이므로 상한을 둔다.
      let processed = 0;
      while (sp.queue.length > 0 && processed < 8) {
        const cmd = sp.queue.shift()!;
        // dt 를 클라이언트가 정하게 두면 그게 곧 스피드핵이다. 반드시 서버가 조인다.
        const dt = Math.min(Math.max(cmd.dt, 0), 0.1);
        stepFlight(
          sp.flight,
          toFlightInput(cmd),
          cmd.lookYaw,
          cmd.lookPitch,
          dt,
          stageDef.turnPenalty,
          carrySpeedMult(sp.progress),
        );
        sp.lastSeq = cmd.seq;
        processed++;
      }

      // 흡수 (§2 둥지 귀환)
      if (sp.progress.carried && inHomeNest(sp.flight.x, sp.flight.z)) {
        sp.absorbTimer += 1 / TICK_RATE;
        if (sp.absorbTimer >= G.absorbSeconds) {
          const carried = sp.progress.carried;
          const result = absorbCarried(sp.progress);
          sp.absorbTimer = 0;
          if (result) {
            this.writeCarried(id, sp);
            this.writeProgress(ps, sp);
            const ev: AbsorbedEvent = {
              gained: result.gained,
              leveledUp: result.leveledUp,
              toStage: result.toStage,
              element: carried.element,
              rarity: carried.rarity,
            };
            this.clients.find((c: Client) => c.sessionId === id)?.send(MSG_ABSORBED, ev);
          }
        }
      } else {
        sp.absorbTimer = 0;
      }

      // 동기화 상태에 기록
      ps.x = sp.flight.x;
      ps.y = sp.flight.y;
      ps.z = sp.flight.z;
      ps.yaw = sp.flight.yaw;
      ps.pitch = sp.flight.pitch;
      ps.vx = sp.flight.vx;
      ps.vy = sp.flight.vy;
      ps.vz = sp.flight.vz;
      ps.lastSeq = sp.lastSeq;
    }

    // 알 리스폰 — 서버만 굴린다
    if (stepSpawner(this.spawner, now).length > 0) this.syncEggs();

    this.state.serverTime = now;
  }

  /* ==========================================================================
     줍기 중재 — 서버가 권위를 갖는 가장 중요한 이유
     ========================================================================== */

  private handlePickup(client: Client, req: PickupRequest) {
    const sp = this.server.get(client.sessionId);
    if (!sp) return;

    const deny = (reason: PickupDeniedEvent['reason']) =>
      client.send(MSG_PICKUP_DENIED, { reason } satisfies PickupDeniedEvent);

    if (sp.progress.carried) return deny('full');

    const slot = this.spawner.slots.find((s) => s.nest.id === req.nestId);
    // 이미 남이 가져갔다 — 먼저 요청한 쪽이 이긴다
    if (!slot || !slot.egg) return deny('taken');

    // 사거리 검증. 클라이언트를 믿으면 맵 반대편에서도 줍는다.
    // 지연 보상으로 약간의 여유(1.6배)를 준다.
    const d = Math.hypot(
      slot.egg.x - sp.flight.x,
      slot.egg.y - sp.flight.y,
      slot.egg.z - sp.flight.z,
    );
    if (d > C.pickupRange * 1.6) return deny('range');

    const taken = takeEgg(this.spawner, req.nestId, Date.now());
    if (!taken || !pickUp(sp.progress, taken.egg)) return deny('taken');

    this.syncEggs();
    this.writeCarried(client.sessionId, sp);
  }

  /* ==========================================================================
     동기화 헬퍼
     ========================================================================== */

  /** 스포너의 알 목록을 동기화 상태에 반영한다 (추가/제거 모두) */
  private syncEggs() {
    const live = activeEggs(this.spawner);
    const seen = new Set<string>();

    for (const se of live) {
      seen.add(se.nestId);
      let e = this.state.eggs.get(se.nestId);
      if (!e) {
        e = new EggState();
        e.nestId = se.nestId;
        this.state.eggs.set(se.nestId, e);
      }
      e.x = se.x;
      e.y = se.y;
      e.z = se.z;
      e.rarity = se.egg.rarity;
      e.element = se.egg.element;
      e.geneMass = se.egg.geneMass;
    }

    for (const nestId of Array.from(this.state.eggs.keys())) {
      if (!seen.has(nestId)) this.state.eggs.delete(nestId);
    }
  }

  private writeCarried(id: string, sp: ServerPlayer) {
    const ps = this.state.players.get(id);
    if (!ps) return;
    ps.carriedRarity = sp.progress.carried?.rarity ?? '';
    ps.carriedElement = sp.progress.carried?.element ?? '';
  }

  private writeProgress(ps: PlayerState, sp: ServerPlayer) {
    ps.stage = sp.progress.stage;
    ps.geneMass = sp.progress.geneMass;

    // 외형용 대표 속성 — 전체 친화도를 보낼 필요 없이 이 둘이면 색이 재현된다 (§6.2)
    const norm = normalizedAffinity(sp.progress);
    let best: Element | '' = '';
    let bestV = 0;
    for (const e of ELEMENTS) {
      if (norm[e] > bestV) {
        bestV = norm[e];
        best = e;
      }
    }
    ps.tintElement = best;
    ps.tintRatio = bestV;
  }
}

function stageDefOf(stage: Stage) {
  return balance.stage[String(stage) as keyof typeof balance.stage] as {
    name: string;
    scale: number;
    turnPenalty: number;
  };
}
