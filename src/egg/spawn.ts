/**
 * 알 스폰 — Phase 1 첫 번째 시스템 (기획서 §7.1 자연 둥지)
 *
 * 규칙
 *   - 둥지는 고정 위치다. 시드에서 결정론적으로 만들어지므로 저장할 필요가 없다.
 *   - 한 둥지에는 알이 최대 하나. 누가 가져가면 5~15분 뒤 새 알이 놓인다.
 *   - 등급은 가중 랜덤. 신성은 자연 둥지에서 나오지 않는다 (§5.1 — 시즌당 12회 각성 전용).
 *
 * 이 모듈은 Three.js 를 import 하지 않는다. 순수 함수만 둔다 (§13.3).
 * 알 스폰은 결국 서버 권위 판정이 되어야 하므로, 지금부터 렌더링과 섞지 않는다.
 */

import type {
  DragonEgg,
  Element,
  Nest,
  NestSlot,
  Rarity,
  SpawnedEgg,
  SpawnerState,
  Trait,
  CoreId,
  ModifierId,
} from '../types';
import { ELEMENTS } from '../types';
import balance from '../data/balance.json';
import { terrainHeight } from '../world/terrain';

const E = balance.eggs;

/** 자연 둥지에서 나올 수 있는 등급 (신성 제외) */
const NATURAL_RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'epic', 'divine'];

const RARITY_ORDER: Record<Rarity, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  epic: 3,
  divine: 4,
};

/** 등급 비교용 — beaconMinRarity 같은 임계값 판정에 쓴다 */
export function rarityAtLeast(r: Rarity, min: Rarity): boolean {
  return RARITY_ORDER[r] >= RARITY_ORDER[min];
}

/* ==========================================================================
   결정론적 난수
   ========================================================================== */

/**
 * xorshift32. Math.random 을 쓰지 않는 이유:
 * 서버와 클라이언트가 같은 시드로 같은 월드를 봐야 하고,
 * 테스트가 재현 가능해야 하기 때문이다.
 * 상태를 숫자 하나로 들고 다니므로 SpawnerState 에 그대로 직렬화된다.
 */
export function nextRandom(state: number): { value: number; state: number } {
  let s = state >>> 0;
  // 0 은 xorshift 의 고정점이라 영원히 0만 나온다. 반드시 피해야 한다.
  if (s === 0) s = 0x9e3779b9;
  s ^= s << 13; s >>>= 0;
  s ^= s >> 17;
  s ^= s << 5;  s >>>= 0;
  return { value: s / 4294967296, state: s };
}

/** 여러 번 뽑아야 할 때 쓰는 소형 헬퍼. 마지막 상태를 돌려준다. */
function rngCursor(seed: number) {
  let s = seed >>> 0;
  return {
    next(): number {
      const r = nextRandom(s);
      s = r.state;
      return r.value;
    },
    get state() {
      return s;
    },
  };
}

/* ==========================================================================
   둥지 배치
   ========================================================================== */

/**
 * 둥지 위치를 결정론적으로 만든다.
 * sqrt 를 쓰는 이유: 그냥 곱하면 중심부에 몰린다. 면적당 균일하게 퍼뜨린다.
 */
export function generateNests(seed = 4242, count = E.nestCount): Nest[] {
  const rng = rngCursor(seed);
  const out: Nest[] = [];
  const span = E.nestMaxRadius - E.nestMinRadius;
  for (let i = 0; i < count; i++) {
    const a = rng.next() * Math.PI * 2;
    const r = E.nestMinRadius + Math.sqrt(rng.next()) * span;
    out.push({ id: `nest-${i}`, x: Math.cos(a) * r, z: Math.sin(a) * r });
  }
  return out;
}

/* ==========================================================================
   알 생성
   ========================================================================== */

/** 가중 랜덤으로 등급을 뽑는다 */
export function rollRarity(roll: number): Rarity {
  const weights = E.rarityWeights as Record<Rarity, number>;
  let total = 0;
  for (const r of NATURAL_RARITIES) total += weights[r];
  let acc = roll * total;
  for (const r of NATURAL_RARITIES) {
    acc -= weights[r];
    if (acc <= 0) return r;
  }
  return 'common';
}

const CORES: CoreId[] = [
  'breath', 'bolt', 'field', 'charge', 'smash', 'summon',
  'aura', 'bind', 'warp', 'reflect', 'drain', 'burst',
];
const MODIFIERS: ModifierId[] = [
  'penetrate', 'split', 'chain', 'lifesteal', 'slow', 'stackUp', 'frenzy',
  'coolant', 'expand', 'compress', 'delay', 'instant', 'statusUp', 'noRecoil',
  'updraft', 'cloak', 'doubleCast', 'reignite', 'rampage', 'precision',
];

/**
 * 알 하나를 만든다.
 * traits 는 흡수 시 발현 풀에 들어가 스킬 조합의 재료가 된다 (§4.4).
 * 알의 주 속성이 traits 대부분을 차지하되 일부는 다른 속성이 섞여
 * "이 알을 먹으면 내 친화도가 어느 쪽으로 기우는가"에 변주를 준다.
 */
