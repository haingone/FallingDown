/**
 * 고정 타임스텝 러너 — 판정 일관성 확보 (지시문 아키텍처 요구사항).
 * 시뮬레이션은 120Hz 고정 스텝, 렌더러는 alpha로 보간.
 */
import { Sim } from './sim';

export class Runner {
  readonly fixedDt = 1 / 120;
  private acc = 0;
  /** 테스트/디버그용 배속 (튜닝 패널 노출 안 함 — 자가 검증 전용) */
  timeScale = 1;
  /** 마지막 tick의 보간 계수 (0..1) */
  alpha = 0;

  constructor(readonly sim: Sim) {}

  tick(realDtSec: number): void {
    this.acc += Math.min(realDtSec, 0.25) * this.timeScale;
    let steps = 0;
    while (this.acc >= this.fixedDt && steps < 1200) {
      this.sim.step(this.fixedDt);
      this.acc -= this.fixedDt;
      steps++;
    }
    this.alpha = this.acc / this.fixedDt;
  }

  /** 자가 검증용: 시뮬레이션 시간을 동기적으로 진행 */
  advance(seconds: number): void {
    const n = Math.round(seconds / this.fixedDt);
    for (let i = 0; i < n; i++) this.sim.step(this.fixedDt);
  }
}
