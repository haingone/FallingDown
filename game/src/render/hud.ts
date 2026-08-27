/**
 * HUD — HTML 오버레이 (기획서 15장 골격).
 * 상단 좌 HP / 상단 우 배율+콤보 / 하단 중앙 깃털 게이지 겸 도약 버튼.
 * 화면 중앙(전투 공간)에는 UI를 두지 않는다 (클리어/실패 배너는 전투 종료 후에만 표시).
 */
import type { Sim } from '../core/sim';
import { config } from '../core/balance';

export class Hud {
  private root: HTMLElement;
  private hpEl: HTMLElement;
  private multEl: HTMLElement;
  private comboEl: HTMLElement;
  private gaugeBtn: HTMLElement;
  private gaugeFill: HTMLElement;
  private gaugeText: HTMLElement;
  private waveEl: HTMLElement;
  private banner: HTMLElement;
  private flash: HTMLElement;
  private flashTimer = 0;

  constructor(stage: HTMLElement, onDive: () => void) {
    this.root = document.createElement('div');
    this.root.id = 'hud';
    this.root.innerHTML = `
      <div id="hud-hp"></div>
      <div id="hud-right"><span id="hud-mult">1.0x</span><span id="hud-combo"></span></div>
      <div id="hud-wave"></div>
      <div id="hud-banner"></div>
      <div id="hud-flash"></div>
      <div id="hud-gauge"><div id="hud-gauge-fill"></div><span id="hud-gauge-text">0%</span></div>
    `;
    stage.appendChild(this.root);
    this.hpEl = this.root.querySelector('#hud-hp')!;
    this.multEl = this.root.querySelector('#hud-mult')!;
    this.comboEl = this.root.querySelector('#hud-combo')!;
    this.gaugeBtn = this.root.querySelector('#hud-gauge')!;
    this.gaugeFill = this.root.querySelector('#hud-gauge-fill')!;
    this.gaugeText = this.root.querySelector('#hud-gauge-text')!;
    this.waveEl = this.root.querySelector('#hud-wave')!;
    this.banner = this.root.querySelector('#hud-banner')!;
    this.flash = this.root.querySelector('#hud-flash')!;

    // 도약 버튼: 게이지 UI와 통합된 전용 버튼 (기획서 5장 — 오입력 방지)
    this.gaugeBtn.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      onDive();
    });
  }

  playerHitFlash(): void { this.flashTimer = 0.25; }

  update(sim: Sim, dtSec: number): void {
    // HP 5칸
    let hearts = '';
    for (let i = 0; i < config.maxHp; i++) hearts += `<span class="hp ${i < sim.hp ? 'on' : 'off'}"></span>`;
    this.hpEl.innerHTML = hearts;

    // 배율 (속도 동기 숫자 + 색상)
    const m = sim.multiplier;
    this.multEl.textContent = `${m.toFixed(1)}x`;
    const t = (sim.speed - config.speedMin) / (config.speedMax - config.speedMin);
    this.multEl.style.color = `hsl(${120 - 120 * t}, 90%, 60%)`;

    // 콤보: 3.0x 유지 시에만 노출 (기획서 15장)
    this.comboEl.textContent = sim.speed >= config.speedMax - 1e-9 && sim.combo > 0 ? ` C${sim.combo}` : '';

    // 게이지 겸 도약 버튼 (100% 시 발광)
    const g = Math.min(1, sim.gauge);
    this.gaugeFill.style.width = `${(g * 100).toFixed(0)}%`;
    this.gaugeText.textContent = sim.diveActive ? 'DIVE!' : `${(g * 100).toFixed(0)}%`;
    this.gaugeBtn.classList.toggle('full', g >= 1 && !sim.diveActive);
    this.gaugeBtn.classList.toggle('diving', sim.diveActive);

    this.waveEl.textContent = sim.state === 'rest' ? '· · ·' : sim.currentWaveName;

    if (sim.state === 'clear') {
      this.banner.textContent = `CLEAR — score ${sim.score}`;
      this.banner.className = 'show clear';
    } else if (sim.state === 'fail') {
      this.banner.textContent = 'FAILED';
      this.banner.className = 'show fail';
    } else {
      this.banner.className = '';
    }

    if (this.flashTimer > 0) {
      this.flashTimer -= dtSec;
      this.flash.style.opacity = String(Math.max(0, this.flashTimer / 0.25) * 0.45);
    } else {
      this.flash.style.opacity = '0';
    }
  }
}