export function makeEgg(
  idNum: number,
  rarity: Rarity,
  element: Element,
  now: number,
  rng: { next(): number },
): DragonEgg {
  const traitCount = (E.traitCount as Record<Rarity, number>)[rarity];
  const traits: Trait[] = [];
  for (let i = 0; i < traitCount; i++) {
    // 70% 는 알의 주 속성, 30% 는 무작위 — 순혈 육성이 마냥 쉽지만은 않게 한다
    const el = rng.next() < 0.7 ? element : ELEMENTS[Math.floor(rng.next() * ELEMENTS.length)];
    const trait: Trait = { element: el, weight: 1 };
    // 특성 절반쯤은 코어를, 나머지는 변조를 밀어준다
    if (rng.next() < 0.5) trait.core = CORES[Math.floor(rng.next() * CORES.length)];
    else trait.modifier = MODIFIERS[Math.floor(rng.next() * MODIFIERS.length)];
    traits.push(trait);
  }

  return {
    id: `egg-${idNum}`,
    rarity,
    element,
    geneMass: (E.geneMass as Record<Rarity, number>)[rarity],
    traits,
    decayAt: now + E.decaySec * 1000,
  };
}

/* ==========================================================================
   스포너
   ========================================================================== */

/** 둥지 위치의 지면 위 살짝 띄운 좌표 */
function eggPosition(nest: Nest): { x: number; y: number; z: number } {
  return { x: nest.x, y: terrainHeight(nest.x, nest.z) + E.hoverHeight, z: nest.z };
}

/**
 * 스포너를 만든다. 모든 둥지를 채운 상태로 시작한다 —
 * 빈 월드에서 5분을 기다리게 하면 첫인상이 최악이 된다.
 */
export function createSpawner(seed = 4242, now = 0): SpawnerState {
  const nests = generateNests(seed);
  const rng = rngCursor(seed ^ 0x5bf03635);
  const slots: NestSlot[] = [];
  let nextEggId = 1;

  for (const nest of nests) {
    const rarity = rollRarity(rng.next());
    const element = ELEMENTS[Math.floor(rng.next() * ELEMENTS.length)];
    const egg = makeEgg(nextEggId++, rarity, element, now, rng);
    const p = eggPosition(nest);
    slots.push({ nest, egg: { egg, ...p, nestId: nest.id }, respawnAt: 0 });
  }

  return { slots, nextEggId, rngState: rng.state };
}

/**
 * 스포너 1틱. 리스폰 시각이 지난 빈 둥지에 새 알을 놓는다.
 * dt 가 아니라 절대 시각(now, ms)을 받는 이유: 오프라인/재접속 시에도
 * 경과 시간만큼 알아서 채워지고, 서버와 대조하기도 쉽다.
 */
export function stepSpawner(state: SpawnerState, now: number): SpawnedEgg[] {
  const spawned: SpawnedEgg[] = [];
  const rng = rngCursor(state.rngState);

  for (const slot of state.slots) {
    if (slot.egg || now < slot.respawnAt) continue;

    const rarity = rollRarity(rng.next());
    const element = ELEMENTS[Math.floor(rng.next() * ELEMENTS.length)];
    const egg = makeEgg(state.nextEggId++, rarity, element, now, rng);
    const p = eggPosition(slot.nest);
    slot.egg = { egg, ...p, nestId: slot.nest.id };
    spawned.push(slot.egg);
  }

  state.rngState = rng.state;
  return spawned;
}

/**
 * 둥지에서 알을 꺼낸다 (Phase 1 다음 단계인 "운반"이 호출할 진입점).
 * 꺼내는 즉시 리스폰 타이머가 돌기 시작한다.
 */
export function takeEgg(state: SpawnerState, nestId: string, now: number): SpawnedEgg | null {
  const slot = state.slots.find((s) => s.nest.id === nestId);
  if (!slot || !slot.egg) return null;

  const taken = slot.egg;
  slot.egg = null;

  const rng = rngCursor(state.rngState);
  const span = E.respawnMaxSec - E.respawnMinSec;
  slot.respawnAt = now + (E.respawnMinSec + rng.next() * span) * 1000;
  state.rngState = rng.state;

  return taken;
}

/** 현재 월드에 놓여 있는 알 전부 */
export function activeEggs(state: SpawnerState): SpawnedEgg[] {
  const out: SpawnedEgg[] = [];
  for (const s of state.slots) if (s.egg) out.push(s.egg);
  return out;
}

/** 가장 가까운 알과 그 수평 거리. 없으면 null. */
export function nearestEgg(
  state: SpawnerState,
  x: number,
  z: number,
): { egg: SpawnedEgg; dist: number } | null {
  let best: SpawnedEgg | null = null;
  let bestD = Infinity;
  for (const s of state.slots) {
    if (!s.egg) continue;
    const d = Math.hypot(s.egg.x - x, s.egg.z - z);
    if (d < bestD) {
      bestD = d;
      best = s.egg;
    }
  }
  return best ? { egg: best, dist: bestD } : null;
}

/** 레이더 표시용 — 지정 반경 안의 알들 */
export function eggsWithin(
  state: SpawnerState,
  x: number,
  z: number,
  range = E.radarRange,
): SpawnedEgg[] {
  const out: SpawnedEgg[] = [];
  for (const s of state.slots) {
    if (!s.egg) continue;
    if (Math.hypot(s.egg.x - x, s.egg.z - z) <= range) out.push(s.egg);
  }
  return out;
}
