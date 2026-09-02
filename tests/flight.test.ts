/**
 * 비행 시뮬레이션 테스트 — 단순 조작 모델
 *
 * 마우스가 보는 방향이 곧 비행 방향, WASD 는 그 기준 이동, Space/Shift 는 상승/하강.
 * 스태미나·실속·상승기류는 없다.
 *
 * 실행: npx tsx --test tests/flight.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFlightState,
  neutralInput,
  stepFlight,
  forwardVector,
  layerOf,
} from '../src/flight/simulate.ts';
import type { FlightInput } from '../src/types.ts';
import balance from '../src/data/balance.json' with { type: 'json' };
import { terrainHeight, TERRAIN_MIN, TERRAIN_MAX } from '../src/world/terrain.ts';

const F = balance.flight;

/** n초간 시뮬레이션을 돌리고 최종 상태를 돌려준다. lookYaw/lookPitch 는 기본적으로 state 와 같게 둔다(즉시 그 방향을 보고 있다고 가정). */
function fly(
  seconds: number,
  input: Partial<FlightInput> = {},
  opts: { y0?: number; yaw?: number; pitch?: number; turnRateMult?: number } = {},
) {
  const y0 = opts.y0 ?? 300;
  const yaw = opts.yaw ?? 0;
  const pitch = opts.pitch ?? 0;
  const s = createFlightState(0, y0, 0, yaw);
  s.pitch = pitch;
  const cmd = { ...neutralInput(), ...input };
  const dt = 1 / 60;
  const steps = Math.round(seconds / dt);
  for (let i = 0; i < steps; i++) stepFlight(s, cmd, yaw, pitch, dt, opts.turnRateMult ?? 1);
  return s;
}

const speedOf = (s: { vx: number; vy: number; vz: number }) => Math.hypot(s.vx, s.vy, s.vz);

test('가만히 있으면 제자리에 뜬 채로 머문다 — 스태미나가 없으니 떨어지지 않는다', () => {
  const s = fly(3, {}, { y0: 300 });
  assert.ok(Math.abs(s.y - 300) < 0.5, `입력 없이 3초 뒤 고도가 ${s.y.toFixed(1)} 로 변했다`);
  assert.ok(speedOf(s) < 0.5, `입력 없는데 속도가 ${speedOf(s).toFixed(1)} 남아있다`);
});

test('W 를 누르면 보는 방향으로 전진한다', () => {
  const s = fly(3, { forward: 1 }, { yaw: 0, y0: 300 });
  // yaw=0 이면 정면은 +z
  assert.ok(s.z > 50, `3초간 전진했는데 z가 ${s.z.toFixed(1)} 밖에 안 나갔다`);
  assert.ok(Math.abs(s.x) < 1, `전진만 했는데 x가 ${s.x.toFixed(1)} 로 틀어졌다`);
});

test('S 를 누르면 반대 방향으로 후진한다', () => {
  const s = fly(2, { forward: -1 }, { yaw: 0, y0: 300 });
  assert.ok(s.z < -20, `후진했는데 z가 ${s.z.toFixed(1)}`);
});

test('시선이 다른 방향이면 그쪽으로 전진한다 — 마우스 방향 = 비행 방향', () => {
  const s = fly(3, { forward: 1 }, { yaw: Math.PI / 2, y0: 300 });
  // yaw=90도 방향은 +x
  assert.ok(s.x > 50, `90도 방향을 보고 전진했는데 x가 ${s.x.toFixed(1)}`);
  assert.ok(Math.abs(s.z) < 5, `x쪽으로만 가야 하는데 z가 ${s.z.toFixed(1)}`);
});

test('위를 보고 전진하면 고도가 오른다', () => {
  const s = fly(3, { forward: 1 }, { yaw: 0, pitch: 0.5, y0: 300 });
  assert.ok(s.y > 320, `위를 보고 전진했는데 고도가 ${s.y.toFixed(1)} 로 거의 그대로다`);
});

test('A/D 는 시선과 무관하게 수평으로만 이동한다 (피치를 올려다봐도 안 뜬다)', () => {
  const s = fly(3, { strafe: 1 }, { yaw: 0, pitch: 0.6, y0: 300 });
  assert.ok(Math.abs(s.y - 300) < 1, `strafe 만 했는데 고도가 ${s.y.toFixed(1)} 로 변했다`);
  assert.ok(Math.abs(s.x) > 40, `옆으로 이동했는데 x가 ${s.x.toFixed(1)}`);
});

test('Space 를 누르면 시선 방향과 무관하게 상승한다', () => {
  const s = fly(2, { ascend: true }, { yaw: 0, pitch: -0.4, y0: 300 }); // 아래를 보고 있어도
  assert.ok(s.y > 330, `Space 를 눌렀는데 고도가 ${s.y.toFixed(1)} 밖에 안 올랐다`);
});

test('Shift 를 누르면 하강한다', () => {
  const s = fly(2, { descend: true }, { y0: 300 });
  assert.ok(s.y < 270, `Shift 를 눌렀는데 고도가 ${s.y.toFixed(1)}`);
});

test('Space 와 Shift 를 동시에 누르면 서로 상쇄된다', () => {
  const s = fly(2, { ascend: true, descend: true }, { y0: 300 });
  assert.ok(Math.abs(s.y - 300) < 1, `동시 입력인데 고도가 ${s.y.toFixed(1)} 로 변했다`);
});

