/**
 * 절차적 드래곤 메시
 *
 * 기획서 §6.2: 외형은 저장하지 않고 elementAffinity 에서 결정론적으로 계산한다.
 * §12 리스크 대응: 3D 에셋 병목 → 부위 조합 + 셰이더 변주로 해결한다.
 *
 * Phase 0 이므로 아직 부위 4메시 조합까지는 가지 않는다.
 * 지금 필요한 건 "내가 어디를 보고 어떻게 기울어 있는지"가 읽히는 실루엣 하나다.
 */

import * as THREE from 'three';
import type { Element } from '../types';

/** 속성별 대표색 — 셰이더 변주의 기준값 (§6.2) */
export const ELEMENT_COLOR: Record<Element, number> = {
  ember: 0xff6b35,
  rime: 0x7ddfff,
  gale: 0xc9a7ff,
  blight: 0x9dd648,
  terra: 0xd4a15e,
  umbra: 0x7a5cff,
};

export type DragonRig = {
  root: THREE.Group;
  /** 날갯짓 애니메이션용 */
  wingL: THREE.Group;
  wingR: THREE.Group;
  body: THREE.Mesh;
  setTint(color: THREE.Color): void;
};

/**
 * 친화도 → 색. 여러 속성이 섞이면 색도 섞인다.
 * 결정론적이므로 같은 친화도는 언제나 같은 외형을 낸다.
 */
export function tintFromAffinity(affinity: Partial<Record<Element, number>>): THREE.Color {
  const c = new THREE.Color(0, 0, 0);
  let total = 0;
  for (const k of Object.keys(affinity) as Element[]) {
    const w = affinity[k] ?? 0;
    if (w <= 0) continue;
    total += w;
    c.add(new THREE.Color(ELEMENT_COLOR[k]).multiplyScalar(w));
  }
  if (total <= 0) return new THREE.Color(0x8899aa);
  return c.multiplyScalar(1 / total);
}

export function createDragon(tint: THREE.Color): DragonRig {
  const root = new THREE.Group();

  const skin = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.62,
    metalness: 0.15,
    flatShading: true,
  });
  const membrane = new THREE.MeshStandardMaterial({
    color: tint.clone().multiplyScalar(0.55),
    roughness: 0.8,
    metalness: 0.0,
    flatShading: true,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.92,
  });

  // 몸통 — 앞쪽이 가늘어지는 원뿔형. +Z 가 기수 방향이다.
  const bodyGeo = new THREE.CapsuleGeometry(0.62, 2.4, 4, 8);
  bodyGeo.rotateX(Math.PI / 2);
  const body = new THREE.Mesh(bodyGeo, skin);
  root.add(body);

  // 머리
  const head = new THREE.Mesh(new THREE.ConeGeometry(0.44, 1.5, 6), skin);
  head.rotation.x = Math.PI / 2;
  head.position.set(0, 0.08, 2.15);
  root.add(head);

  // 뿔 2개 — 부위 조합의 자리표시자
  for (const s of [-1, 1]) {
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.62, 4), skin);
    horn.position.set(s * 0.2, 0.4, 1.85);
    horn.rotation.set(-0.5, 0, s * 0.28);
    root.add(horn);
  }

  // 꼬리
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.42, 3.4, 6), skin);
  tail.rotation.x = -Math.PI / 2;
  tail.position.set(0, 0.05, -2.5);
  root.add(tail);

  // 날개 — 피벗 그룹을 따로 두어야 날갯짓을 회전만으로 처리할 수 있다
  const mkWing = (side: number) => {
    const g = new THREE.Group();
    const shape = new THREE.Shape();
    shape.moveTo(0, 0);
    shape.lineTo(3.6, 0.9);
    shape.lineTo(4.1, -0.35);
    shape.lineTo(2.5, -1.15);
    shape.lineTo(0.9, -0.85);
    shape.lineTo(0, 0);
    const geo = new THREE.ShapeGeometry(shape);
    const wing = new THREE.Mesh(geo, membrane);
    wing.rotation.x = -Math.PI / 2;
    g.add(wing);

    // 날개뼈
    const bone = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.05, 3.9, 4), skin);
    bone.rotation.z = Math.PI / 2;
    bone.position.set(1.95, 0, 0.28);
    g.add(bone);

    g.scale.x = side;
    g.position.set(side * 0.5, 0.28, 0.15);
    return g;
  };
  const wingL = mkWing(-1);
  const wingR = mkWing(1);
  root.add(wingL, wingR);

  // 뒷다리
  for (const s of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.55, 3, 5), skin);
    leg.position.set(s * 0.42, -0.5, -0.75);
    leg.rotation.set(0.35, 0, s * 0.2);
    root.add(leg);
  }

  return {
    root,
    wingL,
    wingR,
    body,
    setTint(color: THREE.Color) {
      skin.color.copy(color);
      membrane.color.copy(color).multiplyScalar(0.55);
    },
  };
}

/**
 * 날갯짓 · 활공 애니메이션
 * @param flapPhase 0~1, 1이면 방금 날갯짓
 * @param speedRatio 0~1, 빠를수록 날개를 접는다 (급강하 실루엣)
 */
export function animateWings(rig: DragonRig, t: number, flapPhase: number, speedRatio: number) {
  // 상반각(dihedral). 날개를 완전히 수평으로 두면 바로 뒤에서 볼 때 날이 서서
  // 선 하나로만 보인다. 3인칭 추적 시점에서 날개 면이 읽히려면 반드시 각이 있어야 한다.
  const DIHEDRAL = 0.3;
  // 기본 활공: 아주 느린 상하 흔들림
  const idle = Math.sin(t * 1.6) * 0.06;
  // 날갯짓: 위로 크게 들었다가 내려친다
  const flap = Math.sin(flapPhase * Math.PI) * 0.95;
  // 빠를수록 날개를 뒤로 접어 항력을 줄인 실루엣을 만든다
  const tuck = speedRatio * 0.55;

  const z = DIHEDRAL + idle + flap - tuck;
  rig.wingL.rotation.z = -z;
  rig.wingR.rotation.z = z;
  rig.wingL.rotation.y = -tuck * 0.5;
  rig.wingR.rotation.y = tuck * 0.5;
}
