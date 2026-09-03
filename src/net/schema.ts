/**
 * Colyseus 동기화 스키마 — 서버가 권위를 갖는 상태
 *
 * 여기 있는 것만 자동으로 모든 클라이언트에 전파된다.
 * 대역폭이 곧 비용이므로 "화면에 그려야만 하는 것"만 넣는다.
 * (발현 풀, 특성 목록 같은 건 본인에게만 필요하므로 넣지 않는다.)
 */

import { Schema, MapSchema, type } from '@colyseus/schema';

/** 플레이어 한 명. 위치·자세는 매 틱, 나머지는 바뀔 때만 전송된다. */
export class PlayerState extends Schema {
  @type('string') id = '';
  @type('string') name = '';

  /* ---------- 매 틱 갱신 ---------- */
  @type('float32') x = 0;
  @type('float32') y = 150;
  @type('float32') z = 0;
  @type('float32') yaw = 0;
  @type('float32') pitch = 0;
  /**
   * 속도까지 보내야 보정이 성립한다.
   * 위치만 되감고 로컬 속도로 재생하면, 재생 결과가 원래 예측과 달라져
   * 매 보정마다 화면이 미세하게 튄다. float32 3개(12바이트)면 충분하다.
   */
  @type('float32') vx = 0;
  @type('float32') vy = 0;
  @type('float32') vz = 0;

  /**
   * 이 플레이어의 입력을 어디까지 처리했는지.
   * 클라이언트는 이 값을 보고 "그 이후 입력만 다시 굴린다" — 예측/보정의 핵심.
   */
  @type('uint32') lastSeq = 0;

  /* ---------- 가끔 갱신 ---------- */
  @type('uint8') stage = 1;
  @type('float32') geneMass = 0;

  /** 운반 중인 알의 겉모습. null 대신 빈 문자열로 "안 들고 있음"을 표현한다. */
  @type('string') carriedRarity = '';
  @type('string') carriedElement = '';

  /** 외형 결정용 — 정규화된 친화도 상위 속성 (§6.2) */
  @type('string') tintElement = '';
  @type('float32') tintRatio = 0;
}

/** 월드에 놓인 알 하나. 서버가 스폰과 획득을 모두 중재한다. */
export class EggState extends Schema {
  @type('string') nestId = '';
  @type('float32') x = 0;
  @type('float32') y = 0;
  @type('float32') z = 0;
  @type('string') rarity = 'common';
  @type('string') element = 'ember';
  @type('uint16') geneMass = 0;
}

export class WorldState extends Schema {
  @type({ map: PlayerState }) players = new MapSchema<PlayerState>();
  /** 키는 nestId — 알은 둥지당 하나뿐이라 그게 곧 고유 키다 */
  @type({ map: EggState }) eggs = new MapSchema<EggState>();
  /** 서버 시각 (ms). 클라이언트가 시계 오차를 재는 데 쓴다. */
  @type('float64') serverTime = 0;
}
