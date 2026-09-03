/**
 * 성장 테스트 — 운반 · 흡수 · 단계 · 친화도 (기획서 §2, §6, §3.5)
 *
 * 실행: npx tsx --test tests/progress.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProgress,
  stageForGeneMass,
  toNextStage,
  normalizedAffinity,
  affinityKind,
  dominantElement,
  canCarry,
  pickUp,
  drop,
  absorb,
  absorbCarried,
  carrySpeedMult,
  inHomeNest,
  distanceToHome,
} from '../src/player/progress.ts';
import type { DragonEgg, Element } from '../src/types.ts';
import balance from '../src/data/balance.json' with { type: 'json' };

const G = balance.growth;

function egg(element: Element, geneMass: number, traits = 1): DragonEgg {
  return {
    id: `t-${element}-${geneMass}`,
    rarity: 'common',
    element,
    geneMass,
    traits: Array.from({ length: traits }, () => ({ element, weight: 1 })),
    decayAt: 0,
  };
}

/* ==========================================================================
   단계
   ========================================================================== */

test('시작은 1단계, 유전 질량 0', () => {
  const p = createProgress();
  assert.equal(p.stage, 1);
  assert.equal(p.geneMass, 0);
  assert.equal(p.absorbed, 0);
  assert.equal(p.carried, null);
});

test('단계는 임계값을 정확히 따른다', () => {
  const t = G.stageThresholds;
  for (let i = 0; i < t.length; i++) {
    assert.equal(stageForGeneMass(t[i]), i + 1, `임계값 ${t[i]} 에서 ${i + 1}단계여야 한다`);
    if (i > 0) {
      assert.equal(stageForGeneMass(t[i] - 1), i, `임계값 직전은 아직 ${i}단계여야 한다`);
    }
  }
});

test('단계는 1~6 을 벗어나지 않는다', () => {
  assert.equal(stageForGeneMass(-999), 1);
  assert.equal(stageForGeneMass(0), 1);
  assert.equal(stageForGeneMass(99_999_999), 6);
});

test('성장은 오직 유전 질량으로만 결정된다 (§6.1)', () => {
  // 같은 질량이면 어떤 경로로 왔든 같은 단계여야 한다
  const a = createProgress();
  absorb(a, egg('ember', G.stageThresholds[2]));

  const b = createProgress();
  const chunk = G.stageThresholds[2] / 10;
  for (let i = 0; i < 10; i++) absorb(b, egg('rime', chunk));

  assert.equal(a.stage, b.stage, '한 번에 먹은 쪽과 나눠 먹은 쪽의 단계가 다르다');
  assert.equal(a.geneMass, b.geneMass);
});

test('다음 단계까지 필요량과 진행도가 맞다', () => {
  const t = G.stageThresholds;
  const mid = (t[1] + t[2]) / 2;
  const n = toNextStage(mid)!;
  assert.ok(Math.abs(n.need - (t[2] - mid)) < 1e-9);
  assert.ok(Math.abs(n.progress - 0.5) < 1e-9, `진행도 ${n.progress} 가 0.5 가 아니다`);
});

test('최대 단계에서는 다음 단계가 없다', () => {
  assert.equal(toNextStage(G.stageThresholds[5]), null);
  assert.equal(toNextStage(999_999), null);
});

test('진행도는 0~1 을 벗어나지 않는다', () => {
  for (let m = 0; m < G.stageThresholds[5]; m += 37) {
    const n = toNextStage(m);
    if (!n) continue;
    assert.ok(n.progress >= 0 && n.progress <= 1, `질량 ${m} 에서 진행도 ${n.progress}`);
  }
});

/* ==========================================================================
   흡수
   ========================================================================== */

test('흡수하면 유전 질량 · 친화도 · 발현 풀이 함께 쌓인다', () => {
  const p = createProgress();
  absorb(p, egg('ember', 30, 3));

  assert.equal(p.geneMass, 30);
  assert.equal(p.elementAffinity.ember, 30);
  assert.equal(p.expressionPool.length, 3, '특성이 발현 풀에 안 쌓였다');
  assert.equal(p.absorbed, 1);
});

test('단계가 오르면 leveledUp 이 true, 아니면 false', () => {
  const p = createProgress();
  const r1 = absorb(p, egg('ember', G.stageThresholds[1]));
  assert.equal(r1.leveledUp, true);
  assert.equal(r1.fromStage, 1);
  assert.equal(r1.toStage, 2);

  const r2 = absorb(p, egg('ember', 1));
  assert.equal(r2.leveledUp, false);
});

test('큰 알 하나로 여러 단계를 한 번에 뛸 수 있다', () => {
  const p = createProgress();
  const r = absorb(p, egg('ember', G.stageThresholds[3]));
  assert.equal(r.fromStage, 1);
  assert.equal(r.toStage, 4);
  assert.equal(r.leveledUp, true);
});

test('친화도는 질량 가중이다 — 큰 알일수록 육성 방향을 크게 흔든다', () => {
  const p = createProgress();
  absorb(p, egg('ember', 10));
  absorb(p, egg('rime', 90));
  const norm = normalizedAffinity(p);
  assert.ok(Math.abs(norm.rime - 0.9) < 1e-9, `빙결 비율 ${norm.rime}`);
  assert.ok(Math.abs(norm.ember - 0.1) < 1e-9);
  assert.equal(dominantElement(p), 'rime');
});

/* ==========================================================================
   친화도 유형 (§3.5)
   ========================================================================== */

