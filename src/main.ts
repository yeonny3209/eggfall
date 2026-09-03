/**
 * EGGFALL — 진입점
 *
 * Phase 0 (비행): 마우스가 보는 방향이 곧 비행 방향, WASD 로 그 방향 기준 이동,
 *                 Space/Shift 로 상승/하강. 스태미나·실속은 없다.
 * Phase 1 (알):   자연 둥지에서 알이 스폰되고, 주우면 리스폰 타이머가 돈다 (§7.1).
 *
 * §13.1 "한 세션 = 한 시스템" 에 따라 아직 운반·흡수·성장은 없다.
 * 전투와 네트워크도 없다.
 */

import * as THREE from 'three';
import balance from './data/balance.json';
import type { Element, Stage } from './types';
import { createFlightState, stepFlight, layerOf } from './flight/simulate';
import { InputSource } from './flight/input';
import { ChaseCamera } from './flight/camera';
import { buildWorld } from './world/scene';
import { createDragon, tintFromAffinity, animateWings } from './world/dragon';
import { createEggField } from './world/eggs';
import { createSpawner, stepSpawner, activeEggs, nearestEgg, eggsWithin } from './egg/spawn';
import { mountHud } from './ui/hud';
import type { EggBearing } from './ui/hud';

const F = balance.flight;

/* ---------- 렌더러 ---------- */
const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

/* ---------- 월드 ---------- */
const world = buildWorld();

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
const input = new InputSource(canvas);
const chase = new ChaseCamera(innerWidth / innerHeight);
const hud = mountHud();

/* ---------- 알 (Phase 1) ---------- */
const spawner = createSpawner(4242, Date.now());
const eggField = createEggField();
world.scene.add(eggField.group);
eggField.sync(activeEggs(spawner));

let elapsed = 0;
// 스포너는 초당 한 번만 돌린다. 리스폰이 분 단위라 매 프레임 볼 이유가 없다.
let spawnAcc = 0;

// 개발 중 콘솔에서 상태를 들여다보기 위한 핸들. 프로덕션 빌드에서는 붙지 않는다.
if (import.meta.env.DEV) {
  (globalThis as Record<string, unknown>).__eggfall = {
    state, rig, chase, world, input, spawner, eggField,
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
  stepFlight(state, cmd, input.lookYaw, input.lookPitch, dt, stageDef.turnPenalty);

  const speed = Math.hypot(state.vx, state.vy, state.vz);
  const speedRatio = Math.min(1, speed / F.moveSpeed);

  /* ---------- 드래곤 자세 반영 ---------- */
  rig.root.position.set(state.x, state.y, state.z);
  rig.root.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
  // Space 를 누르는 동안 힘차게, 그 외엔 순항 리듬으로 퍼덕인다
  const flapVigor = cmd.ascend ? 1 : 0.3;
  animateWings(rig, elapsed, flapVigor, speedRatio);

  // 지면 그림자 — 3인칭 비행에서 고도를 아는 가장 확실한 단서
  world.shadow.update(state.x, state.y, state.z, state.yaw, 9 * stageDef.scale * 0.55);

  chase.update(state, dt);
  world.update(elapsed, dt, state.x, state.y, state.z);

  /* ---------- 알 ---------- */
  spawnAcc += dt;
  if (spawnAcc >= 1) {
    spawnAcc = 0;
    if (stepSpawner(spawner, Date.now()).length > 0) {
      eggField.sync(activeEggs(spawner));
    }
  }
  eggField.update(elapsed);

  hud.update({
    speed,
    altitude: state.y,
    layer: layerOf(state.y),
    grounded: state.grounded,
    stageName: stageDef.name,
    speedRatio,
    eggsNearby: eggsWithin(spawner, state.x, state.z).length,
    nearestEgg: bearingToNearestEgg(),
  });
}

/** 가장 가까운 알을 플레이어 기수 기준 상대 방위로 바꾼다 */
function bearingToNearestEgg(): EggBearing | null {
  const found = nearestEgg(spawner, state.x, state.z);
  if (!found) return null;
  const { egg: se, dist } = found;
  // 월드 방위 → 기수 기준 상대 방위. atan2(x, z) 인 이유는 yaw=0 일 때 정면이 +z 이기 때문이다.
  const worldBearing = Math.atan2(se.x - state.x, se.z - state.z);
  let rel = worldBearing - state.yaw;
  rel = ((rel + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return {
    rarity: se.egg.rarity,
    element: ELEMENT_LABEL[se.egg.element],
    dist,
    // CSS rotate 는 시계방향이 +, 방위각은 반시계가 + 라 부호를 뒤집는다
    bearing: -rel,
    dy: se.y - state.y,
  };
}

/** 속성 한글 이름 (§3.2) */
const ELEMENT_LABEL: Record<Element, string> = {
  ember: '염화',
  rime: '빙결',
  gale: '뇌풍',
  blight: '부식',
  terra: '반석',
  umbra: '공허',
};

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
