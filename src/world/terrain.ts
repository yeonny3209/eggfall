/**
 * 지형 높이 — 단일 진실 공급원
 *
 * 렌더 메시 · 충돌 · 그림자가 각자 다른 지형을 쓰면 반드시 어긋난다.
 * (실제로 어긋났다: 그림자가 평면 y=0 에 붙어 지형 위 47m 를 떠다녔고,
 *  드래곤은 언덕을 뚫고 지나갔다.)
 *
 * 순수 함수이므로 Three.js 도 필요 없고, 나중에 서버가 그대로 쓸 수 있다 (§13.3).
 */

/** 저주파 언덕 진폭 */
const A1 = 46;
/** 고주파 잔결 진폭 */
const A2 = 13;
/** 골짜기 바닥 높이 — 0 으로 두면 "지면 아래" 라는 애매한 영역이 생긴다 */
const FLOOR = 6;

/** 지형 최저점 (골짜기 바닥) */
export const TERRAIN_MIN = FLOOR;
/** 지형 최고점 (능선) */
export const TERRAIN_MAX = FLOOR + A1 + A2;

/**
 * (x, z) 지점의 지면 높이 (m). 항상 TERRAIN_MIN ~ TERRAIN_MAX 사이.
 * 하층(협곡)의 기복을 만든다 — §9 의 3층 구조에서 가장 아래층이다.
 */
export function terrainHeight(x: number, z: number): number {
  const noise =
    Math.sin(x * 0.0016) * Math.cos(z * 0.0013) * A1 +
    Math.sin(x * 0.0071 + 1.7) * Math.cos(z * 0.0059) * A2;
  // noise 는 -(A1+A2) ~ +(A1+A2). 이를 0~(A1+A2) 로 접어 올린다.
  return FLOOR + (noise + A1 + A2) * 0.5;
}
