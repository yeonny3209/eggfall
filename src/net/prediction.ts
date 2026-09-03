/**
 * 예측 · 보정 · 보간 — 넷코드의 심장 (기획서 §11 Phase 2 "예측/보정")
 *
 * 문제: 서버 왕복이 100ms 라면, 키를 누르고 100ms 뒤에 움직이는 게임은 못 한다.
 * 해법 세 가지를 겹친다.
 *
 *   1. 예측(prediction)   — 내 입력은 서버 응답을 기다리지 않고 즉시 로컬에 적용한다.
 *   2. 보정(reconciliation) — 서버 상태가 오면 그 시점으로 되감고, 아직 확인 안 된
 *                            입력만 다시 굴린다. 어긋난 만큼은 화면에서 서서히 흡수한다.
 *   3. 보간(interpolation)  — 남의 드래곤은 100ms 쯤 과거로 그린다. 스냅샷 사이를
 *                            메워야 20Hz 전송이 부드러워 보인다.
 *
 * 이 모듈은 Three.js 도 Colyseus 도 import 하지 않는다. 순수 함수만 둔다 (§13.3, §13.6).
 * 서버와 클라이언트가 **같은 stepFlight** 를 돌리기 때문에 예측이 성립한다 —
 * Phase 0 에서 시뮬레이션을 렌더링과 분리해둔 이유가 여기서 회수된다.
 */

import type { FlightState } from '../types';
import { stepFlight } from '../flight/simulate';
import {
  RECONCILE_RATE,
  SNAP_DISTANCE,
  toFlightInput,
  type InputCommand,
} from './protocol';

/* ==========================================================================
   예측 / 보정
   ========================================================================== */

export type PredictionState = {
  /** 서버가 아직 확인하지 않은 입력들. 보정 때 다시 굴린다. */
  pending: InputCommand[];
  nextSeq: number;
  /**
   * 보정으로 생긴 위치 오차. 즉시 순간이동시키면 화면이 튀므로
   * 이 값을 렌더 위치에 더해두고 매 프레임 0으로 줄인다.
   */
  errX: number;
  errY: number;
  errZ: number;
};

export function createPrediction(): PredictionState {
  return { pending: [], nextSeq: 1, errX: 0, errY: 0, errZ: 0 };
}

/** 다음 입력 시퀀스 번호를 발급하고 기록한다 */
export function recordInput(p: PredictionState, cmd: InputCommand): void {
  p.pending.push(cmd);
  // 무한정 쌓이지 않게 상한을 둔다. 서버가 죽었는데 메모리까지 새면 안 된다.
  if (p.pending.length > 240) p.pending.shift();
}

export function nextSeq(p: PredictionState): number {
  return p.nextSeq++;
}

/**
 * 서버가 보낸 권위 상태.
 *
 * 위치뿐 아니라 **속도와 자세까지** 필요하다. 위치만 되감고 로컬 속도로 재생하면
 * 재생 결과가 원래 예측과 달라져 보정할 때마다 화면이 미세하게 튄다.
 */
export type ServerSnapshot = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  lastSeq: number;
};

/**
 * 서버 상태로 되감고, 확인되지 않은 입력을 다시 굴린다.
 *
 * @param local  클라이언트가 예측으로 굴려온 상태. 제자리에서 수정된다.
 * @returns 이번 보정으로 위치가 얼마나 튀었는지 (디버그·테스트용)
 */
export function reconcile(
  local: FlightState,
  p: PredictionState,
  server: ServerSnapshot,
  turnRateMult = 1,
  speedMult = 1,
): number {
  // 1. 서버가 처리했다고 알린 입력은 버린다
  while (p.pending.length > 0 && p.pending[0].seq <= server.lastSeq) {
    p.pending.shift();
  }

  // 2. 보정 전 예측 위치를 기억해둔다 (오차 계산용)
  const beforeX = local.x;
  const beforeY = local.y;
  const beforeZ = local.z;

  // 3. 서버 상태로 완전히 되감는다. 위치·속도·자세가 전부 맞아야
  //    아래 재생이 원래 예측과 같은 결과를 낸다.
  //
  //    단, 스키마 버전이 어긋난 서버(필드가 없는 구버전)에 붙으면 undefined 가 흘러들어와
  //    NaN 이 시뮬레이션 전체를 오염시키고 화면이 통째로 검게 된다. 실제로 겪었다.
  //    권위 값이라도 숫자가 아니면 받아들이지 않는다 — 예측을 유지하는 편이 훨씬 낫다.
  if (!isFiniteSnapshot(server)) return 0;

  local.x = server.x;
  local.y = server.y;
  local.z = server.z;
  local.vx = server.vx;
  local.vy = server.vy;
  local.vz = server.vz;
  local.yaw = server.yaw;
  local.pitch = server.pitch;

  // 4. 아직 확인 안 된 입력만 다시 적용
  for (const cmd of p.pending) {
    stepFlight(
      local,
      toFlightInput(cmd),
      cmd.lookYaw,
      cmd.lookPitch,
      cmd.dt,
      turnRateMult,
      speedMult,
    );
  }

  // 5. 예측이 얼마나 빗나갔는지
  const dx = beforeX - local.x;
  const dy = beforeY - local.y;
  const dz = beforeZ - local.z;
  const dist = Math.hypot(dx, dy, dz);

  if (dist > SNAP_DISTANCE) {
    // 너무 크게 벌어졌다 = 텔레포트·리스폰·긴 렉. 부드럽게 당기면 오히려 이상하다.
    p.errX = p.errY = p.errZ = 0;
  } else {
    // 화면상으로는 예전 위치에서 시작해 서서히 진짜 위치로 옮겨간다
    p.errX = dx;
    p.errY = dy;
    p.errZ = dz;
  }

  return dist;
}

