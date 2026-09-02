/**
 * 추적 카메라
 *
 * 비행 게임의 재미 절반은 카메라다. 규칙 세 가지만 지킨다.
 *   1. 빠를수록 뒤로 물러나고 FOV 가 넓어진다 → 속도가 몸으로 읽힌다
 *   2. 즉시 따라붙지 않는다 → 관성이 보인다
 *   3. 롤은 일부만 따라간다 → 화면 전체가 뒤집히면 방향감각을 잃는다
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
  private shakeT = 0;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(F.cameraFovBase, aspect, 0.5, 6000);
  }

  resize(aspect: number) {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(s: FlightState, dt: number, lookYaw: number, lookPitch: number, diving = false) {
    const speed = Math.hypot(s.vx, s.vy, s.vz);
    const speedRatio = Math.min(1, speed / F.maxSpeed);
    this.shakeT += dt;

    // 1. 속도에 따라 뒤로 물러난다
    const dist = F.cameraDistance * (1 + speedRatio * F.cameraSpeedPullback * 10);

    // 마우스 시점은 비행 자세 위에 얹는다 (기수와 시선을 분리)
    const yaw = s.yaw + lookYaw;
    const pitch = s.pitch * 0.55 + lookPitch;

    const back = new THREE.Vector3(
      -Math.sin(yaw) * Math.cos(pitch),
      -Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    );

    const target = new THREE.Vector3(s.x, s.y, s.z)
      .add(back.multiplyScalar(dist))
      .add(new THREE.Vector3(0, F.cameraHeight, 0));

    // 2. 지연 추적 — 관성이 보이게
    const k = 1 - Math.exp(-F.cameraLag * dt);
    this.pos.lerp(target, k);

    // 지면 뚫림 방지 — 고정 높이로 두면 65m 짜리 능선을 그대로 통과한다
    const camGround = terrainHeight(this.pos.x, this.pos.z) + 3;
    if (this.pos.y < camGround) this.pos.y = camGround;

    // 고속·급강하에서 미세하게 흔들어 속도를 몸으로 느끼게 한다.
    // 크게 흔들면 조준이 불가능해지므로 진폭은 끝까지 작게 유지한다.
    const shakeAmt = Math.max(0, speedRatio - 0.62) * (diving ? 1.5 : 0.7);
    if (shakeAmt > 0) {
      const t = this.shakeT * 27;
      this.camera.position.set(
        this.pos.x + Math.sin(t * 1.7) * shakeAmt * 0.5,
        this.pos.y + Math.sin(t * 2.3 + 1.1) * shakeAmt * 0.42,
        this.pos.z + Math.sin(t * 1.9 + 2.4) * shakeAmt * 0.5,
      );
    } else {
      this.camera.position.copy(this.pos);
    }

    this.look.lerp(new THREE.Vector3(s.x, s.y + 1.5, s.z), Math.min(1, 12 * dt));
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.look);

    // 3. 롤은 35%만 따라간다
    this.camera.rotateZ(-s.roll * 0.35);

    // FOV — 속도가 붙으면 시야가 넓어진다
    const wantFov = F.cameraFovBase + speedRatio * F.cameraFovSpeedGain * 100;
    this.curFov += (wantFov - this.curFov) * Math.min(1, 4 * dt);
    if (Math.abs(this.camera.fov - this.curFov) > 0.01) {
      this.camera.fov = this.curFov;
      this.camera.updateProjectionMatrix();
    }
  }
}
