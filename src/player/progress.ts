/**
 * 성장 — 운반 · 흡수 · 단계 상승 · 친화도 (기획서 §2 핵심 루프, §6)
 *
 * 핵심 규칙 하나: **성장은 오직 흡수한 알의 유전 질량 총합으로만 결정된다** (§6.1).
 * 사냥이든 시간이든 다른 어떤 것도 단계를 올리지 못한다. 그래야 "알을 줍는 행위가
 * 곧 성장"이라는 한 줄 컨셉(§1)이 시스템으로 성립한다.
 *
 * Three.js 를 import 하지 않는다. 순수 함수만 둔다 (§13.3).
 */

import type {
  AbsorbResult,
  AffinityKind,
  DragonEgg,
  Element,
  PlayerProgress,
  Stage,
} from '../types';
import { ELEMENTS } from '../types';
import balance from '../data/balance.json';

const G = balance.growth;
const A = balance.affinity;

export function createProgress(): PlayerProgress {
  const elementAffinity = {} as Record<Element, number>;
  for (const e of ELEMENTS) elementAffinity[e] = 0;
  return {
    geneMass: 0,
    stage: 1,
    elementAffinity,
    expressionPool: [],
    carried: null,
    absorbed: 0,
  };
}

/* ==========================================================================
   단계
   ========================================================================== */

/** 유전 질량으로 성장 단계를 구한다. 임계값은 balance.json 이 정한다. */
export function stageForGeneMass(mass: number): Stage {
  const t = G.stageThresholds;
  let stage = 1;
  // 위에서부터 내려오며 처음 만족하는 단계를 고른다
  for (let i = t.length - 1; i >= 0; i--) {
    if (mass >= t[i]) {
      stage = i + 1;
      break;
    }
  }
  return Math.min(6, Math.max(1, stage)) as Stage;
}

/** 다음 단계까지 필요한 유전 질량. 최대 단계면 null. */
export function toNextStage(mass: number): { need: number; progress: number } | null {
  const t = G.stageThresholds;
  const stage = stageForGeneMass(mass);
  if (stage >= 6) return null;
  const cur = t[stage - 1];
  const next = t[stage];
  return {
    need: next - mass,
    // 현재 단계 구간 안에서의 진행도 0~1
    progress: Math.max(0, Math.min(1, (mass - cur) / (next - cur))),
  };
}

/* ==========================================================================
   친화도 (§3.5)
   ========================================================================== */

/** 누적 친화도를 합이 1인 비율로 정규화한다 */
export function normalizedAffinity(p: PlayerProgress): Record<Element, number> {
  const out = {} as Record<Element, number>;
  let total = 0;
  for (const e of ELEMENTS) total += p.elementAffinity[e];
  for (const e of ELEMENTS) out[e] = total > 0 ? p.elementAffinity[e] / total : 0;
  return out;
}

/**
 * 순혈 / 이종 / 잡종 판정 (§3.5).
 * 명확한 트레이드오프가 있어야 육성 방향이 "선택"이 된다.
 */
export function affinityKind(p: PlayerProgress): AffinityKind {
  const norm = normalizedAffinity(p);
  const sorted = ELEMENTS.map((e) => norm[e]).sort((a, b) => b - a);
  if (sorted[0] >= A.pureThreshold) return 'pure';
  if (sorted[0] >= A.dualThreshold && sorted[1] >= A.dualThreshold) return 'dual';
  return 'mongrel';
}

/** 가장 비중이 큰 속성. 아직 아무것도 안 먹었으면 null. */
export function dominantElement(p: PlayerProgress): Element | null {
  let best: Element | null = null;
  let bestV = 0;
  for (const e of ELEMENTS) {
    if (p.elementAffinity[e] > bestV) {
      bestV = p.elementAffinity[e];
      best = e;
    }
  }
  return best;
}

/* ==========================================================================
   운반 · 흡수
   ========================================================================== */

/** 지금 알을 들 수 있는가. 한 번에 하나만 (§2). */
export function canCarry(p: PlayerProgress): boolean {
  return p.carried === null;
}

/** 알을 든다. 이미 들고 있으면 실패. */
export function pickUp(p: PlayerProgress, egg: DragonEgg): boolean {
  if (!canCarry(p)) return false;
  p.carried = egg;
  return true;
}

/** 들고 있던 알을 내려놓는다 (되돌려줄 알을 반환). */
export function drop(p: PlayerProgress): DragonEgg | null {
  const e = p.carried;
  p.carried = null;
  return e;
}

/**
 * 운반 중 이동속도 배율 (§2 — 알을 쥔 동안 이동 -25%).
 *
 * 기획서의 나머지 운반 페널티(스태미나 +40%, 브레스 불가, 위치 노출, 피격 시 낙하)는
 * 각각 스태미나·전투·멀티플레이 시스템이 생긴 뒤에야 의미가 있으므로 그 단계에서 붙인다.
 */
export function carrySpeedMult(p: PlayerProgress): number {
  return p.carried ? balance.carry.moveSpeedMult : 1;
}

/**
 * 들고 있던 알을 흡수한다. 이게 성장의 유일한 경로다.
 *
 * 세 가지가 동시에 일어난다:
 *   1. 유전 질량 누적 → 단계 상승 판정
 *   2. 속성 친화도 누적 → 외형과 스킬 발현 방향이 바뀐다
 *   3. 특성이 발현 풀에 쌓인다 → Phase 4 스킬 생성기의 재료
 */
export function absorb(p: PlayerProgress, egg: DragonEgg): AbsorbResult {
  const fromStage = p.stage;

  p.geneMass += egg.geneMass;
  // 친화도는 질량 가중 — 큰 알일수록 육성 방향을 크게 흔든다
  p.elementAffinity[egg.element] += egg.geneMass;
  for (const t of egg.traits) p.expressionPool.push(t);
  p.absorbed++;

  const toStage = stageForGeneMass(p.geneMass);
  p.stage = toStage;

  return {
    gained: egg.geneMass,
    leveledUp: toStage > fromStage,
    fromStage,
    toStage,
  };
}

/** 들고 있는 알을 그 자리에서 흡수한다. 들고 있지 않으면 null. */
export function absorbCarried(p: PlayerProgress): AbsorbResult | null {
  if (!p.carried) return null;
  const egg = p.carried;
  p.carried = null;
  return absorb(p, egg);
}

/* ==========================================================================
   홈 둥지
   ========================================================================== */

/** 홈 둥지 안에 있는가 (§2 둥지 귀환) */
export function inHomeNest(x: number, z: number): boolean {
  const H = balance.homeNest;
  return Math.hypot(x - H.x, z - H.z) <= H.radius;
}

/** 홈 둥지까지의 수평 거리 */
export function distanceToHome(x: number, z: number): number {
  const H = balance.homeNest;
  return Math.hypot(x - H.x, z - H.z);
}