/** 보정 오차를 매 프레임 조금씩 흡수한다. 렌더 위치 = 시뮬 위치 + 남은 오차. */
export function decayError(p: PredictionState, dt: number): void {
  const k = Math.exp(-RECONCILE_RATE * dt);
  p.errX *= k;
  p.errY *= k;
  p.errZ *= k;
  // 충분히 작아지면 0으로 떨어뜨려 부동소수점 찌꺼기를 남기지 않는다
  if (Math.abs(p.errX) < 0.001) p.errX = 0;
  if (Math.abs(p.errY) < 0.001) p.errY = 0;
  if (Math.abs(p.errZ) < 0.001) p.errZ = 0;
}

/* ==========================================================================
   원격 플레이어 보간
   ========================================================================== */

export type Snapshot = {
  /** 이 스냅샷을 받은 로컬 시각 (초) */
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
};

/**
 * 스냅샷 링 버퍼. 20Hz 로 오는 남의 위치를 60fps 로 부드럽게 메운다.
 *
 * 외삽(extrapolation)은 하지 않는다. 맞추려다 틀리면 캐릭터가 벽을 뚫고
 * 되돌아오는 게 보이는데, 그게 살짝 늦는 것보다 훨씬 나쁘다.
 */
export class InterpBuffer {
  private buf: Snapshot[] = [];
  /** 이 이상은 들고 있지 않는다 — 오래된 건 어차피 못 쓴다 */
  private readonly cap = 32;

  push(s: Snapshot): void {
    // 시각이 역행하는 스냅샷은 버린다 (재연결·순서 뒤바뀜 방어)
    const last = this.buf[this.buf.length - 1];
    if (last && s.t <= last.t) return;
    this.buf.push(s);
    if (this.buf.length > this.cap) this.buf.shift();
  }

  get size(): number {
    return this.buf.length;
  }

  /**
   * renderTime 시점의 위치를 뽑는다.
   * 두 스냅샷 사이면 보간하고, 버퍼보다 미래면 마지막 값을 붙든다(정지).
   */
  sample(renderTime: number): Snapshot | null {
    if (this.buf.length === 0) return null;
    if (this.buf.length === 1) return this.buf[0];

    // 뒤에서부터 renderTime 을 감싸는 구간을 찾는다
    for (let i = this.buf.length - 1; i > 0; i--) {
      const b = this.buf[i];
      const a = this.buf[i - 1];
      if (a.t <= renderTime && renderTime <= b.t) {
        const span = b.t - a.t;
        const f = span > 0 ? (renderTime - a.t) / span : 0;
        return {
          t: renderTime,
          x: a.x + (b.x - a.x) * f,
          y: a.y + (b.y - a.y) * f,
          z: a.z + (b.z - a.z) * f,
          yaw: a.yaw + shortestAngle(a.yaw, b.yaw) * f,
          pitch: a.pitch + (b.pitch - a.pitch) * f,
        };
      }
    }

    // renderTime 이 버퍼보다 과거면 가장 오래된 것, 미래면 가장 최신 것
    const first = this.buf[0];
    if (renderTime < first.t) return first;
    return this.buf[this.buf.length - 1];
  }

  /** renderTime 보다 확실히 과거인 스냅샷은 하나만 남기고 버린다 */
  prune(renderTime: number): void {
    while (this.buf.length > 2 && this.buf[1].t < renderTime) this.buf.shift();
  }

  clear(): void {
    this.buf.length = 0;
  }
}

/** -PI~PI 로 접은 각도 차이. 359도 → 1도를 -358도가 아니라 +2도로 돌게 한다. */
export function shortestAngle(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * 서버 스냅샷의 모든 수치가 유한한가.
 * 스키마 버전이 어긋나면 undefined 가 섞여 들어오는데, 그걸 그대로 적용하면
 * NaN 이 위치·속도로 번져 화면이 통째로 사라진다.
 */
export function isFiniteSnapshot(s: ServerSnapshot): boolean {
  return (
    Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z) &&
    Number.isFinite(s.vx) && Number.isFinite(s.vy) && Number.isFinite(s.vz) &&
    Number.isFinite(s.yaw) && Number.isFinite(s.pitch)
  );
}
