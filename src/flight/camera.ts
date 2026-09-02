/**
 * 추적 카메라
 *
 * 스펙테이터 캠 모델에서는 state.yaw/pitch 가 곧 "보는 방향"이므로
 * 카메라는 그 방향의 뒤쪽에 붙어 따라가기만 하면 된다 — 예전처럼 비행 자세 위에
 * 마우스 시점을 따로 얹는 계산이 필요 없다.
 *
 * 남겨둔 규칙 둘:
 *   1. 즉시 따라붙지 않는다 → 관성이 보인다
 *   2. 빠를수록 살짝 뒤로 물러나고 FOV 가 넓어진다 → 속도가 몸으로 읽힌다
 */

import * as THREE from 'three';
import type { FlightState } from '../types';
import balance from '../data/balance.json';
import { terrainHeight } from '../world/terrain';

const F = balance.flight;

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;
  private pos = new THREE.Vector3(0, 130, 40);
  private look = new THREE.Vector3();
  private curFov = F.cameraFovBase;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(F.cameraFovBase, aspect, 0.5, 6000);
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(s: FlightState, dt: number) {
    const speed = Math.hypot(s.vx, s.vy, s.vz);
    const speedRatio = Math.min(1, speed / F.moveSpeed);

    const dist = F.cameraDistance * (1 + speedRatio * F.cameraSpeedPullback * 10);

    const back = new THREE.Vector3(
      -Math.sin(s.yaw) * Math.cos(s.pitch),
      -Math.sin(s.pitch),
      -Math.cos(s.yaw) * Math.cos(s.pitch),
    );

    const target = new THREE.Vector3(s.x, s.y, s.z)
      .add(back.multiplyScalar(dist))
      .add(new THREE.Vector3(0, F.cameraHeight, 0));

    // 지연 추적 — 관성이 보이게
    const k = 1 - Math.exp(-F.cameraLag * dt);
    this.pos.lerp(target, k);

    // 지면 뚫림 방지 — 고정 높이로 두면 능선을 그대로 통과한다
    const camGround = terrainHeight(this.pos.x, this.pos.z) + 3;
    if (this.pos.y < camGround) this.pos.y = camGround;

    this.camera.position.copy(this.pos);

    this.look.lerp(new THREE.Vector3(s.x, s.y + 1.5, s.z), Math.min(1, 12 * dt));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);

    // FOV — 속도가 붙으면 시야가 넓어진다
    const wantFov = F.cameraFovBase + speedRatio * F.cameraFovSpeedGain * 100;
    this.curFov += (wantFov - this.curFov) * Math.min(1, 4 * dt);
    if (Math.abs(this.camera.fov - this.curFov) > 0.01) {
      this.camera.fov = this.curFov;
      this.camera.updateProjectionMatrix();
    }
  }
}
