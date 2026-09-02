/**
 * 비행 시뮬레이션 테스트
 *
 * 기획서 §13.3 의 원칙을 비행에도 적용한다: 순수 함수이므로 단독으로 검증할 수 있다.
 * 브라우저에서 눈으로 튜닝하면 재현이 안 되고, 회귀도 못 잡는다.
 *
 * 실행: npx tsx --test tests/flight.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFlightState,
  createRuntime,
  neutralInput,
  stepFlight,
  generateThermals,
  thermalAt,
  layerOf,
} from '../src/flight/simulate.ts';
import type { FlightInput } from '../src/types.ts';
import balance from '../src/data/balance.json' with { type: 'json' };
import { terrainHeight, TERRAIN_MIN, TERRAIN_MAX } from '../src/world/terrain.ts';

const F = balance.flight;

/** n초간 시뮬레이션을 돌리고 최종 상태를 돌려준다 */
function fly(seconds: number, input: Partial<FlightInput> = {}, y0 = 300) {
  const s = createFlightState(0, y0, 0);
  const rt = createRuntime();
  const cmd = { ...neutralInput(), ...input };
  const dt = 1 / 60;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) stepFlight(s, rt, cmd, dt, []);
  return s;
}

const speedOf = (s: { vx: number; vy: number; vz: number }) => Math.hypot(s.vx, s.vy, s.vz);

/* 피치 부호 규약 (input.ts 와 일치해야 한다)
   NOSE_DOWN(-1) = W = 하강·가속 / NOSE_UP(+1) = S = 상승·감속 */
const NOSE_DOWN = -1;
const NOSE_UP = 1;

test('출발 즉시 실속하지 않는다 — 초기 속도는 기수 방향이어야 한다', () => {
  const s = createFlightState(0, 300, 0);
  assert.ok(speedOf(s) >= F.minAirspeed, `초기 속도 ${speedOf(s)} 가 최소 대기속도 미만`);

  // 1초 뒤에도 실속하지 않아야 한다
  const after = fly(1);
  assert.ok(
    speedOf(after) >= F.minAirspeed,
    `1초 후 속도 ${speedOf(after).toFixed(1)} 이 실속 구간`,
  );
});

test('수평 활공은 순항 속도로 수렴한다', () => {
  const s = fly(12);
  const cruise = Math.sqrt((F.thrustForward * F.maxSpeed) / F.dragBase);
  assert.ok(
    Math.abs(speedOf(s) - cruise) < 6,
    `순항 ${speedOf(s).toFixed(1)} 이 이론값 ${cruise.toFixed(1)} 과 6m/s 넘게 차이`,
  );
});

test('수평 활공은 고도를 잃는다 — 고도가 공짜면 상승기류가 무의미해진다', () => {
  const s = fly(10);
  assert.ok(s.y < 300, `10초 활공 후 고도가 ${s.y.toFixed(1)} 로 떨어지지 않았다`);
  // 다만 급격히 추락해서도 안 된다
  assert.ok(s.y > 200, `10초 만에 ${(300 - s.y).toFixed(0)}m 나 잃는다 — 침하가 과하다`);
});

test('기수를 내리면 가속하고, 올리면 감속한다 (§8.2 고도↔속도 교환)', () => {
  const down = fly(4, { pitch: NOSE_DOWN }, 2000);
  const up = fly(4, { pitch: NOSE_UP }, 2000);
  assert.ok(
    speedOf(down) > speedOf(up),
    `기수 내림 ${speedOf(down).toFixed(1)} 이 기수 올림 ${speedOf(up).toFixed(1)} 보다 빠르지 않다`,
  );
  assert.ok(down.y < up.y, '기수를 내렸는데 고도가 더 높다');
});

test('계속 상승하면 실속한다 — 무한 상승은 불가능해야 한다', () => {
  const s = fly(6, { pitch: NOSE_UP }, 2000);
  assert.ok(speedOf(s) < F.minAirspeed * 2.2, `상승 6초 후에도 속도 ${speedOf(s).toFixed(1)} 로 여유`);
});

test('급강하는 순항보다 확실히 빠르다', () => {
  const dive = fly(6, { pitch: NOSE_DOWN, dive: true }, 2000);
  const cruise = fly(6, {}, 2000);
  assert.ok(
    speedOf(dive) > speedOf(cruise) * 1.5,
    `급강하 ${speedOf(dive).toFixed(1)} vs 순항 ${speedOf(cruise).toFixed(1)} — 차이가 부족하다`,
  );
});

test('급강하는 스태미나를 소모하고, 활공은 회복한다', () => {
  const dive = fly(5, { pitch: NOSE_DOWN, dive: true }, 2000);
  assert.ok(dive.stamina < F.staminaMax, '급강하 5초인데 스태미나가 만땅이다');

  // 회복 확인은 반드시 중층에서 한다 — 고층(220m 이상)은 설계상 회복이 없다
  const glide = fly(5, {}, 150);
  assert.equal(glide.stamina, F.staminaMax, '중층 활공 중 스태미나가 회복되지 않았다');
});

