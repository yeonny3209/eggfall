/**
 * 알 스폰 테스트 (기획서 §7.1 자연 둥지)
 *
 * 스폰은 결국 서버 권위 판정이 되므로, 순수 함수인 지금부터 결정론과 불변식을 못 박아둔다.
 *
 * 실행: npx tsx --test tests/spawn.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSpawner,
  stepSpawner,
  takeEgg,
  activeEggs,
  nearestEgg,
  eggsWithin,
  generateNests,
  rollRarity,
  rarityAtLeast,
  nextRandom,
} from '../src/egg/spawn.ts';
import type { Rarity } from '../src/types.ts';
import balance from '../src/data/balance.json' with { type: 'json' };
import { terrainHeight } from '../src/world/terrain.ts';

const E = balance.eggs;

/* ---------- 난수 ---------- */

test('난수는 결정론적이다 — 같은 시드는 같은 수열', () => {
  const seq = (seed: number) => {
    let s = seed;
    const out: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = nextRandom(s);
      s = r.state;
      out.push(r.value);
    }
    return out;
  };
  assert.deepEqual(seq(1234), seq(1234));
  assert.notDeepEqual(seq(1234), seq(1235));
});

test('난수는 0에 갇히지 않는다 — xorshift 의 고정점 방어', () => {
  let s = 0;
  for (let i = 0; i < 10; i++) {
    const r = nextRandom(s);
    s = r.state;
    assert.ok(r.value > 0 && r.value < 1, `${i}번째에서 ${r.value}`);
  }
});

test('난수는 0~1 범위를 벗어나지 않는다', () => {
  let s = 987654321;
  for (let i = 0; i < 5000; i++) {
    const r = nextRandom(s);
    s = r.state;
    assert.ok(r.value >= 0 && r.value < 1, `범위 밖: ${r.value}`);
  }
});

/* ---------- 둥지 ---------- */

test('둥지 배치는 결정론적이다 — 서버·클라가 같은 월드를 봐야 한다', () => {
  assert.deepEqual(generateNests(99), generateNests(99));
  assert.notDeepEqual(generateNests(99), generateNests(100));
});

test('둥지는 설정된 개수만큼, 설정된 반경 안에 놓인다', () => {
  const nests = generateNests(7);
  assert.equal(nests.length, E.nestCount);
  for (const n of nests) {
    const r = Math.hypot(n.x, n.z);
    assert.ok(
      r >= E.nestMinRadius - 0.001 && r <= E.nestMaxRadius + 0.001,
      `둥지가 반경 밖: ${r.toFixed(0)}m`,
    );
  }
});

test('둥지 id 는 고유하다', () => {
  const ids = new Set(generateNests(3).map((n) => n.id));
  assert.equal(ids.size, E.nestCount);
});

/* ---------- 등급 ---------- */

test('자연 둥지에서 신성 알은 절대 나오지 않는다 (§5.1 — 시즌당 12회 각성 전용)', () => {
  for (let i = 0; i < 20000; i++) {
    assert.notEqual(rollRarity(i / 20000), 'divine');
  }
});

test('등급 분포가 가중치를 따른다 — 일반이 가장 흔하고 영웅이 가장 드물다', () => {
  const count: Record<string, number> = {};
  const N = 40000;
  let s = 12345;
  for (let i = 0; i < N; i++) {
    const r = nextRandom(s);
    s = r.state;
    const rarity = rollRarity(r.value);
    count[rarity] = (count[rarity] ?? 0) + 1;
  }
  assert.ok(count.common > count.uncommon, `일반 ${count.common} vs 고급 ${count.uncommon}`);
  assert.ok(count.uncommon > count.rare, `고급 ${count.uncommon} vs 희귀 ${count.rare}`);
  assert.ok(count.rare > (count.epic ?? 0), `희귀 ${count.rare} vs 영웅 ${count.epic}`);
  assert.ok((count.epic ?? 0) > 0, '영웅이 한 번도 안 나왔다 — 가중치가 너무 낮다');
});

test('rarityAtLeast 는 등급 순서를 지킨다', () => {
  assert.ok(rarityAtLeast('epic', 'rare'));
  assert.ok(rarityAtLeast('rare', 'rare'));
  assert.ok(!rarityAtLeast('uncommon', 'rare'));
});

/* ---------- 스포너 ---------- */

test('스포너는 모든 둥지를 채운 채로 시작한다 — 빈 월드로 시작하면 첫인상이 최악이다', () => {
  const sp = createSpawner(1, 0);
  assert.equal(activeEggs(sp).length, E.nestCount);
});

test('같은 시드는 같은 알 배치를 만든다', () => {
  const a = activeEggs(createSpawner(77, 0));
  const b = activeEggs(createSpawner(77, 0));
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].egg.rarity, b[i].egg.rarity);
    assert.equal(a[i].egg.element, b[i].egg.element);
    assert.equal(a[i].x, b[i].x);
  }
});

test('알은 지면 위 일정 높이에 뜬다 — 지형에 묻히면 안 보인다', () => {
  for (const se of activeEggs(createSpawner(5, 0))) {
    const expected = terrainHeight(se.x, se.z) + E.hoverHeight;
    assert.ok(Math.abs(se.y - expected) < 0.001, `알 높이 ${se.y} != ${expected}`);
  }
});

test('알 id 는 전부 고유하다', () => {
  const sp = createSpawner(9, 0);
  const ids = new Set(activeEggs(sp).map((e) => e.egg.id));
  assert.equal(ids.size, E.nestCount);
});

