/**
 * 원격 플레이어 렌더링
 *
 * 남의 드래곤도 내 것과 **같은 절차적 생성기**를 쓴다 (§6.2).
 * 서버는 대표 속성 하나와 단계만 보내주므로, 그 둘로 색과 몸집을 재현한다.
 *
 * 이름표를 반드시 붙인다: 멀티플레이에서 "저게 누구인가"를 모르면
 * 신성용 사냥이든 비행단 협력이든 성립하지 않는다.
 */

import * as THREE from 'three';
import type { Element, Rarity, Stage } from '../types';
import type { RemotePlayer } from '../net/client';
import balance from '../data/balance.json';
import { createDragon, tintFromAffinity, animateWings, type DragonRig } from './dragon';
import { createCarriedEggMesh } from './eggs';

type RemoteVisual = {
  rig: DragonRig;
  label: THREE.Sprite;
  stage: Stage;
  tintKey: string;
  carryKey: string;
  carried: THREE.Mesh | null;
};

/** 이름표 텍스처를 캔버스로 만든다 (외부 폰트 에셋 없이) */
function labelTexture(text: string, carrying: boolean): THREE.Texture {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 64;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, 256, 64);

  ctx.font = 'bold 30px "Malgun Gothic", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 어두운 하늘에도 밝은 지면에도 읽히도록 외곽선을 두른다
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, 128, 32);
  // 알을 든 플레이어는 색으로 구분된다 — §2 "알을 든 순간 곧 표적이 된다"
  ctx.fillStyle = carrying ? '#ffc07a' : '#e9f0fb';
  ctx.fillText(text, 128, 32);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export type RemoteField = {
  group: THREE.Group;
  /** 접속자 목록에 맞춰 씬을 갱신하고 위치를 반영한다 */
  sync(remotes: Map<string, RemotePlayer>, t: number): void;
};

export function createRemoteField(): RemoteField {
  const group = new THREE.Group();
  const visuals = new Map<string, RemoteVisual>();

  function stageDef(stage: Stage) {
    return balance.stage[String(stage) as keyof typeof balance.stage] as { scale: number };
  }

  function tintOf(element: string, ratio: number): THREE.Color {
    if (!element) return tintFromAffinity({});
    // 서버는 대표 속성 하나만 보낸다. 비율이 낮으면 회색에 가깝게 섞어
    // "아직 잡종이다" 라는 느낌을 살린다.
    const pure = tintFromAffinity({ [element as Element]: 1 });
    const neutral = new THREE.Color(0x8899aa);
    return neutral.clone().lerp(pure, Math.min(1, Math.max(0.25, ratio)));
  }

  function build(r: RemotePlayer): RemoteVisual {
    const stage = Math.max(1, Math.min(6, r.stage)) as Stage;
    const rig = createDragon(tintOf(r.tintElement, r.tintRatio), stage);
    rig.root.scale.setScalar(stageDef(stage).scale * 0.55);
    group.add(rig.root);

    const label = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: labelTexture(r.name, !!r.carriedRarity),
        transparent: true,
        depthWrite: false,
        // 지형 뒤에 있어도 이름은 보이는 편이 낫다 — 누가 어디 있는지가 정보다
        depthTest: false,
      }),
    );
    label.scale.set(26, 6.5, 1);
    group.add(label);

    return {
      rig,
      label,
      stage,
      tintKey: `${r.tintElement}:${r.tintRatio.toFixed(2)}`,
      carryKey: `${r.carriedRarity}:${r.carriedElement}`,
      carried: null,
    };
  }

  function disposeVisual(v: RemoteVisual) {
    group.remove(v.rig.root);
    group.remove(v.label);
    (v.label.material as THREE.SpriteMaterial).map?.dispose();
    (v.label.material as THREE.Material).dispose();
    if (v.carried) {
      v.carried.geometry.dispose();
      (v.carried.material as THREE.Material).dispose();
    }
  }

  function syncCarried(v: RemoteVisual, r: RemotePlayer) {
    const key = `${r.carriedRarity}:${r.carriedElement}`;
    if (key === v.carryKey && v.carried !== null) return;
    if (key === v.carryKey && !r.carriedRarity) return;

    if (v.carried) {
      v.carried.removeFromParent();
      v.carried.geometry.dispose();
      (v.carried.material as THREE.Material).dispose();
      v.carried = null;
    }
    if (r.carriedRarity) {
      v.carried = createCarriedEggMesh(r.carriedRarity as Rarity, r.carriedElement);
      v.rig.carrySlot.add(v.carried);
    }
    v.carryKey = key;
  }

  return {
    group,

    sync(remotes, t) {
      // 사라진 플레이어 정리
      for (const [id, v] of visuals) {
        if (!remotes.has(id)) {
          disposeVisual(v);
          visuals.delete(id);
        }
      }

      for (const [id, r] of remotes) {
        // 보간 결과가 아직 없으면 그리지 않는다 (막 접속해 스냅샷이 한 개도 없는 상태)
        if (!r.render) continue;

        let v = visuals.get(id);
        if (!v) {
          v = build(r);
          visuals.set(id, v);
        }

        // 단계가 바뀌면 몸집·가시를 새로 만들어야 한다 (§6.2)
        const stage = Math.max(1, Math.min(6, r.stage)) as Stage;
        const tintKey = `${r.tintElement}:${r.tintRatio.toFixed(2)}`;
        if (stage !== v.stage) {
          disposeVisual(v);
          v = build(r);
          visuals.set(id, v);
        } else if (tintKey !== v.tintKey) {
          // 색만 바뀌었으면 리그를 다시 만들 필요 없다
          v.rig.setTint(tintOf(r.tintElement, r.tintRatio));
          v.tintKey = tintKey;
        }

        syncCarried(v, r);

        const s = r.render;
        v.rig.root.position.set(s.x, s.y, s.z);
        v.rig.root.rotation.set(s.pitch, s.yaw, 0, 'YXZ');
        // 남의 입력은 모르므로 순항 리듬으로만 퍼덕인다
        animateWings(v.rig, t, 0.35, 0.5);

        // 이름표는 항상 카메라를 향한다 (Sprite 기본 동작)
        const lift = 9 * stageDef(stage).scale * 0.55;
        v.label.position.set(s.x, s.y + lift, s.z);

        // 알을 들었는지 바뀌면 이름표 색을 새로 굽는다
        const wantCarry = !!r.carriedRarity;
        if (v.label.userData.carrying !== wantCarry || v.label.userData.name !== r.name) {
          const mat = v.label.material as THREE.SpriteMaterial;
          mat.map?.dispose();
          mat.map = labelTexture(r.name, wantCarry);
          mat.needsUpdate = true;
          v.label.userData.carrying = wantCarry;
          v.label.userData.name = r.name;
        }
      }
    },
  };
}
