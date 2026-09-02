/**
 * 월드 구성 — Phase 0 수준
 *
 * 목적은 예쁜 풍경이 아니라 **속도와 고도가 읽히는 것**이다.
 * 비행 게임에서 지형지물이 없으면 시속 100m/s 로 날아도 정지한 것처럼 느껴진다.
 * 그래서 이 단계에서 가장 중요한 오브젝트는 첨탑(landmark)이다.
 */

import * as THREE from 'three';
import balance from '../data/balance.json';
import { createSky, createClouds, createGroundShadow } from './atmosphere';
import { terrainHeight } from './terrain';
import type { GroundShadow } from './atmosphere';

const F = balance.flight;

/** 결정론적 난수 — 서버·클라가 같은 월드를 봐야 한다 */
function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

export type World = {
  scene: THREE.Scene;
  shadow: GroundShadow;
  update(t: number, dt: number, playerX: number, playerY: number, playerZ: number): void;
};

export function buildWorld(seed = 20260902): World {
  const scene = new THREE.Scene();
  const rng = makeRng(seed);

  /* ---------- 하늘 · 안개 ---------- */
  // 단색 배경이면 롤로 뒤집혔을 때 위아래를 잃는다. 그라디언트가 방향을 알려준다.
  scene.add(createSky());
  // 안개가 거리감을 만든다. 이게 없으면 지형이 평면 텍스처처럼 보인다.
  scene.fog = new THREE.Fog(0x2a3a55, 320, 2600);

  /* ---------- 조명 ---------- */
  const hemi = new THREE.HemisphereLight(0xa8ccff, 0x2b3a2a, 1.35);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffd9a8, 1.9);
  sun.position.set(-380, 520, 260);
  scene.add(sun);

  /* ---------- 지면 ---------- */
  // 8km × 8km (§9). 세그먼트를 잘게 쓰면 프레임이 죽으므로 기복은 정점 이동으로만 준다.
  const size = 8000;
  const seg = 120;
  const groundGeo = new THREE.PlaneGeometry(size, size, seg, seg);
  groundGeo.rotateX(-Math.PI / 2);
  const pos = groundGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    // 충돌과 완전히 같은 함수를 쓴다 — 어긋나면 언덕을 뚫고 지나가게 된다
    pos.setY(i, terrainHeight(x, z));
  }
  groundGeo.computeVertexNormals();
  const ground = new THREE.Mesh(
    groundGeo,
    // 너무 어두우면 기복도 그림자도 안 읽힌다. 능선/골짜기가 구분될 만큼은 밝혀야 한다.
    new THREE.MeshStandardMaterial({ color: 0x3d5233, roughness: 1, flatShading: true }),
  );
  scene.add(ground);

  // 지면 격자 — 속도감의 핵심. 아래를 볼 때 흐르는 선이 있어야 빠르다고 느낀다.
  // 평평한 GridHelper 를 쓰면 언덕에 묻혀 사라진다. 지형과 같은 형상의 와이어를 얹는다.
  const wireGeo = groundGeo.clone();
  const wpos = wireGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < wpos.count; i++) wpos.setY(i, wpos.getY(i) + 0.35);
  const wire = new THREE.Mesh(
    wireGeo,
    new THREE.MeshBasicMaterial({
      color: 0x4d7ba8,
      wireframe: true,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    }),
  );
  scene.add(wire);

  /* ---------- 랜드마크 첨탑 ---------- */
  // 손배치 30~40개 (§9). Phase 0 에서는 절차 생성으로 대신한다.
  const spireMat = new THREE.MeshStandardMaterial({
    color: 0x55627d,
    roughness: 0.9,
    flatShading: true,
  });
  const spireGeo = new THREE.ConeGeometry(1, 1, 6);
  const spires = new THREE.InstancedMesh(spireGeo, spireMat, 240);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i < 240; i++) {
    const a = rng() * Math.PI * 2;
    const r = 140 + Math.sqrt(rng()) * 3400;
    const h = 60 + rng() * 240;
    const w = 12 + rng() * 34;
    p.set(Math.cos(a) * r, terrainHeight(Math.cos(a) * r, Math.sin(a) * r) + h / 2 - 8, Math.sin(a) * r);
    sc.set(w, h, w);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI);
    m.compose(p, q, sc);
    spires.setMatrixAt(i, m);
  }
  spires.instanceMatrix.needsUpdate = true;
  scene.add(spires);

  /* ---------- 구름층 ---------- */
  // 고층 경계를 뚫고 올라가는 순간이 3층 구조(§9)의 가장 강한 신호가 된다.
  const clouds = createClouds(rng);
  scene.add(clouds.group);

  /* ---------- 지면 그림자 ---------- */
  const shadow = createGroundShadow();
  scene.add(shadow.mesh);

  /* ---------- 고층 경계 ---------- */
  // 220m 위는 스태미나가 깎이는 곳이다. 경계가 보여야 "올라가는 결정"이 의미를 갖는다.
  const ceilGeo = new THREE.PlaneGeometry(size, size, 1, 1);
  ceilGeo.rotateX(-Math.PI / 2);
  const ceiling = new THREE.Mesh(
    ceilGeo,
    new THREE.MeshBasicMaterial({
      color: 0x8fb8ff,
      transparent: true,
      opacity: 0.05,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  ceiling.position.y = F.highLayerY;
  scene.add(ceiling);

  /* ---------- 별 ---------- */
  const starGeo = new THREE.BufferGeometry();
  const starCount = 900;
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const a = rng() * Math.PI * 2;
    const b = Math.acos(rng() * 0.9 + 0.05);
    const r = 3400;
    starPos[i * 3] = Math.sin(b) * Math.cos(a) * r;
    starPos[i * 3 + 1] = Math.abs(Math.cos(b)) * r * 0.7 + 300;
    starPos[i * 3 + 2] = Math.sin(b) * Math.sin(a) * r;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  scene.add(
    new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xbcd4ff, size: 7, sizeAttenuation: true, transparent: true, opacity: 0.7 }),
    ),
  );

  return {
    scene,
    shadow,
    update(_t, _dt, px, _py, pz) {
      clouds.follow(px, pz);
      ceiling.position.x = px;
      ceiling.position.z = pz;
    },
  };
}
