/**
 * 알 렌더링
 *
 * 8km 월드에 알 64개를 그냥 놓으면 절대 못 찾는다. 세 가지 단서를 겹친다.
 *   1. 속성 색 — 무슨 알인지 멀리서도 구분된다
 *   2. 등급 빛기둥 — 희귀 이상은 멀리서도 눈에 띄어야 PvP 무대가 된다 (§7.1)
 *   3. 위아래로 떠다니는 움직임 — 정적인 물체는 배경에 묻힌다
 */

import * as THREE from 'three';
import type { Rarity, SpawnedEgg } from '../types';
import balance from '../data/balance.json';
import { ELEMENT_COLOR } from './dragon';
import { rarityAtLeast } from '../egg/spawn';

const E = balance.eggs;

/** 등급별 크기·발광 세기. 등급이 곧 실루엣 크기가 되도록 한다. */
const RARITY_STYLE: Record<Rarity, { scale: number; glow: number }> = {
  common: { scale: 1.0, glow: 0.25 },
  uncommon: { scale: 1.25, glow: 0.45 },
  rare: { scale: 1.6, glow: 0.7 },
  epic: { scale: 2.1, glow: 1.0 },
  divine: { scale: 3.0, glow: 1.6 },
};

export type EggField = {
  group: THREE.Group;
  /** 스포너의 현재 알 목록으로 화면을 맞춘다 (추가/제거를 알아서 처리) */
  sync(eggs: SpawnedEgg[]): void;
  /** 떠다니는 애니메이션 */
  update(t: number): void;
};

/** 알 하나의 시각 요소 묶음 */
type EggVisual = {
  root: THREE.Group;
  shell: THREE.Mesh;
  /** 희귀 이상만 있음 */
  beacon: THREE.Mesh | null;
  baseY: number;
  phase: number;
};

/** 위로 갈수록 사라지는 빛기둥 텍스처를 코드로 만든다 */
function beaconTexture(): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 4;
  cv.height = 64;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 64, 0, 0);
  g.addColorStop(0, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.28)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createEggField(): EggField {
  const group = new THREE.Group();
  const beaconTex = beaconTexture();

  // 알 껍질은 구를 세로로 늘려 만든다. 실제 알처럼 아래가 살짝 통통하게.
  const shellGeo = new THREE.SphereGeometry(1, 12, 10);
  shellGeo.scale(0.78, 1.12, 0.78);

  const beaconGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);

  /** nestId → 화면에 떠 있는 알 */
  const visuals = new Map<string, EggVisual>();

  function build(se: SpawnedEgg): EggVisual {
    const style = RARITY_STYLE[se.egg.rarity];
    const color = new THREE.Color(ELEMENT_COLOR[se.egg.element]);

    const root = new THREE.Group();
    root.position.set(se.x, se.y, se.z);

    const shell = new THREE.Mesh(
      shellGeo,
      new THREE.MeshStandardMaterial({
        color,
        roughness: 0.35,
        metalness: 0.2,
        // 발광으로 등급을 표현한다. 조명이 어두운 곳에서도 알은 보여야 한다.
        emissive: color,
        emissiveIntensity: style.glow,
        flatShading: true,
      }),
    );
    shell.scale.setScalar(2.6 * style.scale);
    root.add(shell);

    let beacon: THREE.Mesh | null = null;
    if (rarityAtLeast(se.egg.rarity, E.beaconMinRarity as Rarity)) {
      beacon = new THREE.Mesh(
        beaconGeo,
        new THREE.MeshBasicMaterial({
          map: beaconTex,
          color,
          transparent: true,
          opacity: 0.5,
          depthWrite: false,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
        }),
      );
      const h = 150 * style.scale;
      beacon.scale.set(4.5 * style.scale, h, 4.5 * style.scale);
      beacon.position.y = h / 2;
      root.add(beacon);
    }

    return {
      root,
      shell,
      beacon,
      baseY: se.y,
      // 위상을 알마다 달리해 전부 같은 박자로 까딱이지 않게 한다
      phase: (se.x * 0.7 + se.z * 1.3) % (Math.PI * 2),
    };
  }

  return {
    group,

    sync(eggs) {
      const seen = new Set<string>();
      for (const se of eggs) {
        seen.add(se.nestId);
        if (visuals.has(se.nestId)) continue;
        const v = build(se);
        visuals.set(se.nestId, v);
        group.add(v.root);
      }
      // 사라진 알(주웠거나 소멸) 정리
      for (const [nestId, v] of visuals) {
        if (seen.has(nestId)) continue;
        group.remove(v.root);
        (v.shell.material as THREE.Material).dispose();
        if (v.beacon) (v.beacon.material as THREE.Material).dispose();
        visuals.delete(nestId);
      }
    },

    update(t) {
      for (const v of visuals) {
        const vis = v[1];
        // 위아래로 천천히 떠다니고 제자리에서 돈다 — 배경과 구분되는 가장 싼 방법
        vis.root.position.y = vis.baseY + Math.sin(t * 1.1 + vis.phase) * 1.4;
        vis.shell.rotation.y = t * 0.55 + vis.phase;
      }
    },
  };
}
