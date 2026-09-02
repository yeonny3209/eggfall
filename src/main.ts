/**
 * EGGFALL — Phase 0 진입점
 *
 * 기획서 §11 Phase 0: "비행 컨트롤러만. 카메라·상승기류·스태미나·급강하."
 * §13.1: "한 세션 = 한 시스템." 그래서 여기에는 알도, 전투도, 네트워크도 없다.
 */

import * as THREE from 'three';
import balance from './data/balance.json';
import type { Element, Stage } from './types';
import {
  createFlightState,
  createRuntime,
  generateThermals,
  stepFlight,
  layerOf,
  isExhausted,
  thermalAt,
} from './flight/simulate';
import { InputSource } from './flight/input';
import { ChaseCamera } from './flight/camera';
import { buildWorld } from './world/scene';
import { createDragon, tintFromAffinity, animateWings } from './world/dragon';
import { mountHud } from './ui/hud';
import type { RadarBlip } from './ui/hud';

const F = balance.flight;

/* ---------- 렌더러 ---------- */
const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

/* ---------- 월드 ---------- */
const thermals = generateThermals();
const world = buildWorld(thermals);

/* ---------- 플레이어 ---------- */
// Phase 0 이므로 친화도는 고정값. Phase 1 에서 알 흡수 결과로 대체된다.
const affinity: Partial<Record<Element, number>> = { ember: 0.55, umbra: 0.45 };
const stage: Stage = 3;
const stageDef = balance.stage[String(stage) as keyof typeof balance.stage] as {
  name: string;
  scale: number;
  turnPenalty: number;
};

const rig = createDragon(tintFromAffinity(affinity));
rig.root.scale.setScalar(stageDef.scale * 0.55);
world.scene.add(rig.root);

const state = createFlightState(0, 150, 0);
const rt = createRuntime();
const input = new InputSource(canvas);
const chase = new ChaseCamera(innerWidth / innerHeight);
const hud = mountHud();

let flapPhase = 0;
let exhaustedNotified = false;

// 개발 중 콘솔에서 상태를 들여다보기 위한 핸들. 프로덕션 빌드에서는 붙지 않는다.
if (import.meta.env.DEV) {
  (globalThis as Record<string, unknown>).__eggfall = {
    state, rt, rig, chase, world, thermals,
    // 창이 가려져 rAF 가 멈춘 상태에서도 검증할 수 있도록 수동 펌프를 열어둔다
    pump: (seconds: number) => {
      const n = Math.round(seconds / (1 / 60));
      for (let i = 0; i < n; i++) stepOnce(1 / 60);
      render();
    },
    render,
    pause: () => { paused = true; },
    resume: () => { paused = false; lastSim = performance.now(); },
  };
}

/* ---------- 리사이즈 ---------- */
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  chase.resize(innerWidth / innerHeight);
});

/* ---------- 포인터 락 ---------- */
canvas.addEventListener('click', () => input.requestPointerLock());

/* ==========================================================================
   루프 — 시뮬레이션과 렌더링을 분리한다
   시뮬레이션은 고정 timestep, 렌더링은 rAF.
   섞어두면 프레임률에 따라 물리 결과가 달라지고, Phase 2 에서 서버와 대조가 불가능해진다.
   ========================================================================== */
const FIXED_DT = 1 / 60;
let acc = 0;
let lastSim = performance.now();
let elapsed = 0;

let paused = false;

function simulate() {
  if (paused) {
    lastSim = performance.now();
    return;
  }
  const now = performance.now();
  let el = (now - lastSim) / 1000;
  lastSim = now;
  // 탭 복귀·브레이크포인트 후 거대한 dt 로 물리가 폭발하지 않도록 상한을 둔다
  if (el > 0.25) el = 0.25;
  acc += el;

  let guard = 0;
  while (acc >= FIXED_DT && guard < 30) {
    stepOnce(FIXED_DT);
    acc -= FIXED_DT;
    guard++;
  }
  if (guard >= 30) acc = 0;
}

function stepOnce(dt: number) {
  elapsed += dt;

  const cmd = input.read();

  // 스태미나가 0이면 날갯짓·급강하가 먹지 않는다 — 강제 착륙으로 이어진다 (§8.2)
  if (state.stamina <= 0) {
    cmd.flap = false;
    cmd.dive = false;
  }

  const ev = stepFlight(state, rt, cmd, dt, thermals, stageDef.turnPenalty);

  // 착륙 처리
  if (ev.justLanded && ev.landingSpeed > F.crashDamageSpeed) {
    hud.flash('추락', '#ff5c6c');
  }
  if (isExhausted(state)) {
    if (!exhaustedNotified) {
      hud.flash('스태미나 고갈 — 강제 하강', '#ffc93c');
      exhaustedNotified = true;
    }
  } else if (state.stamina > 20) {
    exhaustedNotified = false;
  }

  // 날갯짓 애니메이션 위상
  if (ev.flapped) flapPhase = 1;
  if (flapPhase > 0) flapPhase = Math.max(0, flapPhase - dt / F.flapInterval);

  const speed = Math.hypot(state.vx, state.vy, state.vz);

  /* ---------- 드래곤 자세 반영 ---------- */
  rig.root.position.set(state.x, state.y, state.z);
  // YXZ 순서: 요 → 피치 → 롤. 비행체 자세의 표준 순서다.
  rig.root.rotation.set(state.pitch, state.yaw, state.roll, 'YXZ');
  animateWings(rig, elapsed, 1 - flapPhase, Math.min(1, speed / F.maxSpeed));

  // 지면 그림자 — 3인칭 비행에서 고도를 아는 가장 확실한 단서
  world.shadow.update(state.x, state.y, state.z, state.yaw, 9 * stageDef.scale * 0.55);

  chase.update(state, dt, input.lookYaw, input.lookPitch, cmd.dive);
  world.update(elapsed, dt, state.x, state.y, state.z);

  hud.update({
    speed,
    altitude: state.y,
    stamina: state.stamina,
    staminaMax: F.staminaMax,
    layer: layerOf(state.y),
    thermal: ev.thermalStrength,
    stalling: ev.liftRatio < 1,
    grounded: state.grounded,
    diving: cmd.dive,
    stageName: stageDef.name,
    speedRatio: Math.min(1, speed / F.maxSpeed),
    yaw: state.yaw,
    blips: radarBlips(),
  });
}

/** 레이더에 찍을 상승기류 목록. 매 프레임 도는 배열이 12개뿐이라 캐시하지 않는다. */
function radarBlips(): RadarBlip[] {
  const out: RadarBlip[] = [];
  for (const th of thermals) {
    out.push({
      dx: th.x - state.x,
      dz: th.z - state.z,
      inside: thermalAt(state.x, state.y, state.z, [th]) > 0.02,
    });
  }
  return out;
}

function render() {
  renderer.render(world.scene, chase.camera);
}

function frame() {
  render();
  requestAnimationFrame(frame);
}

// 시뮬레이션은 rAF 와 무관하게 돈다. 창이 가려져도 물리는 멈추지 않는다.
setInterval(simulate, 16);
requestAnimationFrame(frame);
