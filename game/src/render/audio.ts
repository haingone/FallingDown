/**
 * WebAudio 합성 비프음 (M1 금지사항: 사운드 에셋 금지 — 합성음만).
 * 링 진입 큐는 게임플레이 장치이므로 지연(baseLatency/outputLatency)을 패널에 노출해 실측한다.
 */
export class Beeper {
  private ctx: AudioContext | null = null;

  /** 첫 사용자 제스처에서 호출 (모바일 자동재생 정책) */
  unlock(): void {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
      } catch {
        return;
      }
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  latencyMs(): { base: number; output: number } | null {
    if (!this.ctx) return null;
    return {
      base: (this.ctx.baseLatency ?? 0) * 1000,
      output: ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0) * 1000,
    };
  }

  private tone(freq: number, durMs: number, type: OscillatorType = 'square', gain = 0.08, sweepTo?: number): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (sweepTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(30, sweepTo), t0 + durMs / 1000);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + durMs / 1000);
    osc.connect(g).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + durMs / 1000 + 0.02);
  }

  ringEnter(): void { this.tone(1180, 45, 'square', 0.05); }       // 판정 링 진입 큐
  slash(): void { this.tone(320, 40, 'sawtooth', 0.05, 90); }
  kill(): void { this.tone(760, 90, 'square', 0.07, 240); }
  playerHit(): void { this.tone(110, 220, 'sawtooth', 0.12, 55); }
  toggle(open: boolean): void { this.tone(open ? 520 : 380, 35, 'triangle', 0.06); }
  gaugeFull(): void { this.tone(660, 120, 'square', 0.07, 990); }
  diveStart(): void { this.tone(220, 500, 'sawtooth', 0.1, 1400); }
  diveEnd(): void { this.tone(990, 180, 'square', 0.08, 330); }
  fail(): void { this.tone(220, 600, 'sawtooth', 0.1, 60); }
  clear(): void { this.tone(523, 140, 'square', 0.08, 1046); }
}
