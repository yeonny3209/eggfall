/**
 * 비행 시뮬레이션 — Phase 0의 심장
 *
 * 기획서 §11: "비행 컨트롤러만. 여기가 재미없으면 전부 무의미."
 *
 * 이 모듈은 Three.js 를 import 하지 않는다. 순수 함수만 둔다.
 * 이유: 넷코드 단계에서 서버가 같은 코드로 검증 시뮬레이션을 돌려야 하고,
 *       그때 렌더링이 섞여 있으면 통째로 다시 써야 한다 (§13.3, §13.6).
 */

import type { FlightInput, FlightState, Layer } from '../types';
import balance from '../data/balance.json';
import { terrainHeight } from '../world/terrain';

const F = balance.flight;
const T = balance.thermals;

export type Vec3 = { x: number; y: number; z: number };

/** 상승기류 기둥 하나 (§9 — 스태미나 없이 고도를 얻는 유일한 방법) */
export type Thermal = { x: number; z: number };

/** 시뮬레이션 1스텝의 부가 결과 — 렌더링·사운드가 참조한다 */
export type FlightEvents = {
  /** 이번 스텝에 날갯짓이 발생했는가 */
  flapped: boolean;
  /** 상승기류 안에 있는가 (0~1 강도) */
  thermalStrength: number;
  /** 양력 비율. 1 미만이면 실속 중이다 */
  liftRatio: number;
  /** 이번 스텝에 착륙(스태미나 고갈 포함)했는가 */
  justLanded: boolean;
  /** 착륙 시 충돌 속도 (m/s). crashDamageSpeed 초과면 피해 */
  landingSpeed: number;
};

export function createFlightState(x = 0, y = 120, z = 0, yaw = 0): FlightState {
  // 초기 속도는 반드시 기수 방향이어야 한다.
  // 반대로 두면 시작하자마자 속도가 0을 지나며 실속에 빠진다.
  const fwd = forwardVector(0, yaw);
  const v0 = 42;
  return {
    x,
    y,
    z,
    vx: fwd.x * v0,
    vy: 0,
    vz: fwd.z * v0,
    pitch: 0,
    yaw,
    roll: 0,
    stamina: F.staminaMax,
    grounded: false,
  };
}

