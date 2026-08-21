/** FPS 실측 — 현재 FPS(최근 30프레임 평균) + 1% low (최근 600프레임 상위 1% 프레임타임 역수) */
export class PerfTracker {
  private frameTimes: number[] = [];
  private readonly cap = 600;

  frame(dtMs: number): void {
    if (dtMs <= 0 || dtMs > 1000) return;
    this.frameTimes.push(dtMs);
    if (this.frameTimes.length > this.cap) this.frameTimes.shift();
  }

  fps(): number {
    const n = Math.min(30, this.frameTimes.length);
    if (n === 0) return 0;
    let sum = 0;
    for (let i = this.frameTimes.length - n; i < this.frameTimes.length; i++) sum += this.frameTimes[i];
    return 1000 / (sum / n);
  }

  onePercentLow(): number {
    if (this.frameTimes.length < 60) return 0;
    const sorted = [...this.frameTimes].sort((a, b) => b - a);
    const k = Math.max(1, Math.floor(sorted.length * 0.01));
    let sum = 0;
    for (let i = 0; i < k; i++) sum += sorted[i];
    return 1000 / (sum / k);
  }

  reset(): void { this.frameTimes.length = 0; }
}