test('날갯짓은 스태미나를 쓰고 고도를 준다', () => {
  const flap = fly(4, { flap: true });
  const glide = fly(4);
  assert.ok(flap.y > glide.y, '날갯짓을 해도 활공보다 높지 않다');
  assert.ok(flap.stamina < glide.stamina, '날갯짓이 스태미나를 소모하지 않았다');
});

test('스태미나가 무한 날갯짓을 막는다', () => {
  const s = createFlightState(0, 100, 0);
  const rt = createRuntime();
  const cmd = { ...neutralInput(), flap: true };
  const dt = 1 / 60;
  let flaps = 0;
  for (let i = 0; i < 60 * 20; i++) {
    if (stepFlight(s, rt, cmd, dt, []).flapped) flaps++;
  }
  // 무한정 오르지 못하고 스태미나 회복 속도에 묶여야 한다
  const maxPossible = (20 * F.staminaRegen) / F.flapStaminaCost + F.staminaMax / F.flapStaminaCost;
  assert.ok(flaps <= Math.ceil(maxPossible) + 1, `20초에 ${flaps}회 날갯짓 — 스태미나 제한이 새고 있다`);
});

test('고층 체류는 스태미나를 깎는다 (§9)', () => {
  const high = fly(6, {}, F.highLayerY + 40);
  const mid = fly(6, {}, 150);
  assert.ok(high.stamina < F.staminaMax, '고층인데 스태미나가 만땅 그대로다 — 소모가 회복에 묻혔다');
  assert.ok(
    high.stamina < mid.stamina,
    `고층 ${high.stamina.toFixed(0)} 이 중층 ${mid.stamina.toFixed(0)} 보다 적지 않다`,
  );
});

test('상승기류는 활공 침하를 이긴다', () => {
  const thermals = [{ x: 0, z: 0 }];
  const s = createFlightState(0, 100, 0);
  const rt = createRuntime();
  const cmd = neutralInput();
  const dt = 1 / 60;
  // 기류 안에 머무르도록 위치를 고정하고 수직 성분만 본다
  for (let i = 0; i < 60 * 5; i++) {
    stepFlight(s, rt, cmd, dt, thermals);
    s.x = 0;
    s.z = 0;
  }
  assert.ok(s.y > 100, `기류 안 5초인데 고도가 ${s.y.toFixed(1)} 로 오르지 않았다`);
});

test('상승기류는 반경 밖에서 0, 천장 위에서 0', () => {
  const th = [{ x: 0, z: 0 }];
  assert.ok(thermalAt(0, 50, 0, th) > 0, '중심에서 기류가 없다');
  assert.equal(thermalAt(balance.thermals.radius + 5, 50, 0, th), 0, '반경 밖인데 기류가 있다');
  assert.equal(thermalAt(0, balance.thermals.maxY + 10, 0, th), 0, '천장 위인데 기류가 있다');
});

test('상승기류 배치는 결정론적이다 — 서버·클라가 같은 월드를 봐야 한다', () => {
  assert.deepEqual(generateThermals(42), generateThermals(42));
  assert.notDeepEqual(generateThermals(42), generateThermals(43));
});

test('지면에 닿으면 착륙 상태가 된다 — 평면이 아니라 실제 지형 위에', () => {
  const s = fly(60, { pitch: NOSE_DOWN }, 200);
  assert.equal(s.grounded, true, '60초간 기수를 내렸는데 착륙하지 않았다');
  // 착륙 높이는 그 지점의 지형 높이여야 한다. 평면 하나로 처리하면 언덕을 뚫는다.
  assert.ok(
    Math.abs(s.y - terrainHeight(s.x, s.z)) < 0.001,
    `착륙 고도 ${s.y.toFixed(2)} 가 지형 높이 ${terrainHeight(s.x, s.z).toFixed(2)} 와 다르다`,
  );
});

test('지형 높이는 항상 유한하고 정해진 범위 안이다', () => {
  for (let i = 0; i < 500; i++) {
    const x = (Math.random() - 0.5) * 8000;
    const z = (Math.random() - 0.5) * 8000;
    const h = terrainHeight(x, z);
    assert.ok(Number.isFinite(h), `terrainHeight(${x},${z}) = ${h}`);
    assert.ok(h >= TERRAIN_MIN - 0.001 && h <= TERRAIN_MAX + 0.001, `범위 밖: ${h}`);
  }
});

test('능선 높이보다 낮게 날면 지형에 부딪힌다 — 언덕을 통과할 수 없다', () => {
  // 지형 최고점 부근을 찾아 그 아래로 수평 비행시킨다
  let peakX = 0, peakZ = 0, peak = 0;
  for (let x = -2000; x <= 2000; x += 50) {
    for (let z = -2000; z <= 2000; z += 50) {
      const h = terrainHeight(x, z);
      if (h > peak) { peak = h; peakX = x; peakZ = z; }
    }
  }
  const s = createFlightState(peakX, peak - 12, peakZ - 400, 0);
  const rt = createRuntime();
  let hit = false;
  for (let i = 0; i < 60 * 20 && !hit; i++) {
    if (stepFlight(s, rt, neutralInput(), 1 / 60, []).justLanded) hit = true;
  }
  assert.ok(hit, `능선(${peak.toFixed(0)}m) 아래로 날았는데 부딪히지 않았다`);
});

