/**
 * 입력 → FlightInput 변환
 *
 * 단순화된 조작 (스펙테이터 캠 모델):
 *   마우스   시점 회전 — 보는 방향이 곧 비행 방향
 *   W/S      보는 방향 기준 전진/후진
 *   A/D      보는 방향 기준 좌우 이동
 *   Space    누르는 동안 상승
 *   Shift    누르는 동안 하강
 *
 * 롤·피치·요를 따로 조작하던 예전 방식보다 훨씬 직관적이다:
 * "보고 싶은 곳을 보면 그쪽으로 간다" 하나의 규칙뿐이다.
 */

import type { FlightInput } from '../types';

export class InputSource {
  private keys = new Set<string>();
  private target: HTMLElement | Window;
  /** 마우스가 누적해 온 목표 시점 (rad) — 이게 곧 비행 방향이 된다 */
  lookYaw = 0;
  lookPitch = 0;
  private pointerLocked = false;

  constructor(target: HTMLElement | Window = window) {
    this.target = target;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onLockChange);
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onLockChange);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // 게임이 쓰는 키만 브라우저 기본 동작을 막는다 (Space 스크롤 등)
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    this.keys.add(e.code);
  };
  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
  };
  /** 탭 전환 중 눌린 키가 남아 계속 조작되는 것을 막는다 */
  private onBlur = () => this.keys.clear();

  private onLockChange = () => {
    this.pointerLocked = document.pointerLockElement !== null;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.pointerLocked) return;
    this.lookYaw -= e.movementX * 0.0022;
    // 위아래로 완전히 뒤집히면(±90도) 정면 벡터가 반전돼 조작이 뒤집힌다. 여유를 두고 클램프한다.
    this.lookPitch -= e.movementY * 0.0018;
    this.lookPitch = Math.max(-1.5, Math.min(1.5, this.lookPitch));
  };

  requestPointerLock() {
    const el = this.target as HTMLElement;
    if (el && 'requestPointerLock' in el) el.requestPointerLock();
  }

  private held(...codes: string[]): boolean {
    for (const c of codes) if (this.keys.has(c)) return true;
    return false;
  }

  read(): FlightInput {
    const fwd = this.held('KeyW', 'ArrowUp');
    const back = this.held('KeyS', 'ArrowDown');
    const left = this.held('KeyA', 'ArrowLeft');
    const right = this.held('KeyD', 'ArrowRight');

    return {
      forward: (fwd ? 1 : 0) + (back ? -1 : 0),
      strafe: (right ? 1 : 0) + (left ? -1 : 0),
      ascend: this.held('Space'),
      descend: this.held('ShiftLeft', 'ShiftRight'),
    };
  }
}

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'Space', 'ShiftLeft', 'ShiftRight',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);
