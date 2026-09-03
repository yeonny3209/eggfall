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
import type { Element, Stage } from '../types';

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
  /** 운반 중인 알이 붙는 자리 (앞발). 여기에 넣으면 드래곤을 따라다닌다. */
  carrySlot: THREE.Group;
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

/**
 * 절차적 드래곤을 만든다.
 *
 * §6.2: 외형은 저장하지 않고 elementAffinity 와 성장 단계에서 결정론적으로 계산한다.
 * 같은 친화도 · 같은 단계면 언제나 같은 모습이 나온다.
 *
 * @param stage 성장 단계 — 등 가시 개수가 단계만큼 늘어나 성장이 실루엣으로 읽힌다
 */
export function createDragon(tint: THREE.Color, stage: Stage = 1): DragonRig {
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

  // 등 가시 — 단계마다 하나씩 늘어난다.
  // 숫자 UI 없이도 "내가 자랐다"가 실루엣으로 보이게 하는 가장 싼 방법이다.
  const spikeCount = stage;
  for (let i = 0; i < spikeCount; i++) {
    const spike = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.5 + i * 0.06, 4), skin);
    // 목덜미에서 꼬리 쪽으로 균등 배치
    const t = spikeCount === 1 ? 0.5 : i / (spikeCount - 1);
    spike.position.set(0, 0.55, 1.3 - t * 3.4);
    root.add(spike);
  }

  // 운반 중인 알이 붙는 자리 — 앞발 아래
  const carrySlot = new THREE.Group();
  carrySlot.position.set(0, -0.85, 0.6);
  root.add(carrySlot);

  return {
    root,
    wingL,
    wingR,
    body,
    carrySlot,
    setTint(color: THREE.Color) {
      skin.color.copy(color);
      membrane.color.copy(color).multiplyScalar(0.55);
    },
  };
}

/**
 * 날갯짓 · 활공 애니메이션
 *
 * 스태미나·명시적 날갯짓 이벤트가 사라졌으므로, 대신 연속적인 리듬으로 표현한다:
 * 상승 중일수록 빠르고 크게 퍼덕이고, 순항 중엔 느긋하게, 고속 이동 중엔 날개를 접는다.
 *
 * @param flapVigor 0~1, 1이면 힘차게 상승 중(Space)
 * @param speedRatio 0~1, 빠를수록 날개를 접는다 (고속 실루엣)
 */
export function animateWings(rig: DragonRig, t: number, flapVigor: number, speedRatio: number) {
  // 상반각(dihedral). 날개를 완전히 수평으로 두면 바로 뒤에서 볼 때 날이 서서
  // 선 하나로만 보인다. 3인칭 추적 시점에서 날개 면이 읽히려면 반드시 각이 있어야 한다.
  const DIHEDRAL = 0.3;
  const freq = 1.4 + flapVigor * 3.2;
  const amp = 0.16 + flapVigor * 0.7;
  const flap = Math.sin(t * freq) * amp;
  // 빠를수록 날개를 뒤로 접어 항력을 줄인 실루엣을 만든다
  const tuck = speedRatio * 0.55;

  const z = DIHEDRAL + flap - tuck;
  rig.wingL.rotation.z = -z;
  rig.wingR.rotation.z = z;
  rig.wingL.rotation.y = -tuck * 0.5;
  rig.wingR.rotation.y = tuck * 0.5;
}