test('착륙 후 Space 로 이륙할 수 있다', () => {
  const s = createFlightState(0, 200, 0);
  const rt = createRuntime();
  const dt = 1 / 60;
  const down = { ...neutralInput(), pitch: NOSE_DOWN };
  for (let i = 0; i < 60 * 60 && !s.grounded; i++) stepFlight(s, rt, down, dt, []);
  assert.equal(s.grounded, true);

  const up = { ...neutralInput(), flap: true };
  for (let i = 0; i < 60 * 3; i++) stepFlight(s, rt, up, dt, []);
  assert.equal(s.grounded, false, '이륙하지 못했다');
});

test('큰 용일수록 선회가 무뎌진다 (§6.3 불변 규칙)', () => {
  const turn = (penalty: number) => {
    const s = createFlightState(0, 300, 0);
    const rt = createRuntime();
    const cmd = { ...neutralInput(), yaw: 1 };
    for (let i = 0; i < 120; i++) stepFlight(s, rt, cmd, 1 / 60, [], penalty);
    return Math.abs(s.yaw);
  };
  const hatchling = turn(balance.stage['1'].turnPenalty);
  const ancient = turn(balance.stage['6'].turnPenalty);
  assert.ok(hatchling > ancient, `해츨링 ${hatchling.toFixed(2)} 이 에인션트 ${ancient.toFixed(2)} 보다 못 돈다`);
});

test('롤을 넣으면 뱅크턴으로 요가 따라온다', () => {
  const s = createFlightState(0, 300, 0);
  const rt = createRuntime();
  const cmd = { ...neutralInput(), roll: 1 };
  for (let i = 0; i < 120; i++) stepFlight(s, rt, cmd, 1 / 60, []);
  assert.ok(Math.abs(s.yaw) > 0.3, `롤 2초에 요가 ${s.yaw.toFixed(2)} 밖에 안 돌았다`);
});

test('롤 입력을 놓으면 수평으로 되돌아온다', () => {
  const s = createFlightState(0, 300, 0);
  const rt = createRuntime();
  for (let i = 0; i < 60; i++) stepFlight(s, rt, { ...neutralInput(), roll: 1 }, 1 / 60, []);
  const rolled = Math.abs(s.roll);
  for (let i = 0; i < 60 * 4; i++) stepFlight(s, rt, neutralInput(), 1 / 60, []);
  assert.ok(Math.abs(s.roll) < rolled * 0.3, `롤이 ${s.roll.toFixed(2)} 로 남아 있다`);
});

test('큰 dt 에서도 폭발하지 않는다 (탭 복귀 시나리오)', () => {
  const s = createFlightState(0, 300, 0);
  const rt = createRuntime();
  for (let i = 0; i < 40; i++) stepFlight(s, rt, neutralInput(), 0.05, []);
  assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z), 'NaN 발생');
  assert.ok(speedOf(s) <= F.maxSpeed * 1.4, `속도 ${speedOf(s).toFixed(1)} 폭주`);
});

test('고도 3층 경계가 맞다', () => {
  assert.equal(layerOf(10), 'low');
  assert.equal(layerOf(F.midLayerY + 1), 'mid');
  assert.equal(layerOf(F.highLayerY + 1), 'high');
});

test('상승기류 안에서 선회할 수 있다 — 반경이 선회반경보다 커야 한다', () => {
  // 이 불변식이 깨지면 기류를 발견해도 고도를 벌 수 없어 Phase 0 의 핵심이 무너진다.
  const cruise = Math.sqrt((F.thrustForward * F.maxSpeed) / F.dragBase);
  const omega = F.bankTurnFactor * Math.sin(1.3) * (cruise / F.maxSpeed);
  const turnRadius = cruise / omega;
  assert.ok(
    balance.thermals.radius > turnRadius,
    `기류 반경 ${balance.thermals.radius}m 가 선회 반경 ${turnRadius.toFixed(0)}m 보다 작다 — 기류 안에서 돌 수 없다`,
  );
});

test('기류 안에서 최대뱅크로 선회하면 실제로 고도를 번다', () => {
  const thermals = [{ x: 0, z: 0 }];
  const s = createFlightState(0, 80, 0);
  const rt = createRuntime();
  // 위치를 고정하지 않는다 — 실제로 원을 그리며 기류 안에 머무는지 본다
  const cmd = { ...neutralInput(), roll: 1 };
  const start = s.y;
  for (let i = 0; i < 60 * 20; i++) stepFlight(s, rt, cmd, 1 / 60, thermals);
  assert.ok(
    s.y > start,
    `20초 선회 후 고도가 ${start} → ${s.y.toFixed(1)} 로 오히려 떨어졌다`,
  );
});
