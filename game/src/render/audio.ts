/**
 * WebAudio 합성 비프음 (M1 금지사항: 사운드 에셋 금지 — 합성음만).
 * 링 진입 큐는 게임플레이 장치이므로 지연(baseLatency/outputLatency)을 패널에 노출해 실측한다.
 */
import { config } from '../core/balance';

export class Beeper {
  private ctx: AudioContext | null = null;
  /** 동시발음 제한용 — 재생 중인 격파음 수 */
  private killVoices = 0;
  /** 연속 격파 피치 스택 */
  private killStack = 0;
  private lastKillAt = -1e9;

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

  ringEnter(): void { this.tone(1180, 45, 'square', 0.05); }       // 판정 밴드 진입 큐
  slash(): void { this.tone(320, 40, 'sawtooth', 0.05, 90); }

  /**
   * 격파음 (r3 항목 4) — 저역 펀치 + 고역 슬라이스의 2성분 합성.
   * 연속 격파 시 반음 단위로 피치가 쌓여 편대 쓸기가 상승 프레이즈로 들린다.
   * 동시발음 제한으로 다중 격파 시 소리가 뭉개지는 것을 막는다.
   */
  kill(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running' || config.killSoundGain <= 0) return;
    if (this.killVoices >= Math.max(1, config.soundVoiceLimit)) return;

    const now = ctx.currentTime;
    // 연속 격파 판정: 0.55초 안에 이어지면 스택 상승, 끊기면 리셋
    if (now - this.lastKillAt > 0.55) this.killStack = 0;
    else this.killStack = Math.min(config.killPitchStackMax, this.killStack + 1);
    this.lastKillAt = now;
    const semi = Math.pow(2, this.killStack / 12);
    const g = config.killSoundGain;

    this.killVoices++;
    const release = () => { this.killVoices = Math.max(0, this.killVoices - 1); };

    // 저역 펀치 — 몸통을 때리는 감각
    const punch = ctx.createOscillator();
    const punchGain = ctx.createGain();
    punch.type = 'triangle';
    punch.frequency.setValueAtTime(160 * semi, now);
    punch.frequency.exponentialRampToValueAtTime(46, now + 0.09);
    punchGain.gain.setValueAtTime(0.16 * g, now);
    punchGain.gain.exponentialRampToValueAtTime(0.001, now + 0.11);
    punch.connect(punchGain).connect(ctx.destination);
    punch.start(now);
    punch.stop(now + 0.13);
    punch.onended = release;

    // 고역 슬라이스 — 베어낸 날의 결
    const slice = ctx.createOscillator();
    const sliceGain = ctx.createGain();
    slice.type = 'sawtooth';
    slice.frequency.setValueAtTime(2600 * semi, now);
    slice.frequency.exponentialRampToValueAtTime(900 * semi, now + 0.07);
    sliceGain.gain.setValueAtTime(0.05 * g, now);
    sliceGain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    slice.connect(sliceGain).connect(ctx.destination);
    slice.start(now);
    slice.stop(now + 0.1);
  }
  playerHit(): void { this.tone(110, 220, 'sawtooth', 0.12, 55); }
  toggle(open: boolean): void { this.tone(open ? 520 : 380, 35, 'triangle', 0.06); }
  gaugeFull(): void { this.tone(660, 120, 'square', 0.07, 990); }
  diveStart(): void { this.tone(220, 500, 'sawtooth', 0.1, 1400); }
  diveEnd(): void { this.tone(990, 180, 'square', 0.08, 330); }
  fail(): void { this.tone(220, 600, 'sawtooth', 0.1, 60); }
  clear(): void { this.tone(523, 140, 'square', 0.08, 1046); }
}
