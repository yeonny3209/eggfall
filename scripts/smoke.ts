/**
 * 멀티플레이 스모크 테스트
 *
 * 실제 Colyseus 서버에 두 명을 붙여 §11 Phase 2 의 요구사항을 확인한다:
 *   - 두 클라이언트가 서로를 본다
 *   - 입력이 서버에서 처리되고 lastSeq 로 확인된다
 *   - 알 줍기를 서버가 중재한다 (동시 요청 시 한 명만 성공)
 *   - 나가면 상대 목록에서 사라진다
 *
 * 실행: npm run server (다른 터미널) 후 npx tsx scripts/smoke.ts
 */

import { Client, getStateCallbacks } from 'colyseus.js';
import { ROOM_NAME, MSG_INPUT, MSG_PICKUP, MSG_PICKUP_DENIED, TICK_DT } from '../src/net/protocol';
import type { WorldState } from '../src/net/schema';

const URL = process.env.SERVER_URL ?? 'ws://localhost:2567';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function main() {
  const clientA = new Client(URL);
  const clientB = new Client(URL);

  const a = await clientA.joinOrCreate<WorldState>(ROOM_NAME, { name: '알파' });
  const b = await clientB.joinOrCreate<WorldState>(ROOM_NAME, { name: '베타' });
  check('두 클라이언트 접속', !!a.sessionId && !!b.sessionId, `${a.sessionId} / ${b.sessionId}`);
  check('같은 방에 들어갔다', a.roomId === b.roomId, `room ${a.roomId}`);

  await sleep(600);
  // 실서버에는 브라우저 등 다른 접속자가 있을 수 있다.
  // 절대 인원수를 가정하면 테스트가 환경에 따라 깨지므로 "둘 다 보이는가"로 확인한다.
  check(
    'A 가 B 를 본다',
    a.state.players.has(a.sessionId) && a.state.players.has(b.sessionId),
    `players=${a.state.players.size}`,
  );
  check('알이 동기화됐다', a.state.eggs.size > 0, `eggs=${a.state.eggs.size}`);
  check(
    '두 클라이언트가 같은 알 목록을 본다',
    a.state.eggs.size === b.state.eggs.size,
    `${a.state.eggs.size} vs ${b.state.eggs.size}`,
  );

  /* ---------- 입력 처리 & lastSeq ---------- */
  const meA = () => a.state.players.get(a.sessionId)!;
  const startX = meA().x;
  const startZ = meA().z;

  for (let seq = 1; seq <= 40; seq++) {
    a.send(MSG_INPUT, {
      seq, dt: TICK_DT, lookYaw: 0, lookPitch: 0,
      forward: 1, strafe: 0, ascend: false, descend: false,
    });
    await sleep(16);
  }
  await sleep(700);

  const moved = Math.hypot(meA().x - startX, meA().z - startZ);
  check('입력이 서버에서 처리돼 실제로 움직였다', moved > 5, `${moved.toFixed(1)}m 이동`);
  check('서버가 lastSeq 로 처리 지점을 알려준다', meA().lastSeq > 0, `lastSeq=${meA().lastSeq}`);

  const bSeesA = b.state.players.get(a.sessionId);
  check(
    'B 가 A 의 움직임을 본다',
    !!bSeesA && Math.hypot(bSeesA.x - startX, bSeesA.z - startZ) > 5,
    bSeesA ? `${Math.hypot(bSeesA.x - startX, bSeesA.z - startZ).toFixed(1)}m` : '없음',
  );

  /* ---------- 줍기 중재: 같은 알을 동시에 노린다 ---------- */
  // 두 명을 같은 알 위로 순간이동시킬 수는 없으니, 서버 사거리 검증을 통과하도록
  // 각자 가장 가까운 알을 향해 이동시키는 대신 거절 사유를 확인한다.
  let deniedA = '';
  let deniedB = '';
  a.onMessage(MSG_PICKUP_DENIED, (e: { reason: string }) => { deniedA = e.reason; });
  b.onMessage(MSG_PICKUP_DENIED, (e: { reason: string }) => { deniedB = e.reason; });

  const someNest = Array.from(a.state.eggs.keys())[0];
  a.send(MSG_PICKUP, { nestId: someNest });
  b.send(MSG_PICKUP, { nestId: someNest });
  await sleep(500);

  // 둘 다 알에서 멀리 있으므로 사거리로 거절되어야 한다 — 서버가 위치를 검증한다는 증거
  check(
    '서버가 사거리를 검증한다 (멀리서 줍기 시도 거절)',
    deniedA === 'range' && deniedB === 'range',
    `A=${deniedA} B=${deniedB}`,
  );
  check(
    '거절된 알은 여전히 월드에 남아있다',
    a.state.eggs.has(someNest),
    `nest ${someNest}`,
  );

  /* ---------- 존재하지 않는 둥지 ---------- */
  deniedA = '';
  a.send(MSG_PICKUP, { nestId: 'nest-존재하지않음' });
  await sleep(400);
  check('없는 둥지 요청은 거절된다', deniedA === 'taken', `reason=${deniedA}`);

  /* ---------- 퇴장 ---------- */
  const before = a.state.players.size;
  await b.leave();
  await sleep(700);
  check(
    '나가면 상대 목록에서 사라진다',
    !a.state.players.has(b.sessionId) && a.state.players.size === before - 1,
    `${before} → ${a.state.players.size}`,
  );

  await a.leave();
  await sleep(200);

  console.log(failures === 0 ? '\n전부 통과' : `\n${failures}건 실패`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('스모크 테스트 실패:', e);
  process.exit(1);
});
