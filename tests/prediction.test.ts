/**
 * 예측 · 보정 · 보간 테스트 (기획서 §11 Phase 2 "예측/보정")
 *
 * 넷코드는 눈으로 확인하기가 가장 어려운 영역이다. 렉이 없을 때는 버그가 안 보이고,
 * 렉이 있을 때는 뭐가 문제인지 구분이 안 된다. 그래서 순수 함수로 떼어내
 * 지연·패킷 손실을 시뮬레이션하며 검증한다.
 *
 * 실행: npx tsx --test tests/prediction.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPrediction,
  recordInput,
  nextSeq,
  reconcile,
  decayError,
  InterpBuffer,
  shortestAngle,
} from '../src/net/prediction.ts';
import { toCommand, toFlightInput, TICK_DT, SNAP_DISTANCE } from '../src/net/protocol.ts';
import { createFlightState, stepFlight, neutralInput } from '../src/flight/simulate.ts';
import type { FlightInput, FlightState } from '../src/types.ts';

function cmdOf(seq: number, input: Partial<FlightInput>, dt = TICK_DT) {
  return toCommand(seq, dt, { ...neutralInput(), ...input }, 0, 0);
}

const posOf = (s: FlightState) => ({ x: s.x, y: s.y, z: s.z });
/** 서버 상태 전체를 스냅샷으로 (위치·속도·자세) */
const snapOf = (s: FlightState, lastSeq: number) => ({
  x: s.x, y: s.y, z: s.z,
  vx: s.vx, vy: s.vy, vz: s.vz,
  yaw: s.yaw, pitch: s.pitch,
  lastSeq,
});
const dist = (a: FlightState, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/* ==========================================================================
   시퀀스 관리
   ========================================================================== */

test('시퀀스는 1부터 단조 증가한다', () => {
  const p = createPrediction();
  assert.equal(nextSeq(p), 1);
  assert.equal(nextSeq(p), 2);
  assert.equal(nextSeq(p), 3);
});

test('서버가 확인한 입력은 대기열에서 빠진다', () => {
  const p = createPrediction();
  const s = createFlightState(0, 200, 0);
  for (let i = 1; i <= 5; i++) recordInput(p, cmdOf(i, { forward: 1 }));
  assert.equal(p.pending.length, 5);

  reconcile(s, p, snapOf(createFlightState(0, 200, 0), 3));
  assert.equal(p.pending.length, 2, '3번까지 확인했으면 4,5번만 남아야 한다');
  assert.equal(p.pending[0].seq, 4);
});

test('대기열은 무한정 자라지 않는다 — 서버가 죽어도 메모리는 새면 안 된다', () => {
  const p = createPrediction();
  for (let i = 1; i <= 1000; i++) recordInput(p, cmdOf(i, { forward: 1 }));
  assert.ok(p.pending.length <= 240, `대기열이 ${p.pending.length} 까지 자랐다`);
});

/* ==========================================================================
   예측이 서버와 일치하는가 — 넷코드의 근본 전제
   ========================================================================== */

test('지연이 없으면 예측과 서버 결과가 정확히 같다', () => {
  // 서버와 클라이언트가 같은 stepFlight 를 돌리므로 결과가 같아야 한다.
  // 이게 깨지면 예측 자체가 성립하지 않는다 (§13.3 이 회수되는 지점).
  const server = createFlightState(0, 200, 0);
  const client = createFlightState(0, 200, 0);
  const p = createPrediction();

  for (let i = 1; i <= 30; i++) {
    const c = cmdOf(i, { forward: 1, strafe: 0.5 });
    recordInput(p, c);
    // 클라이언트 예측
    stepFlight(client, toFlightInput(c), c.lookYaw, c.lookPitch, c.dt);
    // 서버도 같은 입력을 처리
    stepFlight(server, toFlightInput(c), c.lookYaw, c.lookPitch, c.dt);
  }

  assert.ok(dist(client, posOf(server)) < 1e-9, `예측이 ${dist(client, posOf(server))} 만큼 어긋났다`);
});

test('보정 후에도 예측 결과가 유지된다 — 지연이 있어도 위치가 튀지 않는다', () => {
  const server = createFlightState(0, 200, 0);
  const client = createFlightState(0, 200, 0);
  const p = createPrediction();
  const sent: ReturnType<typeof cmdOf>[] = [];

  // 클라이언트는 30틱 앞서 나간다 (서버 응답이 아직 안 옴)
  for (let i = 1; i <= 30; i++) {
    const c = cmdOf(i, { forward: 1 });
    recordInput(p, c);
    sent.push(c);
    stepFlight(client, toFlightInput(c), c.lookYaw, c.lookPitch, c.dt);
  }
  const predicted = posOf(client);

  // 서버는 이제 10번까지 처리했다
  for (let i = 0; i < 10; i++) {
    const c = sent[i];
    stepFlight(server, toFlightInput(c), c.lookYaw, c.lookPitch, c.dt);
  }
  reconcile(client, p, snapOf(server, 10));

  // 되감고 11~30 을 재생했으므로 원래 예측과 같은 자리에 있어야 한다
  assert.ok(
    dist(client, predicted) < 1e-6,
    `보정 후 ${dist(client, predicted).toFixed(4)} 만큼 튀었다`,
  );
  assert.ok(Math.abs(p.errX) < 1e-6, '어긋나지 않았는데 오차가 남았다');
});

test('서버와 예측이 다르면 서버가 이긴다', () => {
  const client = createFlightState(0, 200, 0);
  const p = createPrediction();
  for (let i = 1; i <= 5; i++) {
    const c = cmdOf(i, { forward: 1 });
    recordInput(p, c);
    stepFlight(client, toFlightInput(c), c.lookYaw, c.lookPitch, c.dt);
  }

  // 서버가 전혀 다른 곳을 권위로 제시한다 (예: 밀려남)
  reconcile(client, p, { ...snapOf(client, 5), x: 500, y: 200, z: 500 });
  // 미처리 입력이 없으니 서버 위치 그대로여야 한다
  assert.ok(Math.abs(client.x - 500) < 1e-9, `x=${client.x}`);
  assert.ok(Math.abs(client.z - 500) < 1e-9, `z=${client.z}`);
});

test('작은 오차는 화면에서 서서히 흡수된다', () => {
  const client = createFlightState(0, 200, 0);
  const p = createPrediction();
  const c = cmdOf(1, { forward: 1 });
  recordInput(p, c);
  stepFlight(client, toFlightInput(c), c.lookYaw, c.lookPitch, c.dt);

  // 서버가 조금 다른 위치를 준다 (5m)
  reconcile(client, p, { ...snapOf(client, 1), x: client.x + 5 });
  const err0 = Math.hypot(p.errX, p.errY, p.errZ);
  assert.ok(err0 > 0.1, `오차가 기록되지 않았다: ${err0}`);

  // 시간이 지나면 0으로 수렴한다
  for (let i = 0; i < 120; i++) decayError(p, 1 / 60);
  assert.equal(p.errX, 0);
  assert.equal(p.errY, 0);
  assert.equal(p.errZ, 0);
});

test('큰 차이는 부드럽게 당기지 않고 즉시 스냅한다 (텔레포트·긴 렉)', () => {
  const client = createFlightState(0, 200, 0);
  const p = createPrediction();
  reconcile(client, p, { ...snapOf(client, 0), x: SNAP_DISTANCE + 100 });
  assert.equal(p.errX, 0, '큰 차이인데 부드럽게 당기려 하고 있다');
  assert.ok(Math.abs(client.x - (SNAP_DISTANCE + 100)) < 1e-9);
});

test('패킷이 유실돼 서버가 뒤처져도 예측은 계속 앞서간다', () => {
  const client = createFlightState(0, 200, 0);
  const p = createPrediction();
  const server = createFlightState(0, 200, 0);

  // 60틱 보내는데 서버는 20번까지만 받았다
  const sent: ReturnType<typeof cmdOf>[] = [];
  for (let i = 1; i <= 60; i++) {
    const c = cmdOf(i, { forward: 1 });
    recordInput(p, c);
    sent.push(c);
    stepFlight(client, toFlightInput(c), c.lookYaw, c.lookPitch, c.dt);
  }
  for (let i = 0; i < 20; i++) {
    const c = sent[i];
    stepFlight(server, toFlightInput(c), c.lookYaw, c.lookPitch, c.dt);
  }

  const beforeZ = client.z;
  reconcile(client, p, snapOf(server, 20));
  assert.ok(client.z > server.z, '보정 후 클라이언트가 서버보다 앞서 있어야 한다');
  assert.ok(Math.abs(client.z - beforeZ) < 1e-6, '보정으로 위치가 되돌아갔다');
});

/* ==========================================================================
   보간
   ========================================================================== */

test('스냅샷이 없으면 null', () => {
  assert.equal(new InterpBuffer().sample(0), null);
});

test('스냅샷 하나면 그대로 돌려준다', () => {
  const b = new InterpBuffer();
  b.push({ t: 1, x: 10, y: 20, z: 30, yaw: 0, pitch: 0 });
  assert.equal(b.sample(5)!.x, 10);
});

test('두 스냅샷 사이를 선형 보간한다', () => {
  const b = new InterpBuffer();
  b.push({ t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  b.push({ t: 1, x: 100, y: 50, z: -20, yaw: 0, pitch: 0 });

  const mid = b.sample(0.5)!;
  assert.ok(Math.abs(mid.x - 50) < 1e-9, `x=${mid.x}`);
  assert.ok(Math.abs(mid.y - 25) < 1e-9);
  assert.ok(Math.abs(mid.z - -10) < 1e-9);
});

test('버퍼보다 미래를 요청하면 마지막 값을 붙든다 — 외삽하지 않는다', () => {
  // 외삽으로 맞추려다 틀리면 캐릭터가 벽을 뚫고 되돌아온다. 늦는 게 낫다.
  const b = new InterpBuffer();
  b.push({ t: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  b.push({ t: 1, x: 100, y: 0, z: 0, yaw: 0, pitch: 0 });
  assert.equal(b.sample(99)!.x, 100);
});

test('시각이 역행하는 스냅샷은 버린다 (재연결·순서 뒤바뀜)', () => {
  const b = new InterpBuffer();
  b.push({ t: 5, x: 0, y: 0, z: 0, yaw: 0, pitch: 0 });
  b.push({ t: 3, x: 999, y: 0, z: 0, yaw: 0, pitch: 0 });
  assert.equal(b.size, 1, '과거 스냅샷이 들어갔다');
});

test('버퍼는 상한을 넘지 않는다', () => {
  const b = new InterpBuffer();
  for (let i = 0; i < 500; i++) b.push({ t: i, x: i, y: 0, z: 0, yaw: 0, pitch: 0 });
  assert.ok(b.size <= 32, `버퍼가 ${b.size} 까지 자랐다`);
});

test('prune 후에도 보간에 필요한 스냅샷은 남는다', () => {
  const b = new InterpBuffer();
  for (let i = 0; i <= 10; i++) b.push({ t: i, x: i * 10, y: 0, z: 0, yaw: 0, pitch: 0 });
  b.prune(8);
  const s = b.sample(8.5)!;
  assert.ok(Math.abs(s.x - 85) < 1e-9, `prune 후 보간이 깨졌다: x=${s.x}`);
});

test('각도는 최단 경로로 보간한다 (359도 → 1도)', () => {
  const b = new InterpBuffer();
  const almostFull = Math.PI * 2 - 0.05;
  b.push({ t: 0, x: 0, y: 0, z: 0, yaw: almostFull, pitch: 0 });
  b.push({ t: 1, x: 0, y: 0, z: 0, yaw: 0.05, pitch: 0 });

  const mid = b.sample(0.5)!;
  // 최단 경로면 2PI 부근(=0 부근)을 지나야 한다. 반대로 돌면 PI 근처가 나온다.
  const distToWrap = Math.min(
    Math.abs(mid.yaw - Math.PI * 2),
    Math.abs(mid.yaw),
  );
  assert.ok(distToWrap < 0.1, `먼 길로 돌았다: yaw=${mid.yaw.toFixed(3)}`);
});

test('shortestAngle 은 항상 -PI~PI 안이다', () => {
  for (let i = 0; i < 200; i++) {
    const a = (Math.random() - 0.5) * 20;
    const b = (Math.random() - 0.5) * 20;
    const d = shortestAngle(a, b);
    assert.ok(d >= -Math.PI - 1e-9 && d <= Math.PI + 1e-9, `${d}`);
  }
});

/* ==========================================================================
   통합: 지연 있는 왕복을 흉내낸다
   ========================================================================== */

test('100ms 지연에서도 예측 위치가 서버보다 앞서고, 보정으로 발산하지 않는다', () => {
  const LATENCY_TICKS = 6; // 약 100ms
  const client = createFlightState(0, 200, 0);
  const server = createFlightState(0, 200, 0);
  const p = createPrediction();

  const inFlight: ReturnType<typeof cmdOf>[] = [];
  let serverLastSeq = 0;
  let maxError = 0;

  for (let tick = 1; tick <= 300; tick++) {
    // 클라이언트: 입력 생성 + 즉시 예측
    const c = cmdOf(nextSeq(p), { forward: 1, strafe: Math.sin(tick / 20) });
    recordInput(p, c);
    inFlight.push(c);
    stepFlight(client, toFlightInput(c), c.lookYaw, c.lookPitch, c.dt);

    // 서버: 지연만큼 늦게 도착한 입력을 처리
    if (inFlight.length > LATENCY_TICKS) {
      const arrived = inFlight.shift()!;
      stepFlight(server, toFlightInput(arrived), arrived.lookYaw, arrived.lookPitch, arrived.dt);
      serverLastSeq = arrived.seq;
    }

    // 클라이언트: 서버 상태를 받아 보정
    const err = reconcile(client, p, snapOf(server, serverLastSeq));
    maxError = Math.max(maxError, err);
    decayError(p, TICK_DT);
  }

  // 예측이 정확하므로 보정 때마다 위치가 튀지 않아야 한다
  assert.ok(maxError < 0.01, `보정 튐이 ${maxError.toFixed(3)}m 까지 났다`);
  // 클라이언트가 서버보다 지연 시간만큼 앞서 있어야 한다
  assert.ok(client.z > server.z, '예측이 서버보다 앞서지 않는다');
  assert.ok(Number.isFinite(client.x) && Number.isFinite(client.z), 'NaN 발생');
});
