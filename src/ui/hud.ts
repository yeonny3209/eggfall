/**
 * HUD — Phase 0 (단순 조작 버전)
 *
 * 스태미나·실속·상승기류가 사라졌으니 HUD 도 그만큼 가벼워진다.
 * 지금 보여줄 건 속도·고도·층 표시, 그리고 착지 여부뿐이다.
 */

import type { Layer } from '../types';

export type HudModel = {
  speed: number;
  altitude: number;
  layer: Layer;
  grounded: boolean;
  stageName: string;
  /** 0~1, 이동속도 대비 */
  speedRatio: number;
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
