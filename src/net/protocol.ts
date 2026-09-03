/**
 * 넷코드 프로토콜 — 클라이언트와 서버가 공유하는 유일한 계약
 *
 * 기획서 §13.2 "타입을 먼저 고정" 을 넷코드에도 적용한다.
 * 이 파일에 없는 메시지는 존재하지 않는다.
 *
 * Three.js 도 Colyseus 도 import 하지 않는다. 양쪽에서 안전하게 읽을 수 있어야 한다.
 */

import type { Element, FlightInput, Rarity, Stage } from '../types';

/** 서버 시뮬레이션 주기. 클라이언트 예측도 반드시 같은 값을 써야 한다. */
export const TICK_RATE = 20;
export const TICK_DT = 1 / TICK_RATE;

/** 한 방의 최대 인원 (§0 샤드당 30~60명이 목표지만 Phase 2 는 8인 안정화가 과제다) */
export const MAX_CLIENTS = 8;

/** 방 이름 — 클라이언트와 서버가 같은 문자열을 써야 join 이 된다 */
export const ROOM_NAME = 'world';

/* ==========================================================================
   클라이언트 → 서버
   ========================================================================== */

export const MSG_INPUT = 'i';
export const MSG_PICKUP = 'p';
export const MSG_DROP = 'd';

/**
 * 입력 한 묶음. seq 가 예측/보정의 핵심이다:
 * 서버가 "seq 42 까지 처리했다" 고 알려주면 클라이언트는 43번부터 다시 굴린다.
 */
export type InputCommand = {
  /** 단조 증가 시퀀스 번호 */
  seq: number;
  /** 이 입력을 몇 초 동안 적용할지 */
  dt: number;
  /** 마우스가 정한 목표 시점 */
  lookYaw: number;
  lookPitch: number;
  /** 이동 입력 (interact 는 별도 메시지로 보낸다 — 신뢰성이 필요하므로) */
  forward: number;
  strafe: number;
  ascend: boolean;
  descend: boolean;
};

export function toCommand(seq: number, dt: number, input: FlightInput, lookYaw: number, lookPitch: number): InputCommand {
  return {
    seq,
    dt,
    lookYaw,
    lookPitch,
    forward: input.forward,
    strafe: input.strafe,
    ascend: input.ascend,
    descend: input.descend,
  };
}

/** InputCommand 를 시뮬레이션이 먹는 FlightInput 으로 되돌린다 */
export function toFlightInput(c: InputCommand): FlightInput {
  return {
    forward: c.forward,
    strafe: c.strafe,
    ascend: c.ascend,
    descend: c.descend,
    // 상호작용은 입력 스트림이 아니라 별도 메시지로 처리한다.
    // 예측 재생 중에 알을 다시 줍는 일이 생기면 안 되기 때문이다.
    interact: false,
  };
}

/** 줍기 요청 — 어느 둥지인지 서버가 검증한다 */
export type PickupRequest = { nestId: string };

/* ==========================================================================
   서버 → 클라이언트 (Schema 로 동기화되지 않는 일회성 이벤트)
   ========================================================================== */

export const MSG_ABSORBED = 'a';
export const MSG_PICKUP_DENIED = 'x';

/** 흡수 성공 알림 */
export type AbsorbedEvent = {
  gained: number;
  leveledUp: boolean;
  toStage: Stage;
  element: Element;
  rarity: Rarity;
};

/** 줍기 거절 — 남이 먼저 가져갔거나 사거리 밖이다 */
export type PickupDeniedEvent = {
  reason: 'taken' | 'range' | 'full';
};

/* ==========================================================================
   보간 · 예측 상수
   ========================================================================== */

/**
 * 원격 플레이어를 얼마나 과거로 그릴지 (초).
 * 스냅샷 사이를 보간하려면 최소 두 개가 쌓여 있어야 하므로 틱 간격의 2배 이상이어야 한다.
 * 짧으면 끊기고, 길면 남이 실제보다 뒤처져 보인다.
 */
export const INTERP_DELAY = TICK_DT * 2.5;

/**
 * 서버 위치와 예측 위치가 이 이상 벌어지면 부드럽게 당기지 않고 즉시 스냅한다.
 * 텔레포트·리스폰·긴 렉 후 복구용.
 */
export const SNAP_DISTANCE = 60;

/** 예측 오차를 초당 이 비율로 흡수한다 (부드러운 보정) */
export const RECONCILE_RATE = 12;
