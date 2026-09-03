/**
 * EGGFALL — 진입점
 *
 * Phase 0 (비행): 마우스가 보는 방향이 곧 비행 방향, WASD 이동, Space/Shift 상승·하강.
 * Phase 1 (알):   탐색 → 회수(E) → 운반(−25%) → 둥지 귀환 → 흡수 → 성장 → 외형 변화 (§2)
 * Phase 2 (넷):   Colyseus 권위 서버 + 클라이언트 예측/보정 + 원격 보간.
 *
 * **서버가 없어도 게임은 그대로 돌아간다.** 접속에 실패하면 조용히 싱글플레이가 된다.
 * GitHub Pages 는 정적 호스팅이라 서버를 띄울 수 없기 때문이다.
 */

import * as THREE from 'three';
import balance from './data/balance.json';
import type { Element, Rarity, Stage } from './types';
import { createFlightState, stepFlight, layerOf } from './flight/simulate';
import { InputSource } from './flight/input';
import { ChaseCamera } from './flight/camera';
import { buildWorld } from './world/scene';
import { createDragon, tintFromAffinity, animateWings } from './world/dragon';
import type { DragonRig } from './world/dragon';
import { createEggField, createCarriedEggMesh } from './world/eggs';
import { createHomeNest } from './world/homeNest';
import { createRemoteField } from './world/remotes';
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
  stageForGeneMass,
} from './player/progress';
import { NetClient, resolveServerUrl } from './net/client';
import type { NetStatus } from './net/client';
import { createPrediction, recordInput, nextSeq, reconcile, decayError } from './net/prediction';
import { toCommand } from './net/protocol';
import { mountHud } from './ui/hud';
import type { EggBearing } from './ui/hud';

const F = balance.flight;
const C = balance.carry;
const G = balance.growth;
const E = balance.eggs;

const ELEMENT_LABEL: Record<Element, string> = {
  ember: '염화', rime: '빙결', gale: '뇌풍',
  blight: '부식', terra: '반석', umbra: '공허',
};
const AFFINITY_LABEL: Record<string, string> = { pure: '순혈', dual: '이종', mongrel: '잡종' };

const stageName = (s: Stage) =>
  (balance.stage[String(s) as keyof typeof balance.stage] as { name: string }).name;
