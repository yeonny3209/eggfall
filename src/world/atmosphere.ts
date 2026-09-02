/**
 * 대기 — 하늘 그라디언트 · 구름층 · 지면 그림자
 *
 * 셋 다 "예쁘게"가 목적이 아니다. 각각 읽기 문제를 하나씩 푼다.
 *   하늘   — 위아래 구분. 단색 배경이면 뒤집혔을 때 방향을 잃는다.
 *   구름   — 고층 경계(220m)를 눈에 보이게. §9 의 3층 구조가 UI 없이 읽힌다.
 *   그림자 — 고도 감각. 3인칭 비행에서 자기 높이를 아는 유일하게 확실한 단서다.
 */

import * as THREE from 'three';
import balance from '../data/balance.json';
import { terrainHeight } from './terrain';

const F = balance.flight;

/* ==========================================================================
   하늘
   ========================================================================== */
export function createSky(radius = 4200): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x070c18) },
      mid: { value: new THREE.Color(0x1b2c4d) },
      bot: { value: new THREE.Color(0x3a4a63) },
      horizon: { value: new THREE.Color(0x6b7fa0) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main(){
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 top; uniform vec3 mid; uniform vec3 bot; uniform vec3 horizon;
      varying vec3 vPos;
      void main(){
        float h = normalize(vPos).y;
        // 수평선 근처를 밝게 태워 지평선이 또렷하게 보이도록 한다
        float glow = pow(1.0 - abs(h), 8.0);
        vec3 c = h > 0.0 ? mix(mid, top, pow(h, 0.65)) : mix(mid, bot, pow(-h, 0.8));
        c = mix(c, horizon, glow * 0.55);
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(radius, 32, 20), mat);
  sky.frustumCulled = false;
  return sky;
}

/* ==========================================================================
   구름
   ========================================================================== */
/** 부드러운 원형 알파 텍스처를 코드로 만든다 (외부 에셋 없이) */
function softDiscTexture(): THREE.Texture {
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export type CloudLayer = {
  group: THREE.Group;
  /** 플레이어를 따라 이동시켜 무한히 넓어 보이게 한다 */
  follow(x: number, z: number): void;
};

/**
 * 고층 경계(220m)에 얇은 구름층을 깐다.
 * 이걸 뚫고 올라가는 순간이 "고층에 진입했다"는 가장 강한 신호가 된다.
 */
export function createClouds(rng: () => number, count = 130): CloudLayer {
  const group = new THREE.Group();
  const tex = softDiscTexture();
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
    color: 0xaecbf0,
    side: THREE.DoubleSide,
  });

  const SPREAD = 2600;
  for (let i = 0; i < count; i++) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const m = new THREE.Mesh(geo, mat);
    const s = 180 + rng() * 460;
    m.scale.set(s, s * (0.5 + rng() * 0.4), 1);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = rng() * Math.PI;
    m.position.set(
      (rng() - 0.5) * SPREAD * 2,
      F.highLayerY + (rng() - 0.5) * 34,
      (rng() - 0.5) * SPREAD * 2,
    );
    m.userData.ox = m.position.x;
    m.userData.oz = m.position.z;
    group.add(m);
  }

  return {
    group,
    follow(x, z) {
      // 구름을 플레이어 기준 격자에 랩어라운드시켜 항상 주변을 덮게 한다
      const span = SPREAD * 2;
      for (const c of group.children) {
        const ox = c.userData.ox as number;
        const oz = c.userData.oz as number;
        c.position.x = x + wrap(ox - x, span);
        c.position.z = z + wrap(oz - z, span);
      }
    },
  };
}

function wrap(v: number, span: number): number {
  const half = span / 2;
  return ((((v + half) % span) + span) % span) - half;
}

/* ==========================================================================
   지면 그림자
   ========================================================================== */
export type GroundShadow = {
  mesh: THREE.Mesh;
  update(x: number, y: number, z: number, yaw: number, wingSpan: number): void;
};

/**
 * 드래곤 바로 아래 지면에 타원 그림자를 놓는다.
 * 고도가 높을수록 크고 흐리게 — 이 하나로 "내가 얼마나 높은가"가 즉시 읽힌다.
 */
export function createGroundShadow(): GroundShadow {
  const tex = softDiscTexture();
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    depthTest: false,   // 어두운 지면·와이어에 묻히지 않도록 항상 위에 그린다
    color: 0x05070c,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 2;

  return {
    mesh,
    update(x, y, z, yaw, wingSpan) {
      // 고정 평면이 아니라 그 지점의 실제 지면에 붙여야 그림자가 뜨지 않는다
      const g = terrainHeight(x, z);
      const alt = Math.max(0, y - g);
      mesh.position.set(x, g + 0.9, z);
      mesh.rotation.z = -yaw;
      // 높을수록 퍼지고 옅어진다
      const spread = 1 + alt / 90;
      mesh.scale.set(wingSpan * spread, wingSpan * 0.6 * spread, 1);
      mat.opacity = 0.72 * Math.max(0, 1 - alt / 340);
      mesh.visible = mat.opacity > 0.01;
    },
  };
}
