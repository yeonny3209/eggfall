/**
 * HUD — Phase 0 (단순 조작 버전)
 *
 * 스태미나·실속·상승기류가 사라졌으니 HUD 도 그만큼 가벼워진다.
 * 지금 보여줄 건 속도·고도·층 표시, 그리고 착지 여부뿐이다.
 */

import type { Layer, Rarity } from '../types';

/** 가장 가까운 알 — 8km 월드에서 눈으로만 찾으면 대부분 못 찾는다 */
export type EggBearing = {
  rarity: Rarity;
  element: string;
  /** 수평 거리 (m) */
  dist: number;
  /** 플레이어 기수 기준 상대 방위 (rad). 0이면 정면. */
  bearing: number;
  /** 플레이어보다 위에 있으면 +, 아래면 - */
  dy: number;
};

export type HudModel = {
  speed: number;
  altitude: number;
  layer: Layer;
  grounded: boolean;
  stageName: string;
  /** 0~1, 이동속도 대비 */
  speedRatio: number;
  /** 주변 알 개수 (레이더 반경 내) */
  eggsNearby: number;
  nearestEgg: EggBearing | null;
};

const RARITY_LABEL: Record<Rarity, string> = {
  common: '일반',
  uncommon: '고급',
  rare: '희귀',
  epic: '영웅',
  divine: '신성',
};

const RARITY_COLOR: Record<Rarity, string> = {
  common: '#b9c6d8',
  uncommon: '#7ee6a0',
  rare: '#6bb6ff',
  epic: '#c98bff',
  divine: '#ffd166',
};

const LAYER_LABEL: Record<Layer, string> = {
  low: '하층 · 협곡',
  mid: '중층 · 주 전장',
  high: '고층',
};

export function mountHud() {
  const root = document.getElementById('hud')!;
  root.innerHTML = `
    <div class="hud-left">
      <div class="gauge">
        <span class="label">속도</span>
        <b id="h-speed">0</b><span class="unit">m/s</span>
      </div>
      <div class="gauge">
        <span class="label">고도</span>
        <b id="h-alt">0</b><span class="unit">m</span>
      </div>
      <div class="layer" id="h-layer">중층</div>
    </div>
    <div class="hud-center">
      <div id="h-alert" class="alert"></div>
    </div>
    <div class="eggfinder" id="h-egg">
      <div class="eg-head">가장 가까운 알</div>
      <div class="eg-row">
        <span class="eg-arrow" id="h-egg-arrow">▲</span>
        <b class="eg-name" id="h-egg-name">—</b>
      </div>
      <div class="eg-dist" id="h-egg-dist"></div>
      <div class="eg-count" id="h-egg-count"></div>
    </div>
    <div id="h-streaks" class="streaks"></div>
    <div class="hud-right">
      <div class="stage" id="h-stage">드레이크</div>
      <div class="keys">
        <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 이동</div>
        <div><kbd>Space</kbd> 상승</div>
        <div><kbd>Shift</kbd> 하강</div>
        <div class="dim">마우스 — 시점 회전 · 클릭으로 활성화</div>
      </div>
    </div>
    <div id="h-flash" class="flash"></div>
  `;

  const $ = (id: string) => document.getElementById(id)!;
  const elSpeed = $('h-speed');
  const elAlt = $('h-alt');
  const elLayer = $('h-layer');
  const elAlert = $('h-alert');
  const elStage = $('h-stage');
  const elFlash = $('h-flash');
  const elStreaks = $('h-streaks');
  const elEgg = $('h-egg');
  const elEggArrow = $('h-egg-arrow');
  const elEggName = $('h-egg-name');
  const elEggDist = $('h-egg-dist');
  const elEggCount = $('h-egg-count');

  let flashTimer = 0;
  let lastAlert = '';

  return {
    update(m: HudModel) {
      elSpeed.textContent = m.speed.toFixed(0);
      elAlt.textContent = m.altitude.toFixed(0);

      elLayer.textContent = LAYER_LABEL[m.layer];
      elLayer.className = 'layer ' + m.layer;
      elStage.textContent = m.stageName;

      const alert = m.grounded ? '착지 — Space 로 다시 이륙' : '';
      if (alert !== lastAlert) {
        elAlert.textContent = alert;
        elAlert.className = 'alert' + (alert ? ' warn' : '');
        lastAlert = alert;
      }

      // 속도 스트릭 — 숫자만으로는 속도가 몸에 안 와닿는다.
      const streak = Math.max(0, (m.speedRatio - 0.5) / 0.5);
      elStreaks.style.opacity = String(streak * 0.55);

      /* ---------- 알 파인더 ---------- */
      const e = m.nearestEgg;
      if (!e) {
        elEgg.className = 'eggfinder empty';
        elEggName.textContent = '—';
        elEggDist.textContent = '주변에 알이 없습니다';
        elEggCount.textContent = '';
      } else {
        elEgg.className = 'eggfinder';
        elEggName.textContent = `${RARITY_LABEL[e.rarity]} · ${e.element}`;
        elEggName.style.color = RARITY_COLOR[e.rarity];
        // 화살표를 상대 방위만큼 돌린다 — 위쪽이 정면
        elEggArrow.style.transform = `rotate(${e.bearing}rad)`;
        elEggArrow.style.color = RARITY_COLOR[e.rarity];
        // 고도 차이를 ▲▼ 로 덧붙여 3차원 위치를 알린다
        const vert = e.dy > 12 ? ' ▲' : e.dy < -12 ? ' ▼' : '';
        elEggDist.textContent = `${e.dist.toFixed(0)}m${vert}`;
        elEggCount.textContent = m.eggsNearby > 1 ? `주변 ${m.eggsNearby}개` : '';
      }

      if (flashTimer > 0) {
        flashTimer -= 1 / 60;
        if (flashTimer <= 0) elFlash.className = 'flash';
      }
    },
    flash(text: string, color: string) {
      elFlash.textContent = text;
      elFlash.style.color = color;
      elFlash.className = 'flash on';
      flashTimer = 1.6;
    },
  };
}
