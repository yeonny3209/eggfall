/**
 * EGGFALL — 진입점
 *
 * Phase 0 (비행): 마우스가 보는 방향이 곧 비행 방향, WASD 로 그 방향 기준 이동,
 *                 Space/Shift 로 상승/하강. 스태미나·실속은 없다.
 * Phase 1 (알):   §2 핵심 루프가 완결된다.
 *                 탐색 → 회수(E) → 운반(이동 −25%) → 둥지 귀환 → 흡수 → 성장 → 외형 변화
 *
 * 전투와 네트워크는 아직 없다 (Phase 2~3).
 */

import * as THREE from 'three';
import balance from './data/balance.json';
import type { Element, Stage } from './types';
import { createFlightState, stepFlight, layerOf } from './flight/simulate';
import { InputSource } from './flight/input';
import { ChaseCamera } from './flight/camera';
import { buildWorld } from './world/scene';
import { createDragon, tintFromAffinity, animateWings } from './world/dragon';
import type { DragonRig } from './world/dragon';
import { createEggField, createCarriedEggMesh } from './world/eggs';
import { createHomeNest } from './world/homeNest';
import {
  createSpawner,
  stepSpawner,
  activeEggs,
  nearestEgg,
  eggsWithin,
  takeEgg,
} from './egg/spawn';
import {
  createProgress,
  pickUp,
  drop,
  absorbCarried,
  carrySpeedMult,
  inHomeNest,
  distanceToHome,
  normalizedAffinity,
  affinityKind,
  toNextStage,
} from './player/progress';
import { mountHud } from './ui/hud';
import type { EggBearing } from './ui/hud';

const F = balance.flight;
const C = balance.carry;
const G = balance.growth;

/** 속성 한글 이름 (§3.2) */
const ELEMENT_LABEL: Record<Element, string> = {
  ember: '염화',
  rime: '빙결',
  gale: '뇌풍',
  blight: '부식',
  terra: '반석',
  umbra: '공허',
};

const AFFINITY_LABEL: Record<string, string> = {
  pure: '순혈',
  dual: '이종',
  mongrel: '잡종',
};

const stageName = (s: Stage) =>
  (balance.stage[String(s) as keyof typeof balance.stage] as { name: string }).name;
const stageDefOf = (s: Stage) =>
  balance.stage[String(s) as keyof typeof balance.stage] as {
    name: string;
    scale: number;
    turnPenalty: number;
  };

/* ---------- 렌더러 ---------- */
const canvas = document.getElementById('game') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);

/* ---------- 월드 ---------- */
const world = buildWorld();
const homeNest = createHomeNest();
world.scene.add(homeNest.group);

/* ---------- 플레이어 ---------- */
const progress = createProgress();
const state = createFlightState(0, 150, 120);
const input = new InputSource(canvas);
const chase = new ChaseCamera(innerWidth / innerHeight);
const hud = mountHud();

// 외형은 친화도와 단계에서 결정론적으로 계산한다 (§6.2).
// 둘 중 하나라도 바뀌면 리그를 다시 만든다.
let rig: DragonRig = buildRig();
let renderedStage: Stage = progress.stage;

function buildRig(): DragonRig {
  const r = createDragon(tintFromAffinity(normalizedAffinity(progress)), progress.stage);
  const def = stageDefOf(progress.stage);
  r.root.scale.setScalar(def.scale * 0.55);
  world.scene.add(r.root);
  return r;
}

/** 단계가 바뀌면 몸집·가시·색을 새로 만든다 */
function rebuildRig() {
  world.scene.remove(rig.root);
  rig = buildRig();
  renderedStage = progress.stage;
  syncCarriedMesh();
}

/* ---------- 알 ---------- */
const spawner = createSpawner(4242, Date.now());
const eggField = createEggField();
world.scene.add(eggField.group);
eggField.sync(activeEggs(spawner));

/** 앞발에 붙어 있는 알 메시 */
let carriedMesh: THREE.Mesh | null = null;

function syncCarriedMesh() {
  if (carriedMesh) {
    carriedMesh.removeFromParent();
    carriedMesh.geometry.dispose();
    (carriedMesh.material as THREE.Material).dispose();
    carriedMesh = null;
  }
  if (progress.carried) {
    carriedMesh = createCarriedEggMesh(progress.carried.rarity, progress.carried.element);
    rig.carrySlot.add(carriedMesh);
  }
}

/** 흡수 채널링 경과 시간 (초). 0이면 진행 중이 아니다. */
let absorbTimer = 0;

let elapsed = 0;
// 스포너는 초당 한 번만 돌린다. 리스폰이 분 단위라 매 프레임 볼 이유가 없다.
let spawnAcc = 0;

