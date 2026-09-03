/**
 * HUD
 *
 * Phase 0: 속도·고도·층 표시, 착지 알림
 * Phase 1: 성장(단계·유전질량·친화도), 알 파인더, 운반 상태, 흡수 채널링
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

  /* ---------- 성장 (§6) ---------- */
  stage: number;
  geneMass: number;
  /** 다음 단계까지. 최대 단계면 null */
  nextStage: { need: number; progress: number } | null;
  affinityKind: string;
  /** 정규화된 친화도 상위 항목들 */
  affinityTop: { element: string; ratio: number }[];

  /* ---------- 운반 (§2) ---------- */
  carrying: { rarity: Rarity; element: string; geneMass: number } | null;
  /** 지금 E 로 주울 수 있는 알 */
  pickupTarget: { rarity: Rarity; element: string } | null;
  /** 홈 둥지 안에 있는가 */
  inHome: boolean;
  /** 흡수 채널링 진행도 0~1. 진행 중이 아니면 0 */
  absorbProgress: number;
  homeDistance: number;
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
      <div class="growth">
        <div class="gr-row"><b id="h-stage">해츨링</b><span id="h-mass">0</span></div>
        <div class="gr-bar"><i id="h-grbar"></i></div>
        <div class="gr-sub" id="h-affinity"></div>
      </div>
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
    <div class="carry" id="h-carry">
      <div class="cr-head">운반 중 · 이동 −25%</div>
      <div class="cr-name" id="h-carry-name">—</div>
      <div class="cr-hint" id="h-carry-hint"></div>
    </div>
    <div class="prompt" id="h-prompt"></div>
    <div class="absorb" id="h-absorb"><i id="h-absorb-bar"></i><span>흡수 중…</span></div>
    <div class="hud-right">
      <div class="keys">
        <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 이동</div>
        <div><kbd>Space</kbd> 상승 · <kbd>Shift</kbd> 하강</div>
        <div><kbd>E</kbd> 알 줍기 / 내려놓기</div>
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
  const elFlash = $('h-flash');
  const elStreaks = $('h-streaks');
  const elEgg = $('h-egg');
  const elEggArrow = $('h-egg-arrow');
  const elEggName = $('h-egg-name');
  const elEggDist = $('h-egg-dist');
  const elEggCount = $('h-egg-count');
  const elStageName = $('h-stage');
  const elMass = $('h-mass');
  const elGrBar = $('h-grbar');
  const elAffinity = $('h-affinity');
  const elCarry = $('h-carry');
  const elCarryName = $('h-carry-name');
  const elCarryHint = $('h-carry-hint');
  const elPrompt = $('h-prompt');
  const elAbsorb = $('h-absorb');
  const elAbsorbBar = $('h-absorb-bar');

  let flashTimer = 0;
  let lastAlert = '';

  return {
    update(m: HudModel) {
      elSpeed.textContent = m.speed.toFixed(0);
      elAlt.textContent = m.altitude.toFixed(0);

      elLayer.textContent = LAYER_LABEL[m.layer];
      elLayer.className = 'layer ' + m.layer;

      /* ---------- 성장 ---------- */
      elStageName.textContent = m.stageName;
      elMass.textContent = `유전질량 ${Math.round(m.geneMass)}`;
      if (m.nextStage) {
        elGrBar.style.width = (m.nextStage.progress * 100).toFixed(1) + '%';
        elGrBar.style.opacity = '1';
      } else {
        elGrBar.style.width = '100%';
        elGrBar.style.opacity = '0.5';
      }
      elAffinity.textContent = m.affinityTop.length
        ? `${m.affinityKind} · ` +
          m.affinityTop.map((a) => `${a.element} ${(a.ratio * 100).toFixed(0)}%`).join(' / ')
        : '아직 흡수한 알이 없습니다';

      /* ---------- 운반 ---------- */
      if (m.carrying) {
        elCarry.className = 'carry on';
        elCarryName.textContent =
          `${RARITY_LABEL[m.carrying.rarity]} · ${m.carrying.element} (+${m.carrying.geneMass})`;
        elCarryName.style.color = RARITY_COLOR[m.carrying.rarity];
        elCarryHint.textContent = m.inHome
          ? '둥지 안 — 흡수 중'
          : `둥지까지 ${m.homeDistance.toFixed(0)}m · E 로 내려놓기`;
      } else {
        elCarry.className = 'carry';
      }

      /* ---------- 상호작용 프롬프트 ---------- */
      if (!m.carrying && m.pickupTarget) {
        elPrompt.className = 'prompt on';
        elPrompt.innerHTML =
          `<kbd>E</kbd> ${RARITY_LABEL[m.pickupTarget.rarity]} · ${m.pickupTarget.element} 줍기`;
      } else {
        elPrompt.className = 'prompt';
      }

      /* ---------- 흡수 채널링 ---------- */
      if (m.absorbProgress > 0) {
        elAbsorb.className = 'absorb on';
        elAbsorbBar.style.width = (m.absorbProgress * 100).toFixed(1) + '%';
      } else {
        elAbsorb.className = 'absorb';
      }

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
