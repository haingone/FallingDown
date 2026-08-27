/**
 * 성능 통계 미니 오버레이 (r3-3) — `?stats=1` 로 패널을 열지 않아도 좌하단에 상시 표시.
 * 실기기에서 패널을 여는 동작 없이 FPS·1% low·draw call을 읽기 위한 장치.
 */
import type { PerfTracker } from './perf';

export class StatsOverlay {
  private el: HTMLElement | null = null;
  private acc = 0;

  constructor(
    stage: HTMLElement,
    private perf: PerfTracker,
    private extra: () => { drawCalls: number; particles: number },
  ) {
    if (new URLSearchParams(location.search).get('stats') !== '1') return;
    this.el = document.createElement('div');
    this.el.id = 'stats-overlay';
    stage.appendChild(this.el);
  }

  update(dtMs: number): void {
    if (!this.el) return;
    this.acc += dtMs;
    if (this.acc < 200) return;
    this.acc = 0;
    const e = this.extra();
    this.el.innerHTML =
      `<b>${this.perf.fps().toFixed(0)}</b> fps` +
      `<span>1% low ${this.perf.onePercentLow().toFixed(0)}</span>` +
      `<span>draw ${e.drawCalls}</span>` +
      `<span>ptcl ${e.particles}</span>`;
  }
}