export function neutralInput(): FlightInput {
  return { pitch: 0, yaw: 0, roll: 0, flap: false, dive: false };
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** 자세(pitch/yaw)에서 기수 방향 벡터를 만든다 */
export function forwardVector(pitch: number, yaw: number): Vec3 {
  const cp = Math.cos(pitch);
  return { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: Math.cos(yaw) * cp };
}

/** 고도 3층 구조 (§9) */
export function layerOf(y: number): Layer {
  if (y >= F.highLayerY) return 'high';
  if (y >= F.midLayerY) return 'mid';
  return 'low';
}

/** 결정론적 상승기류 배치. 시드가 같으면 서버·클라가 같은 지형을 본다. */
export function generateThermals(seed = 1337): Thermal[] {
  const out: Thermal[] = [];
  let s = seed >>> 0;
  const rand = () => {
    // xorshift32 — 언어·플랫폼 간 결과가 같아야 하므로 Math.random 을 쓰지 않는다
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
  for (let i = 0; i < T.count; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * T.spawnRadius;
    out.push({ x: Math.cos(a) * r, z: Math.sin(a) * r });
  }
  return out;
}

/** 위치에서 받는 상승기류 강도 0~1 */
export function thermalAt(x: number, y: number, z: number, thermals: Thermal[]): number {
  if (y > T.maxY) return 0;
  let best = 0;
  for (let i = 0; i < thermals.length; i++) {
    const dx = x - thermals[i].x;
    const dz = z - thermals[i].z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < T.radius) {
      // 실제 상승기류처럼 코어는 균일하고 가장자리만 감쇠한다.
      // 중심에서만 세고 바로 떨어지는 원뿔형으로 두면, 선회 중 대부분을
      // 약한 구간에서 보내게 되어 돌아도 고도를 못 번다.
      const r = d / T.radius;
      const s = r < T.coreRatio ? 1 : 1 - (r - T.coreRatio) / (1 - T.coreRatio);
      if (s > best) best = s;
    }
  }
  // 고도가 높을수록 약해진다 — 기류만으로 천장까지 갈 수는 없다
  const fade = clamp(1 - y / T.maxY, 0, 1);
  return best * fade;
}

/** 날갯짓 쿨다운을 재는 런타임 값 (FlightState 는 직렬화 대상이라 분리) */
export type FlightRuntime = {
  flapCooldown: number;
  /** 실속 경고 지속 시간 — UI 깜빡임 방지용 */
  stallTime: number;
};

export function createRuntime(): FlightRuntime {
  return { flapCooldown: 0, stallTime: 0 };
}

/**
 * 비행 1스텝. state 를 제자리에서 갱신하고 이벤트를 돌려준다.
 *
 * 모델 요약
 *  - 속도는 스칼라가 아니라 벡터다. 기수 방향으로 서서히 정렬되며(alignRate),
 *    그 지연이 곧 관성이고 드리프트다.
 *  - 양력은 속도에 비례한다. 느려지면 뜨지 못하고 떨어진다(실속).
 *  - 중력은 기수 방향으로 일을 한다. 기수를 내리면 공짜로 속도를 얻는다.
 *    이게 §8.2 "고도를 벌고 → 내리꽂고 → 다시 벌기"의 물리적 근거다.
 */
export function stepFlight(
  state: FlightState,
  rt: FlightRuntime,
  input: FlightInput,
  dt: number,
  thermals: Thermal[],
  turnPenalty = 1,
): FlightEvents {
  const ev: FlightEvents = {
    flapped: false,
    thermalStrength: 0,
    liftRatio: 1,
    justLanded: false,
    landingSpeed: 0,
  };

  if (rt.flapCooldown > 0) rt.flapCooldown -= dt;

  const speed = Math.hypot(state.vx, state.vy, state.vz);

  /* ---------- 지상에 있을 때 ---------- */
  if (state.grounded) {
    state.vx *= 0.86;
    state.vz *= 0.86;
    state.vy = 0;
    state.y = terrainHeight(state.x, state.z);
    state.pitch += (0 - state.pitch) * Math.min(1, 4 * dt);
    state.roll += (0 - state.roll) * Math.min(1, 4 * dt);
    state.stamina = Math.min(F.staminaMax, state.stamina + F.staminaRegen * 1.8 * dt);
    // 이륙: 스태미나가 한 번 날갯짓할 만큼 돌아왔을 때만
    if (input.flap && state.stamina >= F.flapStaminaCost && rt.flapCooldown <= 0) {
      state.grounded = false;
      state.vy = F.flapImpulse * 1.4;
      state.stamina -= F.flapStaminaCost;
      rt.flapCooldown = F.flapInterval;
      ev.flapped = true;
    }
    state.x += state.vx * dt;
    state.z += state.vz * dt;
    return ev;
  }

  /* ---------- 자세 ---------- */
  // 큰 용일수록 선회가 무뎌진다 (§6.3 불변 규칙)
  state.pitch += input.pitch * F.pitchRate * turnPenalty * dt;
  state.pitch = clamp(state.pitch, -1.45, 1.45);

  state.roll += input.roll * F.rollRate * turnPenalty * dt;
  state.roll = clamp(state.roll, -1.3, 1.3);
  if (input.roll === 0) {
    // 입력이 없으면 수평으로 되돌아온다 — 롤을 유지하려면 계속 눌러야 한다
    state.roll += (0 - state.roll) * Math.min(1, F.autoLevelRate * dt);
  }

  // 뱅크턴: 기울인 채로 있으면 그쪽으로 돈다. 요만으로 도는 것보다 훨씬 빠르다.
  // 이 비대칭이 "롤 → 피치" 라는 비행기식 조작을 유도한다.
  const bankYaw = Math.sin(state.roll) * F.bankTurnFactor * (speed / F.maxSpeed);
  state.yaw += (input.yaw * F.yawRate * turnPenalty - bankYaw) * dt;

  const fwd = forwardVector(state.pitch, state.yaw);

  /* ---------- 양력과 실속 ---------- */
  // 속도가 minAirspeed 미만이면 양력이 부족해 떨어진다
  const liftRatio = clamp(speed / F.minAirspeed, 0, 1);
  ev.liftRatio = liftRatio;
  if (liftRatio < 1) rt.stallTime = 0.6;
  else if (rt.stallTime > 0) rt.stallTime -= dt;

  /* ---------- 속도 벡터 ---------- */
  // 중력이 기수 방향으로 하는 일: 기수를 내리면(-fwd.y) 가속한다
  let along = -fwd.y * F.gravity;

  // 기본 추진. 급강하 중에는 항력이 줄어 더 빨라진다
  along += F.thrustForward;

  const dragC = F.dragBase * (input.dive ? F.diveDragFactor : 1);
  along -= (dragC * speed * speed) / F.maxSpeed;

  const targetSpeed = clamp(
    speed + along * dt,
    0,
    input.dive ? F.maxSpeed * F.diveSpeedBonus : F.maxSpeed,
  );

  // 속도 벡터를 기수 쪽으로 끌어당긴다. 이 지연이 관성이자 드리프트다.
  const align = Math.min(1, 3.0 * dt);
  state.vx += (fwd.x * targetSpeed - state.vx) * align;
  state.vy += (fwd.y * targetSpeed - state.vy) * align;
  state.vz += (fwd.z * targetSpeed - state.vz) * align;

  // 양력 부족분만큼 가라앉는다 (실속)
  state.vy -= F.gravity * (1 - liftRatio) * dt;
  // 정상 비행이어도 활공은 서서히 침하한다.
  // 이게 없으면 수평 비행이 공짜가 되고, 상승기류도 날갯짓도 존재 이유를 잃는다.
  state.vy -= F.glideSink * dt;

  /* ---------- 상승기류 ---------- */
  const th = thermalAt(state.x, state.y, state.z, thermals);
  ev.thermalStrength = th;
  if (th > 0) state.vy += T.strength * th * dt;

  /* ---------- 날갯짓 ---------- */
  if (input.flap && rt.flapCooldown <= 0 && state.stamina >= F.flapStaminaCost) {
    state.vy += F.flapImpulse;
    state.stamina -= F.flapStaminaCost;
    rt.flapCooldown = F.flapInterval;
    ev.flapped = true;
  }

  /* ---------- 스태미나 ---------- */
  const inHighLayer = state.y >= F.highLayerY;

  // 회복은 고층이 아니고 급강하 중도 아닐 때만.
  // 고층에서도 회복이 돌면 회복량(13/s)이 소모량(4.5/s)을 덮어써서
  // "고층은 스태미나를 소모한다"(§9)가 사실상 없는 규칙이 된다.
  if (!input.dive && !inHighLayer) {
    // 활공(입력 없이 떠 있는 상태)일수록 빨리 회복한다 — 쉬는 방법이 곧 활공이다
    const gliding = !input.flap && Math.abs(input.pitch) < 0.1 ? F.staminaRegenGlideBonus : 0;
    state.stamina += (F.staminaRegen + gliding) * dt;
  }
  if (input.dive) state.stamina -= F.diveStaminaCost * dt;
  // 고층은 체류만으로 깎인다 (§9) — 최고급 알이 있는 곳은 공짜가 아니다
  if (inHighLayer) state.stamina -= F.highLayerStaminaDrain * dt;

  state.stamina = clamp(state.stamina, 0, F.staminaMax);

  /* ---------- 적분 ---------- */
  state.x += state.vx * dt;
  state.y += state.vy * dt;
  state.z += state.vz * dt;

  /* ---------- 착륙 / 추락 ---------- */
  // 평면이 아니라 실제 지형과 부딪힌다. 그래야 협곡·능선이 지형지물로 기능한다.
  const ground = terrainHeight(state.x, state.z);
  if (state.y <= ground) {
    state.y = ground;
    ev.justLanded = true;
    ev.landingSpeed = Math.abs(state.vy);
    state.grounded = true;
    state.vy = 0;
  }

  return ev;
}

/**
 * 스태미나가 0이면 강제 착륙 — 사실상 패배 (§8.2)
 * 그래서 감전·중압 계열 상태이상이 순수 피해보다 무섭다.
 */
export function isExhausted(state: FlightState): boolean {
  return state.stamina <= 0.01 && !state.grounded;
}