const stageDefOf = (s: Stage) =>
  balance.stage[String(s) as keyof typeof balance.stage] as {
    name: string; scale: number; turnPenalty: number;
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

const eggField = createEggField();
world.scene.add(eggField.group);

const remoteField = createRemoteField();
world.scene.add(remoteField.group);

/* ---------- 플레이어 ---------- */
const progress = createProgress();
const state = createFlightState(balance.homeNest.x, 150, balance.homeNest.z + 120);
const input = new InputSource(canvas);
const chase = new ChaseCamera(innerWidth / innerHeight);
const hud = mountHud();

let rig: DragonRig = buildRig();
let renderedStage: Stage = progress.stage;
let carriedMesh: THREE.Mesh | null = null;

function buildRig(): DragonRig {
  const r = createDragon(tintFromAffinity(normalizedAffinity(progress)), progress.stage);
  r.root.scale.setScalar(stageDefOf(progress.stage).scale * 0.55);
  world.scene.add(r.root);
  return r;
}

function rebuildRig() {
  world.scene.remove(rig.root);
  rig = buildRig();
  renderedStage = progress.stage;
  syncCarriedMesh();
}

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

/* ---------- 오프라인 스포너 ---------- */
// 온라인이면 서버가 알을 관리하므로 이건 쓰이지 않는다.
const spawner = createSpawner(4242, Date.now());
eggField.sync(activeEggs(spawner));

/* ---------- 네트워크 ---------- */
const pred = createPrediction();
let lastAckedSeq = 0;

const net = new NetClient({
  onStatusChange: (s: NetStatus) => {
    if (s === 'online') hud.flash('멀티플레이 접속', '#7ce0ff');
    // 오프라인은 정상 상태다. 실패했다고 시끄럽게 알리지 않는다.
    if (s === 'offline' && net.sessionId) hud.flash('서버와 연결이 끊겼습니다', '#ffc93c');
  },
  onAbsorbed: (e) => {
    if (e.leveledUp) hud.flash(`성장! ${stageName(e.toStage)}`, '#c98bff');
    else hud.flash(`흡수 +${e.gained}`, '#7ce0ff');
  },
  onPickupDenied: (e) => {
    const msg = e.reason === 'taken' ? '누군가 먼저 가져갔습니다'
      : e.reason === 'range' ? '너무 멉니다'
      : '이미 알을 들고 있습니다';
    hud.flash(msg, '#ffc93c');
  },
});

// 접속은 비동기로. 실패해도 게임은 이미 돌아가고 있다.
void net.connect(resolveServerUrl(), localStorage.getItem('eggfall:name') ?? '');

let absorbTimer = 0;
let elapsed = 0;
let spawnAcc = 0;

if (import.meta.env.DEV) {
  (globalThis as Record<string, unknown>).__eggfall = {
    state, chase, world, input, spawner, eggField, progress, net, pred,
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

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  chase.resize(innerWidth / innerHeight);
});
canvas.addEventListener('click', () => input.requestPointerLock());

/* ==========================================================================
   루프
   ========================================================================== */
const FIXED_DT = 1 / 60;
let acc = 0;
let lastSim = performance.now();
let paused = false;

function simulate() {
  if (paused) { lastSim = performance.now(); return; }
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
  const speedMult = carrySpeedMult(progress);

  /* ---------- 비행: 예측 후 보정 ---------- */
  if (net.online) {
    // 1. 입력을 기록하고 서버로 보낸다
    const c = toCommand(nextSeq(pred), dt, cmd, input.lookYaw, input.lookPitch);
    recordInput(pred, c);
    net.sendInput(c);

    // 2. 서버 응답을 기다리지 않고 즉시 로컬에 적용한다 (예측)
    stepFlight(state, cmd, input.lookYaw, input.lookPitch, dt, stageDef.turnPenalty, speedMult);

    // 3. 서버가 새 입력을 처리했으면 그 시점으로 되감고 미처리분만 재생한다 (보정)
    const sv = net.myServerState();
    if (sv && sv.lastSeq > lastAckedSeq) {
      lastAckedSeq = sv.lastSeq;
      reconcile(state, pred, sv, stageDef.turnPenalty, speedMult);
    }
    decayError(pred, dt);
  } else {
    stepFlight(state, cmd, input.lookYaw, input.lookPitch, dt, stageDef.turnPenalty, speedMult);
  }

  /* ---------- 상호작용 ---------- */
  const pickTarget = findPickupTarget();
  if (cmd.interact) {
    if (net.online) {
      // 온라인에서는 낙관적으로 줍지 않는다. 남이 먼저 가져갔을 수 있고,
      // 그때 손에 들렸다 사라지는 게 아무것도 안 일어나는 것보다 나쁘다.
      if (progress.carried) net.sendDrop();
      else if (pickTarget) net.sendPickup(pickTarget.nestId);
    } else {
      if (progress.carried) {
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
  }

  /* ---------- 흡수 ---------- */
  if (net.online) {
    // 서버가 판정한다. 여기서는 진행 바만 로컬로 굴려 즉각적인 피드백을 준다.
    absorbTimer = progress.carried && inHomeNest(state.x, state.z)
      ? Math.min(G.absorbSeconds, absorbTimer + dt)
      : 0;
  } else if (progress.carried && inHomeNest(state.x, state.z)) {
    absorbTimer += dt;
    if (absorbTimer >= G.absorbSeconds) {
      const result = absorbCarried(progress);
      absorbTimer = 0;
      syncCarriedMesh();
      if (result) {
        hud.flash(
          result.leveledUp ? `성장! ${stageName(result.toStage)}` : `흡수 +${result.gained}`,
          result.leveledUp ? '#c98bff' : '#7ce0ff',
        );
        rig.setTint(tintFromAffinity(normalizedAffinity(progress)));
      }
    }
  } else {
    absorbTimer = 0;
  }

  /* ---------- 서버 상태를 로컬에 반영 ---------- */
  if (net.online) mirrorServerProgress();

  if (progress.stage !== renderedStage) rebuildRig();

  const speed = Math.hypot(state.vx, state.vy, state.vz);
  const speedRatio = Math.min(1, speed / F.moveSpeed);

  /* ---------- 렌더 상태 ---------- */
  // 보정 오차를 더해 화면에서는 부드럽게 이동한다
  rig.root.position.set(state.x + pred.errX, state.y + pred.errY, state.z + pred.errZ);
  rig.root.rotation.set(state.pitch, state.yaw, 0, 'YXZ');
  animateWings(rig, elapsed, cmd.ascend ? 1 : 0.3, speedRatio);
  if (carriedMesh) carriedMesh.rotation.y = elapsed * 0.9;

  world.shadow.update(state.x, state.y, state.z, state.yaw, 9 * stageDef.scale * 0.55);
  chase.update(state, dt);
  world.update(elapsed, dt, state.x, state.y, state.z);
  homeNest.update(elapsed, progress.carried !== null);

  /* ---------- 알 ---------- */
  if (net.online) {
    syncServerEggs();
  } else {
    spawnAcc += dt;
    if (spawnAcc >= 1) {
      spawnAcc = 0;
      if (stepSpawner(spawner, Date.now()).length > 0) eggField.sync(activeEggs(spawner));
    }
  }
  eggField.update(elapsed);

  /* ---------- 원격 플레이어 ---------- */
  net.update(dt);
  remoteField.sync(net.remotes, elapsed);

  updateHud(speed, speedRatio, stageDef.name, pickTarget);
}

/* ==========================================================================
   서버 ↔ 로컬 반영
   ========================================================================== */

/** 서버가 권위를 갖는 성장·운반 상태를 로컬 progress 에 옮긴다 (HUD·외형용) */
function mirrorServerProgress() {
  const p = net.room?.state.players.get(net.sessionId);
  if (!p) return;

  if (progress.geneMass !== p.geneMass) {
    progress.geneMass = p.geneMass;
    progress.stage = stageForGeneMass(p.geneMass);
    // 친화도는 서버가 대표 속성만 보낸다. 색 재현에는 그걸로 충분하다 (§6.2).
    if (p.tintElement) {
      for (const k of Object.keys(progress.elementAffinity) as Element[]) {
        progress.elementAffinity[k] = 0;
      }
      progress.elementAffinity[p.tintElement as Element] = p.tintRatio;
      const rest = (1 - p.tintRatio) / 5;
      for (const k of Object.keys(progress.elementAffinity) as Element[]) {
        if (k !== p.tintElement) progress.elementAffinity[k] = rest;
      }
      rig.setTint(tintFromAffinity(normalizedAffinity(progress)));
    }
  }

  // 운반 상태
  const hasCarry = !!p.carriedRarity;
  const localHas = !!progress.carried;
  const changed = hasCarry !== localHas
    || (hasCarry && progress.carried?.rarity !== p.carriedRarity);

  if (changed) {
    progress.carried = hasCarry
      ? {
          id: 'server',
          rarity: p.carriedRarity as Rarity,
          element: p.carriedElement as Element,
          // 유전 질량은 등급이 결정하므로 서버가 따로 보낼 필요가 없다
          geneMass: (E.geneMass as Record<string, number>)[p.carriedRarity] ?? 0,
          traits: [],
          decayAt: 0,
        }
      : null;
    syncCarriedMesh();
    if (hasCarry) hud.flash('알 회수 — 둥지로 돌아가세요', '#7ce0ff');
  }
}

/** 서버가 보낸 알 목록을 렌더러가 아는 형태로 바꿔 넘긴다 */
let lastEggKey = '';
function syncServerEggs() {
  // 매 프레임 배열을 새로 만들면 낭비다. 구성이 바뀌었을 때만 갱신한다.
  const key = `${net.eggs.size}:${Array.from(net.eggs.keys()).join(',')}`;
  if (key === lastEggKey) return;
  lastEggKey = key;

  const list = Array.from(net.eggs.values()).map((e) => ({
    nestId: e.nestId,
    x: e.x,
    y: e.y,
    z: e.z,
    egg: {
      id: e.nestId,
      rarity: e.rarity as Rarity,
      element: e.element as Element,
      geneMass: e.geneMass,
      traits: [],
      decayAt: 0,
    },
  }));
  eggField.sync(list);
}

/* ==========================================================================
   HUD
   ========================================================================== */

function updateHud(
  speed: number,
  speedRatio: number,
  stageLabel: string,
  pickTarget: { rarity: Rarity; element: Element } | null,
) {
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
    stageName: stageLabel,
    speedRatio,
    eggsNearby: countEggsNearby(),
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

    netStatus: net.status,
    playerCount: net.playerCount,
  });
}

/* ==========================================================================
   알 조회 — 온라인/오프라인 두 소스를 하나로 감싼다
   ========================================================================== */

type EggLike = { nestId: string; x: number; y: number; z: number; rarity: Rarity; element: Element };

function allEggs(): EggLike[] {
  if (net.online) {
    return Array.from(net.eggs.values()).map((e) => ({
      nestId: e.nestId, x: e.x, y: e.y, z: e.z,
      rarity: e.rarity as Rarity, element: e.element as Element,
    }));
  }
  return activeEggs(spawner).map((s) => ({
    nestId: s.nestId, x: s.x, y: s.y, z: s.z,
    rarity: s.egg.rarity, element: s.egg.element,
  }));
}

function countEggsNearby(): number {
  if (!net.online) return eggsWithin(spawner, state.x, state.z).length;
  let n = 0;
  for (const e of net.eggs.values()) {
    if (Math.hypot(e.x - state.x, e.z - state.z) <= E.radarRange) n++;
  }
  return n;
}

function findPickupTarget() {
  if (progress.carried) return null;
  for (const e of allEggs()) {
    const d = Math.hypot(e.x - state.x, e.y - state.y, e.z - state.z);
    if (d <= C.pickupRange) return { nestId: e.nestId, rarity: e.rarity, element: e.element };
  }
  return null;
}

function bearingToNearestEgg(): EggBearing | null {
  let best: EggLike | null = null;
  let bestD = Infinity;

  if (net.online) {
    for (const e of allEggs()) {
      const d = Math.hypot(e.x - state.x, e.z - state.z);
      if (d < bestD) { bestD = d; best = e; }
    }
  } else {
    const found = nearestEgg(spawner, state.x, state.z);
    if (found) {
      bestD = found.dist;
      best = {
        nestId: found.egg.nestId, x: found.egg.x, y: found.egg.y, z: found.egg.z,
        rarity: found.egg.egg.rarity, element: found.egg.egg.element,
      };
    }
  }
  if (!best) return null;

  const worldBearing = Math.atan2(best.x - state.x, best.z - state.z);
  let rel = worldBearing - state.yaw;
  rel = ((rel + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  return {
    rarity: best.rarity,
    element: ELEMENT_LABEL[best.element],
    dist: bestD,
    bearing: -rel,
    dy: best.y - state.y,
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
