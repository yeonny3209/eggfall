/**
 * HUD — Phase 0
 *
 * 이 단계에서 HUD 가 할 일은 딱 하나다: **비행 상태를 몸으로 읽히게 하는 것.**
 * 속도·고도·스태미나·실속·상승기류. 그 외에는 아직 아무것도 표시하지 않는다.
 */

import type { Layer } from '../types';

/** 레이더에 찍을 상승기류 한 점 (플레이어 기준 상대 좌표) */
export type RadarBlip = { dx: number; dz: number; inside: boolean };

export type HudModel = {
  speed: number;
  altitude: number;
  stamina: number;
  staminaMax: number;
  layer: Layer;
  /** 0~1 */
  thermal: number;
  stalling: boolean;
  grounded: boolean;
  diving: boolean;
  stageName: string;
  /** 0~1, 최대 속도 대비 */
  speedRatio: number;
  /** 플레이어 기수 방향 (rad) — 레이더 회전용 */
  yaw: number;
  blips: RadarBlip[];
};

const LAYER_LABEL: Record<Layer, string> = {
  low: '하층 · 협곡',
  mid: '중층 · 주 전장',
  high: '고층 · 스태미나 소모',
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
      <div class="stam">
        <div class="stam-bar"><i id="h-stam"></i></div>
        <span class="label" id="h-stam-txt">100</span>
      </div>
      <div class="layer" id="h-layer">중층</div>
    </div>
    <div class="hud-center">
      <div id="h-alert" class="alert"></div>
    </div>
    <canvas id="h-radar" class="radar" width="150" height="150"></canvas>
    <div id="h-streaks" class="streaks"></div>
    <div id="h-vig" class="vignette"></div>
    <div class="hud-right">
      <div class="stage" id="h-stage">드레이크</div>
      <div class="keys">
        <div><kbd>W</kbd><kbd>S</kbd> 기수</div>
        <div><kbd>A</kbd><kbd>D</kbd> 선회</div>
        <div><kbd>Q</kbd><kbd>E</kbd> 롤</div>
        <div><kbd>Space</kbd> 날갯짓</div>
        <div><kbd>Shift</kbd> 급강하</div>
        <div class="dim">클릭 → 마우스 시점</div>
      </div>
    </div>
    <div id="h-flash" class="flash"></div>
  `;

  const $ = (id: string) => document.getElementById(id)!;
  const elSpeed = $('h-speed');
  const elAlt = $('h-alt');
  const elStam = $('h-stam');
  const elStamTxt = $('h-stam-txt');
  const elLayer = $('h-layer');
  const elAlert = $('h-alert');
  const elStage = $('h-stage');
  const elFlash = $('h-flash');
  const radar = $('h-radar') as HTMLCanvasElement;
  const rctx = radar.getContext('2d')!;
  const elStreaks = $('h-streaks');
  const elVig = $('h-vig');
  const RADAR_RANGE = 1400;   // m — 이 반경 안의 기류만 표시한다

  let flashTimer = 0;
  let lastAlert = '';

  /**
   * 상승기류 레이더.
   * 기류는 Phase 0 의 핵심 자원인데 눈으로만 찾으면 대부분 놓친다.
   * 기수 방향이 항상 위를 향하도록 회전시켜 "어느 쪽으로 틀어야 하는가"가 바로 읽히게 한다.
   */
  function drawRadar(m: HudModel) {
    const w = radar.width;
    const c = w / 2;
    rctx.clearRect(0, 0, w, w);

    // 배경
    rctx.beginPath();
    rctx.arc(c, c, c - 2, 0, Math.PI * 2);
    rctx.fillStyle = 'rgba(8,14,24,0.55)';
    rctx.fill();
    rctx.strokeStyle = 'rgba(80,110,150,0.5)';
    rctx.lineWidth = 1;
    rctx.stroke();

    // 거리 링
    rctx.strokeStyle = 'rgba(80,110,150,0.22)';
    for (const f of [0.33, 0.66]) {
      rctx.beginPath();
      rctx.arc(c, c, (c - 2) * f, 0, Math.PI * 2);
      rctx.stroke();
    }

    // 기류 표시
    for (const b of m.blips) {
      // 월드 좌표를 기수 기준으로 회전 (기수가 항상 화면 위쪽)
      const cos = Math.cos(m.yaw);
      const sin = Math.sin(m.yaw);
      const rx = b.dx * cos - b.dz * sin;
      const rz = b.dx * sin + b.dz * cos;
      const d = Math.hypot(rx, rz);
      if (d > RADAR_RANGE) continue;
      const px = c + (rx / RADAR_RANGE) * (c - 8);
      const py = c - (rz / RADAR_RANGE) * (c - 8);
      rctx.beginPath();
      rctx.arc(px, py, b.inside ? 6 : 4, 0, Math.PI * 2);
      rctx.fillStyle = b.inside ? 'rgba(140,234,255,0.95)' : 'rgba(102,224,255,0.5)';
      rctx.fill();
    }

    // 자기 위치 — 기수 방향 삼각형
    rctx.beginPath();
    rctx.moveTo(c, c - 7);
    rctx.lineTo(c - 5, c + 5);
    rctx.lineTo(c + 5, c + 5);
    rctx.closePath();
    rctx.fillStyle = '#ffd9a8';
    rctx.fill();
  }

  return {
    update(m: HudModel) {
      elSpeed.textContent = m.speed.toFixed(0);
      elAlt.textContent = m.altitude.toFixed(0);

      const r = Math.max(0, Math.min(1, m.stamina / m.staminaMax));
      elStam.style.width = (r * 100).toFixed(1) + '%';
      // 30% 아래로 떨어지면 색으로 경고한다 — 스태미나 고갈은 사실상 패배다
      elStam.style.background =
        r < 0.3 ? 'linear-gradient(90deg,#ff5c6c,#ff9aa6)' : 'linear-gradient(90deg,#2e8b8b,#6ee7d7)';
      elStamTxt.textContent = m.stamina.toFixed(0);

      elLayer.textContent = LAYER_LABEL[m.layer];
      elLayer.className = 'layer ' + m.layer;
      elStage.textContent = m.stageName;

      // 경고는 우선순위 하나만 띄운다. 여러 개가 겹치면 아무것도 안 읽힌다.
      let alert = '';
      let cls = '';
      if (m.grounded) {
        alert = '착륙 — Space 로 이륙';
        cls = 'warn';
      } else if (m.stalling) {
        alert = '실속 · 속도 부족';
        cls = 'bad';
      } else if (m.thermal > 0.05) {
        alert = '상승기류 ▲ ' + (m.thermal * 100).toFixed(0) + '%';
        cls = 'good';
      } else if (m.diving) {
        alert = '급강하';
        cls = 'dive';
      }
      if (alert !== lastAlert) {
        elAlert.textContent = alert;
        elAlert.className = 'alert ' + cls;
        lastAlert = alert;
      }

      /* ---------- 속도 스트릭 ---------- */
      // 숫자만으로는 속도가 몸에 안 와닿는다. 화면 가장자리가 흘러야 빠르다고 느낀다.
      const streak = Math.max(0, (m.speedRatio - 0.5) / 0.5);
      elStreaks.style.opacity = String(streak * (m.diving ? 0.9 : 0.55));

      /* ---------- 상태 비네트 ---------- */
      // 색 하나로 지금이 위험한지(실속) 신나는지(급강하) 알려준다.
      let vig = 'vignette';
      if (m.stalling) vig += ' stall';
      else if (m.diving) vig += ' dive';
      else if (m.thermal > 0.05) vig += ' lift';
      if (elVig.className !== vig) elVig.className = vig;

      /* ---------- 상승기류 레이더 ---------- */
      drawRadar(m);

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
