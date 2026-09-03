/**
 * EGGFALL 게임 서버
 *
 * 실행: npm run server
 * 기본 포트 2567. PORT 환경변수로 바꿀 수 있다.
 *
 * GitHub Pages 는 정적 호스팅이라 이 서버를 띄울 수 없다.
 * 배포하려면 Node 프로세스를 돌릴 수 있는 곳(Render / Railway / Fly.io 등)이 필요하고,
 * 클라이언트는 VITE_SERVER_URL 로 그 주소를 받는다.
 * 주소가 없으면 클라이언트는 자동으로 싱글플레이로 떨어진다.
 */

import { createServer } from 'http';
import { Server } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { WorldRoom } from './WorldRoom';
import { ROOM_NAME, MAX_CLIENTS, TICK_RATE } from '../src/net/protocol';

const port = Number(process.env.PORT ?? 2567);

const gameServer = new Server({
  transport: new WebSocketTransport({ server: createServer() }),
});

gameServer.define(ROOM_NAME, WorldRoom);

gameServer
  .listen(port)
  .then(() => {
    console.log(`[EGGFALL] 서버 시작 — ws://localhost:${port}`);
    console.log(`[EGGFALL] 방 "${ROOM_NAME}" · 최대 ${MAX_CLIENTS}인 · ${TICK_RATE}Hz`);
  })
  .catch((err) => {
    console.error('[EGGFALL] 서버 시작 실패:', err);
    process.exit(1);
  });
