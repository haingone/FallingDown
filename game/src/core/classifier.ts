/**
 * 탭/스와이프 분류기 — 기획서 5장. 단일 모듈로 격리 (지시문 요구).
 *
 * 규칙 (기획서 5장 표):
 *  - 스와이프: 이동 거리 ≥ 24pt 또는 속도 임계 초과
 *  - 탭: 이동 거리 < 24pt AND 접촉 시간 < 200ms
 *  - 어느 쪽도 아니면(작게 움직이며 길게 누름) 무효 입력으로 분류 (기획서 미정 — 리포트 질문 항목)
 *
 * 모든 입력의 분류 결과와 근거 수치(이동량·시간·최대 속도)를 기록해 오분류율 계산에 쓴다.
 * 좌표는 CSS px (DPR 독립 — PointerEvent.clientX/Y가 CSS px이므로 그대로 사용).
 */
import { config } from './balance';

export type GestureKind = 'tap' | 'swipe' | 'none';

export interface GesturePoint {
  x: number;
  y: number;
  t: number; // ms
}

export interface GestureRecord {
  kind: GestureKind;
  distancePt: number;     // 시작점→최원점 거리
  pathLengthPt: number;   // 궤적 총 길이
  durationMs: number;
  peakSpeedPtMs: number;  // 최대 순간 속도 (pt/ms)
  reason: string;         // 분류 근거
  points: GesturePoint[];
  /** 스와이프로 확정된 시각 (move 도중 임계 돌파 시) — 실시간 베기 판정 시작점 */
  swipeConfirmedAtMs: number | null;
}

export class GestureClassifier {
  private active: GesturePoint[] | null = null;
  private peakSpeed = 0;
  private confirmedSwipeAt: number | null = null;
  readonly records: GestureRecord[] = [];

  begin(x: number, y: number, t: number): void {
    this.active = [{ x, y, t }];
    this.peakSpeed = 0;
    this.confirmedSwipeAt = null;
  }

  /**
   * 이동 갱신. move 도중 임계를 넘으면 그 즉시 스와이프로 확정해 true를 반환한다
   * (베기를 손가락을 떼기 전에 판정하기 위함 — 반응성 확보).
   */
  move(x: number, y: number, t: number): boolean {
    if (!this.active) return false;
    const prev = this.active[this.active.length - 1];
    const dt = Math.max(1, t - prev.t);
    const d = Math.hypot(x - prev.x, y - prev.y);
    this.peakSpeed = Math.max(this.peakSpeed, d / dt);
    this.active.push({ x, y, t });
    if (this.confirmedSwipeAt === null) {
      const start = this.active[0];
      const dist = Math.hypot(x - start.x, y - start.y);
      if (dist >= config.tapMaxDistancePt || this.peakSpeed > config.swipeSpeedThresholdPtMs) {
        this.confirmedSwipeAt = t;
        return true;
      }
    }
    return false;
  }

  /** 접촉 종료 → 최종 분류 확정 및 기록 */
  end(x: number, y: number, t: number): GestureRecord {
    const pts = this.active ?? [{ x, y, t }];
    pts.push({ x, y, t });
    this.active = null;

    const start = pts[0];
    const durationMs = t - start.t;
    let maxDist = 0;
    let pathLen = 0;
    for (let i = 1; i < pts.length; i++) {
      maxDist = Math.max(maxDist, Math.hypot(pts[i].x - start.x, pts[i].y - start.y));
      pathLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    }

    let kind: GestureKind;
    let reason: string;
    if (this.confirmedSwipeAt !== null || maxDist >= config.tapMaxDistancePt || this.peakSpeed > config.swipeSpeedThresholdPtMs) {
      kind = 'swipe';
      reason = maxDist >= config.tapMaxDistancePt
        ? `dist ${maxDist.toFixed(1)}pt >= ${config.tapMaxDistancePt}pt`
        : `peak ${this.peakSpeed.toFixed(2)}pt/ms > ${config.swipeSpeedThresholdPtMs}`;
    } else if (durationMs < config.tapMaxDurationMs) {
      kind = 'tap';
      reason = `dist ${maxDist.toFixed(1)}pt < ${config.tapMaxDistancePt}pt & ${durationMs.toFixed(0)}ms < ${config.tapMaxDurationMs}ms`;
    } else {
      kind = 'none';
      reason = `hold ${durationMs.toFixed(0)}ms >= ${config.tapMaxDurationMs}ms without swipe distance`;
    }

    const rec: GestureRecord = {
      kind,
      distancePt: maxDist,
      pathLengthPt: pathLen,
      durationMs,
      peakSpeedPtMs: this.peakSpeed,
      reason,
      points: pts,
      swipeConfirmedAtMs: this.confirmedSwipeAt,
    };
    this.records.push(rec);
    this.confirmedSwipeAt = null;
    return rec;
  }

  cancel(): void {
    this.active = null;
    this.confirmedSwipeAt = null;
  }

  /**
   * 오분류 "추정" 휴리스틱 (실제 의도는 알 수 없으므로 추정치):
   *  - 의심 탭: 임계 근접(거리 18pt 이상 또는 시간 160ms 이상) — 스와이프 의도였을 가능성
   *  - 의심 스와이프: 거리가 임계 바로 위(24~30pt)이고 히트 0건 — 탭 의도였을 가능성 (히트 여부는 호출측이 전달)
   */
  suspectStats(swipeHitFlags: boolean[]): { taps: number; swipes: number; none: number; suspects: number } {
    let taps = 0, swipes = 0, none = 0, suspects = 0;
    let swipeIdx = 0;
    for (const r of this.records) {
      if (r.kind === 'tap') {
        taps++;
        if (r.distancePt >= config.tapMaxDistancePt * 0.75 || r.durationMs >= config.tapMaxDurationMs * 0.8) suspects++;
      } else if (r.kind === 'swipe') {
        swipes++;
        const hit = swipeHitFlags[swipeIdx++] ?? false;
        if (!hit && r.distancePt < config.tapMaxDistancePt * 1.25) suspects++;
      } else {
        none++;
      }
    }
    return { taps, swipes, none, suspects };
  }
}