test('한 속성 70% 이상이면 순혈', () => {
  const p = createProgress();
  absorb(p, egg('ember', 80));
  absorb(p, egg('rime', 20));
  assert.equal(affinityKind(p), 'pure');
});

test('두 속성 40/40 이면 이종', () => {
  const p = createProgress();
  absorb(p, egg('ember', 50));
  absorb(p, egg('rime', 50));
  assert.equal(affinityKind(p), 'dual');
});

test('여러 속성으로 흩어지면 잡종', () => {
  const p = createProgress();
  for (const e of ['ember', 'rime', 'gale', 'blight'] as Element[]) absorb(p, egg(e, 25));
  assert.equal(affinityKind(p), 'mongrel');
});

test('정규화된 친화도의 합은 1 (아무것도 안 먹었으면 0)', () => {
  const empty = createProgress();
  const sum0 = Object.values(normalizedAffinity(empty)).reduce((a, b) => a + b, 0);
  assert.equal(sum0, 0);
  assert.equal(dominantElement(empty), null);

  const p = createProgress();
  absorb(p, egg('gale', 13));
  absorb(p, egg('umbra', 41));
  const sum = Object.values(normalizedAffinity(p)).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `합이 ${sum}`);
});

/* ==========================================================================
   운반 (§2 게임의 중심축)
   ========================================================================== */

test('알은 한 번에 하나만 들 수 있다', () => {
  const p = createProgress();
  assert.equal(canCarry(p), true);
  assert.equal(pickUp(p, egg('ember', 10)), true);
  assert.equal(canCarry(p), false);
  assert.equal(pickUp(p, egg('rime', 10)), false, '두 개째를 들 수 있으면 운반의 긴장이 사라진다');
  assert.equal(p.carried!.element, 'ember', '들고 있던 알이 덮어씌워졌다');
});

test('운반 중에는 이동이 25% 느려진다 (§2)', () => {
  const p = createProgress();
  assert.equal(carrySpeedMult(p), 1);
  pickUp(p, egg('ember', 10));
  assert.equal(carrySpeedMult(p), balance.carry.moveSpeedMult);
  assert.ok(carrySpeedMult(p) < 1, '운반 페널티가 없다');
});

test('내려놓으면 알이 돌아오고 손이 빈다', () => {
  const p = createProgress();
  const e = egg('terra', 10);
  pickUp(p, e);
  assert.equal(drop(p), e);
  assert.equal(p.carried, null);
  assert.equal(canCarry(p), true);
});

test('빈손으로 내려놓으면 null', () => {
  assert.equal(drop(createProgress()), null);
});

test('내려놓은 알은 흡수되지 않는다 — 운반에 실패하면 성장도 없다', () => {
  const p = createProgress();
  pickUp(p, egg('ember', 500));
  drop(p);
  assert.equal(p.geneMass, 0, '버린 알의 질량이 들어갔다');
  assert.equal(p.stage, 1);
});

test('들고 있는 알을 흡수하면 손이 비고 성장한다', () => {
  const p = createProgress();
  pickUp(p, egg('ember', G.stageThresholds[1]));
  const r = absorbCarried(p)!;
  assert.equal(p.carried, null, '흡수했는데 아직 들고 있다');
  assert.equal(r.leveledUp, true);
  assert.equal(p.geneMass, G.stageThresholds[1]);
});

test('빈손으로 흡수하면 null 이고 아무 일도 없다', () => {
  const p = createProgress();
  assert.equal(absorbCarried(p), null);
  assert.equal(p.geneMass, 0);
  assert.equal(p.absorbed, 0);
});

/* ==========================================================================
   홈 둥지 (§2 둥지 귀환)
   ========================================================================== */

test('홈 둥지 판정은 반경을 따른다', () => {
  const H = balance.homeNest;
  assert.equal(inHomeNest(H.x, H.z), true, '한가운데인데 둥지 밖이다');
  assert.equal(inHomeNest(H.x + H.radius - 1, H.z), true);
  assert.equal(inHomeNest(H.x + H.radius + 1, H.z), false);
});

test('홈 둥지까지의 거리가 맞다', () => {
  const H = balance.homeNest;
  assert.ok(Math.abs(distanceToHome(H.x + 300, H.z) - 300) < 1e-9);
});

/* ==========================================================================
   전체 루프
   ========================================================================== */

test('§2 핵심 루프가 끝까지 돈다 — 회수 → 운반 → 귀환 → 흡수 → 성장', () => {
  const p = createProgress();
  const startStage = p.stage;

  // 여러 번 돌려 실제로 단계가 오르는지 본다
  for (let i = 0; i < 30; i++) {
    assert.equal(canCarry(p), true, `${i}회차에 손이 비어있지 않다`);
    pickUp(p, egg('ember', 26));
    assert.ok(carrySpeedMult(p) < 1, '운반 중인데 페널티가 없다');
    // 둥지로 돌아와 흡수
    assert.equal(inHomeNest(balance.homeNest.x, balance.homeNest.z), true);
    absorbCarried(p);
  }

  assert.equal(p.absorbed, 30);
  assert.equal(p.geneMass, 26 * 30);
  assert.ok(p.stage > startStage, `30개를 먹었는데 아직 ${p.stage}단계다`);
  assert.equal(p.expressionPool.length, 30, '발현 풀이 안 쌓였다');
  assert.equal(carrySpeedMult(p), 1, '흡수 후에도 운반 페널티가 남아있다');
});
