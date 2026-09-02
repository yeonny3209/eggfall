/**
 * 입력 → FlightInput 변환
 *
 * 조작은 기획서 §8.1 을 따른다. Phase 0 에 해당하는 것만 구현한다.
 *   Shift  대시 / 급강하
 *   Space  날갯짓 상승
 *   Q/E    롤
 *   W/S    피치 (기수 내림/올림)
 *   A/D    요
 * 마우스는 Phase 3(전투)에서 조준으로 쓸 것이므로 지금은 시점 보조만 맡긴다.
 */

import type { FlightInput } from '../types';

export class InputSource {
  private keys = new Set<string>();
  private target: HTMLElement | Window;
  /** 마우스로 카메라를 돌린 양 (rad). 비행 자세와는 분리한다. */
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
    this.lookPitch -= e.movementY * 0.0018;
    this.lookPitch = Math.max(-1.1, Math.min(1.1, this.lookPitch));
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
    const up = this.held('KeyW', 'ArrowUp');
    const down = this.held('KeyS', 'ArrowDown');
    const left = this.held('KeyA', 'ArrowLeft');
    const right = this.held('KeyD', 'ArrowRight');
    const rollL = this.held('KeyQ');
    const rollR = this.held('KeyE');

    return {
      // W = 기수 내림(하강·가속), S = 기수 올림. 비행 시뮬레이션 관례를 따른다.
      pitch: (down ? 1 : 0) + (up ? -1 : 0),
      yaw: (left ? -1 : 0) + (right ? 1 : 0),
      roll: (rollL ? -1 : 0) + (rollR ? 1 : 0),
      flap: this.held('Space'),
      dive: this.held('ShiftLeft', 'ShiftRight'),
    };
  }

  /** 시점 리셋 등 일회성 키 확인용 */
  consume(code: string): boolean {
    if (this.keys.has(code)) {
      this.keys.delete(code);
      return true;
    }
    return false;
  }
}

const GAME_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE',
  'Space', 'ShiftLeft', 'ShiftRight',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);