test('무제한 상승이 가능하다 — 실속·스태미나 없음', () => {
  const s = fly(20, { ascend: true }, { y0: 300 });
  assert.ok(s.y > 800, `20초 상승했는데 고도가 겨우 ${s.y.toFixed(1)}`);
});

test('속도는 목표치로 수렴하지, 순간이동하지 않는다 (부드러운 가속)', () => {
  const s0 = createFlightState(0, 300, 0, 0);
  const cmd = { ...neutralInput(), forward: 1 };
  stepFlight(s0, cmd, 0, 0, 1 / 60);
  assert.ok(speedOf(s0) < F.moveSpeed * 0.5, `한 프레임 만에 속도가 ${speedOf(s0).toFixed(1)} 로 거의 최고 속도`);

  const s1 = fly(2, { forward: 1 });
  assert.ok(Math.abs(speedOf(s1) - F.moveSpeed) < 1, `2초 후 속도 ${speedOf(s1).toFixed(1)} 가 목표 ${F.moveSpeed} 에 못 미친다`);
});

test('대각선(전진+좌우)이 지나치게 빨라지지 않는다', () => {
  const straight = fly(2, { forward: 1 });
  const diag = fly(2, { forward: 1, strafe: 1 });
  assert.ok(
    speedOf(diag) <= speedOf(straight) * 1.5 + 1,
    `대각 이동 속도 ${speedOf(diag).toFixed(1)} 가 직선 ${speedOf(straight).toFixed(1)} 보다 과하게 빠르다`,
  );
});

test('큰 용일수록 마우스 시점 추적이 느리다 (§6.3 불변 규칙)', () => {
  const turn = (mult: number) => {
    const s = createFlightState(0, 300, 0, 0);
    // 목표 시점을 90도로 갑자기 튼다
    for (let i = 0; i < 30; i++) stepFlight(s, neutralInput(), Math.PI / 2, 0, 1 / 60, mult);
    return s.yaw;
  };
  const small = turn(balance.stage['1'].turnPenalty);
  const big = turn(balance.stage['6'].turnPenalty);
  assert.ok(small > big, `작은 용 ${small.toFixed(2)} 이 큰 용 ${big.toFixed(2)} 보다 안 빠르다`);
});

test('시점은 최단 경로로 회전한다 (359도 → 1도는 -358도가 아니라 +2도)', () => {
  const s = createFlightState(0, 300, 0, -0.02); // 약 -1도
  const targetYaw = 0.02; // 약 +1도, 최단 경로로 2도만 돌면 된다
  for (let i = 0; i < 3; i++) stepFlight(s, neutralInput(), targetYaw, 0, 1 / 60);
  assert.ok(Math.abs(s.yaw - targetYaw) < 0.5, `최단 경로로 안 돌고 ${s.yaw.toFixed(2)} 에 있다`);
});

test('지면에 닿으면 착지하고, 실제 지형 높이를 따른다', () => {
  const s = fly(60, { descend: true }, { y0: 200 });
  assert.equal(s.grounded, true, '60초간 하강했는데 착지하지 않았다');
  assert.ok(
    Math.abs(s.y - terrainHeight(s.x, s.z)) < 0.001,
    `착지 고도 ${s.y.toFixed(2)} 가 지형 높이 ${terrainHeight(s.x, s.z).toFixed(2)} 와 다르다`,
  );
});

test('착지 후 Space 로 다시 뜰 수 있다', () => {
  const s = fly(60, { descend: true }, { y0: 200 });
  assert.equal(s.grounded, true);
  const cmd = { ...neutralInput(), ascend: true };
  for (let i = 0; i < 30; i++) stepFlight(s, cmd, 0, 0, 1 / 60);
  assert.equal(s.grounded, false, '이륙하지 못했다');
});

test('지형 아래로는 뚫고 내려가지 않는다', () => {
  const s = fly(120, { descend: true }, { y0: 500 });
  assert.ok(s.y >= terrainHeight(s.x, s.z) - 0.001, `지형을 뚫고 ${s.y.toFixed(1)} 까지 내려갔다`);
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

test('큰 dt 에서도 폭발하지 않는다 (탭 복귀 시나리오)', () => {
  const s = createFlightState(0, 300, 0, 0);
  const cmd = { ...neutralInput(), forward: 1, ascend: true };
  for (let i = 0; i < 20; i++) stepFlight(s, cmd, 0.3, 0.1, 0.25);
  assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.z), 'NaN 발생');
  assert.ok(speedOf(s) <= F.moveSpeed * 2 + F.verticalSpeed, `속도 ${speedOf(s).toFixed(1)} 폭주`);
});

test('forwardVector 는 단위 벡터를 낸다', () => {
  for (const [pitch, yaw] of [[0, 0], [0.4, 1.2], [-0.7, -2.1]] as const) {
    const v = forwardVector(pitch, yaw);
    const len = Math.hypot(v.x, v.y, v.z);
    assert.ok(Math.abs(len - 1) < 1e-9, `길이 ${len} (pitch=${pitch}, yaw=${yaw})`);
  }
});

test('고도 3층 경계가 맞다', () => {
  assert.equal(layerOf(10), 'low');
  assert.equal(layerOf(F.midLayerY + 1), 'mid');
  assert.equal(layerOf(F.highLayerY + 1), 'high');
});