// 개발 중 콘솔에서 상태를 들여다보기 위한 핸들. 프로덕션 빌드에서는 붙지 않는다.
if (import.meta.env.DEV) {
  (globalThis as Record<string, unknown>).__eggfall = {
    state, chase, world, input, spawner, eggField, progress,
    get rig() { return rig; },
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
  const stageDef = stageDefOf(progress.stage);

  // 운반 중이면 느려진다 (§2 게임의 중심축)
  stepFlight(
    state, cmd, input.lookYaw, input.lookPitch, dt,
    stageDef.turnPenalty,
    carrySpeedMult(progress),
  );

  /* ---------- 상호작용 (E) ---------- */
  const pickTarget = findPickupTarget();
  if (cmd.interact) {
    if (progress.carried) {
      // 내려놓기 — 흡수를 취소하고 알을 버린다.
      // 주운 둥지로 되돌리지는 않는다(이미 리스폰 타이머가 도는 중이라 자리가 있다).
      drop(progress);
      syncCarriedMesh();
      absorbTimer = 0;
      hud.flash('알을 내려놓았습니다', '#ffb27a');
    } else if (pickTarget) {
      const taken = takeEgg(spawner, pickTarget.nestId, Date.now());
      if (taken && pickUp(progress, taken.egg)) {
        eggField.sync(activeEggs(spawner));
        syncCarriedMesh();
        hud.flash('알 회수 — 둥지로 돌아가세요', '#7ce0ff');
      }
    }
  }

  /* ---------- 흡수 (둥지 귀환) ---------- */
  if (progress.carried && inHomeNest(state.x, state.z)) {
    absorbTimer += dt;
    if (absorbTimer >= G.absorbSeconds) {
      const result = absorbCarried(progress);
      absorbTimer = 0;
      syncCarriedMesh();
      if (result) {
        if (result.leveledUp) {
          hud.flash(`성장! ${stageName(result.toStage)}`, '#c98bff');
        } else {
          hud.flash(`흡수 +${result.gained}`, '#7ce0ff');
        }
        // 친화도가 바뀌었으니 색을 즉시 반영한다 (§6.2)
        rig.setTint(tintFromAffinity(normalizedAffinity(progress)));
      }
    }
  } else {
    absorbTimer = 0;
  }

  // 단계가 올랐으면 몸집·가시를 새로 만든다
  if (progress.stage !== renderedStage) rebuildRig();

  const speed = Math.hypot(state.vx, state.vy, state.vz);
  const speedRatio = Math.min(1, speed / F.moveSpeed);

  /* ---------- 드래곤 자세 ---------- */
  rig.root.position.set(state.x, state.y, state.z);
  rig.root.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
  animateWings(rig, elapsed, cmd.ascend ? 1 : 0.3, speedRatio);
  if (carriedMesh) carriedMesh.rotation.y = elapsed * 0.9;

  world.shadow.update(state.x, state.y, state.z, state.yaw, 9 * stageDef.scale * 0.55);

  chase.update(state, dt);
  world.update(elapsed, dt, state.x, state.y, state.z);
  homeNest.update(elapsed, progress.carried !== null);

  /* ---------- 알 ---------- */
  spawnAcc += dt;
  if (spawnAcc >= 1) {
    spawnAcc = 0;
    if (stepSpawner(spawner, Date.now()).length > 0) {
      eggField.sync(activeEggs(spawner));
    }
  }
  eggField.update(elapsed);

  /* ---------- HUD ---------- */
  const norm = normalizedAffinity(progress);
  const affinityTop = (Object.keys(norm) as Element[])
    .filter((e) => norm[e] > 0.01)
    .sort((a, b) => norm[b] - norm[a])
    .slice(0, 3)
    .map((e) => ({ element: ELEMENT_LABEL[e], ratio: norm[e] }));

  hud.update({
    speed,
    altitude: state.y,
    layer: layerOf(state.y),
    grounded: state.grounded,
    stageName: stageDef.name,
    speedRatio,
    eggsNearby: eggsWithin(spawner, state.x, state.z).length,
    nearestEgg: bearingToNearestEgg(),

    stage: progress.stage,
    geneMass: progress.geneMass,
    nextStage: toNextStage(progress.geneMass),
    affinityKind: AFFINITY_LABEL[affinityKind(progress)],
    affinityTop,

    carrying: progress.carried
      ? {
          rarity: progress.carried.rarity,
          element: ELEMENT_LABEL[progress.carried.element],
          geneMass: progress.carried.geneMass,
        }
      : null,
    pickupTarget: pickTarget
      ? { rarity: pickTarget.rarity, element: ELEMENT_LABEL[pickTarget.element] }
      : null,
    inHome: inHomeNest(state.x, state.z),
    absorbProgress: absorbTimer > 0 ? Math.min(1, absorbTimer / G.absorbSeconds) : 0,
    homeDistance: distanceToHome(state.x, state.z),
  });
}

/** 지금 E 로 주울 수 있는 알. 사거리 안에서 가장 가까운 것. */
function findPickupTarget() {
  if (progress.carried) return null;
  for (const s of spawner.slots) {
    if (!s.egg) continue;
    const d = Math.hypot(s.egg.x - state.x, s.egg.y - state.y, s.egg.z - state.z);
    if (d <= C.pickupRange) {
      return { nestId: s.nest.id, rarity: s.egg.egg.rarity, element: s.egg.egg.element };
    }
  }
  return null;
}

/** 가장 가까운 알을 플레이어 기수 기준 상대 방위로 바꾼다 */
function bearingToNearestEgg(): EggBearing | null {
  const found = nearestEgg(spawner, state.x, state.z);
  if (!found) return null;
  const { egg: se, dist } = found;
  // atan2(x, z) 인 이유는 yaw=0 일 때 정면이 +z 이기 때문이다.
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

function render() {
  renderer.render(world.scene, chase.camera);
}

function frame() {
  render();
  requestAnimationFrame(frame);
}

setInterval(simulate, 16);
requestAnimationFrame(frame);
