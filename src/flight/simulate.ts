/**
 * 비행 시뮬레이션 — "스펙테이터 캠" 모델
 *
 * 원래 Phase 0 은 관성·실속·스태미나가 있는 항공기식 모델이었다. 하지만 실제로 조작해보니
 * 롤로 선회하고 피치로 당기고 스태미나를 관리하는 게 진입장벽이 너무 높았다.
 * 그래서 훨씬 쉬운 모델로 바꾼다: **마우스가 보는 방향이 곧 날아가는 방향**이고,
 * WASD 는 그 방향 기준 전진/좌우, Space/Shift 는 순수 상승/하강이다.
 * 실속도 스태미나도 상승기류도 없다 — 무제한으로, 마음먹은 대로 난다.
 *
 * 이 모듈은 Three.js 를 import 하지 않는다. 순수 함수만 둔다.
 * 이유: 넷코드 단계에서 서버가 같은 코드로 검증 시뮬레이션을 돌려야 하고,
 *       그때 렌더링이 섞여 있으면 통째로 다시 써야 한다 (§13.3, §13.6).
 */

import type { FlightInput, FlightState, Layer } from '../types';
import balance from '../data/balance.json';
import { terrainHeight } from '../world/terrain';

const F = balance.flight;

export type Vec3 = { x: number; y: number; z: number };

/** 시뮬레이션 1스텝의 부가 결과 — 렌더링·사운드가 참조한다 */
export type FlightEvents = {
  /** 이번 스텝에 지면에 처음 닿았는가 */
  justLanded: boolean;
};

export function createFlightState(x = 0, y = 150, z = 0, yaw = 0): FlightState {
  return { x, y, z, vx: 0, vy: 0, vz: 0, yaw, pitch: 0, grounded: false };
}

export function neutralInput(): FlightInput {
  return { forward: 0, strafe: 0, ascend: false, descend: false, interact: false };
}

/** 자세(pitch/yaw)에서 정면 방향 벡터를 만든다 */
export function forwardVector(pitch: number, yaw: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
}

/** 정면 기준 오른쪽 방향. 요만으로 계산해 A/D 가 피치와 무관하게 수평으로만 움직이게 한다. */
function rightVector(yaw: number): Vec3 {
  return { x: Math.sin(yaw + Math.PI / 2), y: 0, z: Math.cos(yaw + Math.PI / 2) };
}

/** 고도 3층 구조 (§9) — 지금은 시각적 구분일 뿐, 수치 효과는 없다 */
export function layerOf(y: number): Layer {
  if (y >= F.highLayerY) return 'high';
  if (y >= F.midLayerY) return 'mid';
  return 'low';
}

/**
 * 비행 1스텝. state 를 제자리에서 갱신하고 이벤트를 돌려준다.
 *
 * @param lookYaw / lookPitch  마우스가 누적해 온 목표 시점(rad). 매 프레임 InputSource 가 갱신한다.
 * @param turnRateMult  성장 단계에 따른 시점 추적 속도 배율 (§6.3 — 큰 용일수록 굼떠진다).
 *   마우스를 그대로 순간 반영하지 않고, 이 배율만큼의 속도로 목표 각도를 뒤쫓는다.
 *   1에 가까우면 사실상 즉시 반응(작은 용), 낮을수록 크고 둔한 용답게 지연이 생긴다.
 */
export function stepFlight(
  state: FlightState,
  input: FlightInput,
  lookYaw: number,
  lookPitch: number,
  dt: number,
  turnRateMult = 1,
  speedMult = 1,
): FlightEvents {
  const ev: FlightEvents = { justLanded: false };

  /* ---------- 시점 추적 ---------- */
  const turnRate = F.turnRate * turnRateMult;
  const k = 1 - Math.exp(-turnRate * dt);
  state.yaw += wrapAngle(lookYaw - state.yaw) * k;
  state.pitch += (lookPitch - state.pitch) * k;

  const fwd = forwardVector(state.pitch, state.yaw);
  const right = rightVector(state.yaw);

  /* ---------- 목표 속도 ---------- */
  // 운반 중이면 전체적으로 느려진다 (§2 — 알을 쥔 동안 이동 -25%)
  const move = F.moveSpeed * speedMult;
  const vert = F.verticalSpeed * speedMult;
  const targetVx = fwd.x * input.forward * move + right.x * input.strafe * move;
  const targetVy =
    fwd.y * input.forward * move +
    (input.ascend ? vert : 0) -
    (input.descend ? vert : 0);
  const targetVz = fwd.z * input.forward * move + right.z * input.strafe * move;

  // 즉시 정지/출발이 아니라 부드럽게 가감속한다 — 이게 없으면 뚝뚝 끊기는 느낌이 든다.
  const accel = 1 - Math.exp(-F.accelRate * dt);
  state.vx += (targetVx - state.vx) * accel;
  state.vy += (targetVy - state.vy) * accel;
  state.vz += (targetVz - state.vz) * accel;

  /* ---------- 적분 ---------- */
  state.x += state.vx * dt;
  state.y += state.vy * dt;
  state.z += state.vz * dt;

  /* ---------- 지형 충돌 ---------- */
  const ground = terrainHeight(state.x, state.z);
  if (state.y <= ground) {
    if (!state.grounded) ev.justLanded = true;
    state.y = ground;
    if (state.vy < 0) state.vy = 0;
    state.grounded = true;
  } else {
    state.grounded = false;
  }

  return ev;
}

/** -PI~PI 로 접은 각도 차이. 359도에서 1도로 돌 때 최단 경로(2도)로 돌게 한다. */
function wrapAngle(a: number): number {
  a = ((a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}