test('알마다 등급에 맞는 유전 질량과 특성 수를 갖는다', () => {
  for (const se of activeEggs(createSpawner(11, 0))) {
    const r = se.egg.rarity as Rarity;
    assert.equal(se.egg.geneMass, (E.geneMass as Record<Rarity, number>)[r]);
    assert.equal(se.egg.traits.length, (E.traitCount as Record<Rarity, number>)[r]);
    for (const t of se.egg.traits) {
      // 특성은 코어나 변조 중 정확히 하나를 밀어준다
      const hasCore = t.core !== undefined;
      const hasMod = t.modifier !== undefined;
      assert.ok(hasCore !== hasMod, '특성이 코어/변조를 둘 다 갖거나 둘 다 없다');
    }
  }
});

test('알은 decayAt 을 갖는다 (§7.2 미부화 소멸)', () => {
  const now = 1_000_000;
  for (const se of activeEggs(createSpawner(13, now))) {
    assert.equal(se.egg.decayAt, now + E.decaySec * 1000);
  }
});

/* ---------- 줍기와 리스폰 ---------- */

test('알을 주우면 그 둥지가 비고 리스폰 타이머가 돈다', () => {
  const sp = createSpawner(21, 0);
  const target = sp.slots[0];
  const nestId = target.nest.id;

  const taken = takeEgg(sp, nestId, 0);
  assert.ok(taken, '알을 못 꺼냈다');
  assert.equal(target.egg, null, '꺼냈는데 둥지가 안 비었다');
  assert.equal(activeEggs(sp).length, E.nestCount - 1);
  assert.ok(
    target.respawnAt >= E.respawnMinSec * 1000 && target.respawnAt <= E.respawnMaxSec * 1000,
    `리스폰 시각이 범위 밖: ${target.respawnAt}`,
  );
});

test('빈 둥지에서 또 주우려 하면 null 이 나온다', () => {
  const sp = createSpawner(22, 0);
  const nestId = sp.slots[0].nest.id;
  takeEgg(sp, nestId, 0);
  assert.equal(takeEgg(sp, nestId, 0), null);
});

test('없는 둥지 id 로 주우려 하면 null 이 나온다', () => {
  const sp = createSpawner(23, 0);
  assert.equal(takeEgg(sp, 'nest-없음', 0), null);
});

test('리스폰 시각 전에는 다시 안 채워진다', () => {
  const sp = createSpawner(24, 0);
  const slot = sp.slots[0];
  takeEgg(sp, slot.nest.id, 0);

  stepSpawner(sp, E.respawnMinSec * 1000 - 1);
  assert.equal(slot.egg, null, '리스폰 시각 전인데 알이 생겼다');
  assert.equal(activeEggs(sp).length, E.nestCount - 1);
});

test('리스폰 시각이 지나면 새 알이 놓인다', () => {
  const sp = createSpawner(25, 0);
  const slot = sp.slots[0];
  const before = takeEgg(sp, slot.nest.id, 0)!;

  const spawned = stepSpawner(sp, E.respawnMaxSec * 1000 + 1);
  assert.equal(spawned.length, 1, '리스폰이 안 됐다');
  assert.ok(slot.egg, '둥지가 여전히 비어있다');
  assert.equal(activeEggs(sp).length, E.nestCount);
  // 새 알은 이전 알과 다른 id 여야 한다
  assert.notEqual(slot.egg!.egg.id, before.egg.id);
  // 자리는 그대로 (고정 위치 둥지)
  assert.equal(slot.egg!.x, before.x);
  assert.equal(slot.egg!.z, before.z);
});

test('아무 일 없으면 stepSpawner 는 아무것도 새로 만들지 않는다', () => {
  const sp = createSpawner(26, 0);
  assert.equal(stepSpawner(sp, 10_000).length, 0);
  assert.equal(activeEggs(sp).length, E.nestCount);
});

test('오래 자리를 비워도 둥지가 중복 생성되지 않는다 — 한 둥지엔 알 하나', () => {
  const sp = createSpawner(27, 0);
  for (const s of sp.slots) takeEgg(sp, s.nest.id, 0);
  assert.equal(activeEggs(sp).length, 0);

  // 아주 먼 미래로 한 번에 점프 (오프라인 후 재접속 시나리오)
  stepSpawner(sp, 100 * 60 * 60 * 1000);
  assert.equal(activeEggs(sp).length, E.nestCount, '알이 전부 돌아오지 않았다');

  // 또 돌려도 더 늘어나지 않아야 한다
  stepSpawner(sp, 200 * 60 * 60 * 1000);
  assert.equal(activeEggs(sp).length, E.nestCount, '알이 중복 생성됐다');
});

/* ---------- 탐색 ---------- */

test('nearestEgg 는 실제로 가장 가까운 알을 찾는다', () => {
  const sp = createSpawner(31, 0);
  const eggs = activeEggs(sp);
  const px = 400;
  const pz = -900;

  const found = nearestEgg(sp, px, pz)!;
  let trueMin = Infinity;
  for (const e of eggs) trueMin = Math.min(trueMin, Math.hypot(e.x - px, e.z - pz));
  assert.ok(Math.abs(found.dist - trueMin) < 0.001, `${found.dist} vs ${trueMin}`);
});

test('알이 하나도 없으면 nearestEgg 는 null', () => {
  const sp = createSpawner(32, 0);
  for (const s of sp.slots) takeEgg(sp, s.nest.id, 0);
  assert.equal(nearestEgg(sp, 0, 0), null);
});

test('eggsWithin 은 반경 안의 알만 돌려준다', () => {
  const sp = createSpawner(33, 0);
  const range = 700;
  const within = eggsWithin(sp, 0, 0, range);
  for (const e of within) {
    assert.ok(Math.hypot(e.x, e.z) <= range + 0.001, '반경 밖 알이 섞였다');
  }
  const total = activeEggs(sp).filter((e) => Math.hypot(e.x, e.z) <= range).length;
  assert.equal(within.length, total);
});
