/**
 * 홈 둥지 — 핵심 루프의 종착점 (§2: 탐색 → 회수 → 운반 → **둥지 귀환** → 흡수)
 *
 * 운반 페널티를 감수하고 돌아올 이유가 되려면, 멀리서도 "저기다" 하고 보여야 한다.
 * 그래서 지면 링 + 하늘까지 뻗는 빛기둥 두 겹으로 만든다.
 * Phase 7 의 비행단 공용 둥지가 될 자리이기도 하다.
 */

import * as THREE from 'three';
import balance from '../data/balance.json';
import { terrainHeight } from './terrain';

const H = balance.homeNest;

export type HomeNest = {
  group: THREE.Group;
  /** @param carrying 알을 들고 있으면 둥지를 강조해 "여기로 오라"고 알린다 */
  update(t: number, carrying: boolean): void;
};

export function createHomeNest(): HomeNest {
  const group = new THREE.Group();
  const baseY = terrainHeight(H.x, H.z);
  group.position.set(H.x, baseY, H.z);

  const accent = new THREE.Color(0x7ce0ff);

  /* ---------- 지면 링 ---------- */
  const ringGeo = new THREE.RingGeometry(H.radius * 0.82, H.radius, 64);
  ringGeo.rotateX(-Math.PI / 2);
  const ringMat = new THREE.MeshBasicMaterial({
    color: accent,
    transparent: true,
    opacity: 0.5,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  ring.position.y = 1.2;
  group.add(ring);

  /* ---------- 안쪽 바닥 ---------- */
  const discGeo = new THREE.CircleGeometry(H.radius * 0.82, 48);
  discGeo.rotateX(-Math.PI / 2);
  const discMat = new THREE.MeshBasicMaterial({
    color: accent,
    transparent: true,
    opacity: 0.07,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const disc = new THREE.Mesh(discGeo, discMat);
  disc.position.y = 0.9;
  group.add(disc);

  /* ---------- 빛기둥 ---------- */
  // 위로 갈수록 사라지는 그라디언트를 코드로 만든다 (외부 에셋 없이)
  const cv = document.createElement('canvas');
  cv.width = 4;
  cv.height = 64;
  const ctx = cv.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 64, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.16)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 4, 64);
  const beaconTex = new THREE.CanvasTexture(cv);
  beaconTex.colorSpace = THREE.SRGBColorSpace;

  const beaconMat = new THREE.MeshBasicMaterial({
    map: beaconTex,
    color: accent,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const beacon = new THREE.Mesh(
    new THREE.CylinderGeometry(H.radius * 0.7, H.radius * 0.7, H.beaconHeight, 24, 1, true),
    beaconMat,
  );
  beacon.position.y = H.beaconHeight / 2;
  group.add(beacon);

  /* ---------- 회전하는 안쪽 링 ---------- */
  const innerGeo = new THREE.RingGeometry(H.radius * 0.3, H.radius * 0.36, 6);
  innerGeo.rotateX(-Math.PI / 2);
  const inner = new THREE.Mesh(innerGeo, ringMat.clone());
  inner.position.y = 1.4;
  group.add(inner);

  return {
    group,
    update(t, carrying) {
      inner.rotation.y = t * 0.35;
      // 숨쉬듯 밝기가 오르내린다 — 정적인 물체는 배경에 묻힌다
      const pulse = 0.5 + Math.sin(t * 1.6) * 0.5;
      // 알을 들고 있을 때만 강하게 빛나 "여기로 가져와라"를 UI 없이 전달한다
      const boost = carrying ? 1.9 : 1;
      ringMat.opacity = (0.32 + pulse * 0.2) * boost;
      (inner.material as THREE.MeshBasicMaterial).opacity = (0.25 + pulse * 0.3) * boost;
      beaconMat.opacity = (0.22 + pulse * 0.12) * boost;
      discMat.opacity = 0.07 * boost;
    },
  };
}
