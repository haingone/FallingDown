/**
 * 판정 영역 전략 — 지시문 P1 r2 개정 (2026-08-27 사용자 결정, 실기기 실측으로 확정).
 * 순수 TS, three.js/DOM 미의존.
 *
 *  A. 원형 링  — 소녀 중심 2D 원 (기획서 v2 5장 원안). 반경 = ringRadiusFrac
 *  B. 화면 밴드 — 소녀 높이의 가로 발광 밴드 (AD 권고안). 높이 = bandHeightFrac
 *
 * 두 방식 모두 진입 하이라이트·비프음 큐와 체류 시간 규칙(기획서 v2 7장)을 동일하게 적용한다.
 * 시뮬레이션은 이 인터페이스로만 판정 영역을 다루므로 전환 비용이 없다.
 */
import { config } from './balance';

export type JudgeAreaKind = 'circle' | 'band';

export interface JudgeAreaStrategy {
  readonly kind: JudgeAreaKind;
  /** 점 (x, y)가 판정 영역 안인가 (소녀 위치 gx, gy 기준) */
  contains(x: number, y: number, gx: number, gy: number): boolean;
  /**
   * 영역 안의 점에서 방향 (dirX, dirY)로 진행할 때 영역을 벗어나기까지의 거리.
   * 링 내 이동 속도 = 이 거리 / dwellTime(속도) 로 쓰여 체류 시간 규칙을 정확히 재현한다.
   */
  distanceToExit(x: number, y: number, dirX: number, dirY: number, gx: number, gy: number): number;
  /** 도약 시 소녀를 화면 안에 묶어두기 위한 세로 반경 */
  halfExtentY(): number;
}

export const CIRCLE_AREA: JudgeAreaStrategy = {
  kind: 'circle',
  contains(x, y, gx, gy) {
    const r = config.ringRadiusFrac;
    const dx = x - gx, dy = y - gy;
    return dx * dx + dy * dy <= r * r;
  },
  distanceToExit(x, y, dirX, dirY, gx, gy) {
    const r = config.ringRadiusFrac;
    const len = Math.hypot(dirX, dirY) || 1;
    const ux = dirX / len, uy = dirY / len;
    const mx = x - gx, my = y - gy;
    const b = mx * ux + my * uy;
    const c = mx * mx + my * my - r * r;
    const disc = b * b - c;
    if (disc <= 0) return 0;
    return Math.max(0, -b + Math.sqrt(disc));
  },
  halfExtentY() {
    return config.ringRadiusFrac;
  },
};

export const BAND_AREA: JudgeAreaStrategy = {
  kind: 'band',
  contains(_x, y, _gx, gy) {
    return Math.abs(y - gy) <= config.bandHeightFrac / 2;
  },
  distanceToExit(_x, y, dirX, dirY, _gx, gy) {
    const halfH = config.bandHeightFrac / 2;
    // 밴드는 화면 가로 전체를 덮으므로 좌우로는 벗어나지 않는다 — 세로 성분만이 체류를 결정한다
    if (dirY > 1e-6) return Math.max(0, (gy + halfH - y) / dirY);
    if (dirY < -1e-6) return Math.max(0, (y - (gy - halfH)) / -dirY);
    void dirX;
    return config.bandHeightFrac; // 순수 수평 이동 (통과형에는 없는 경우) 안전값
  },
  halfExtentY() {
    return config.bandHeightFrac / 2;
  },
};

export function activeJudgeArea(): JudgeAreaStrategy {
  return config.judgeArea === 'band' ? BAND_AREA : CIRCLE_AREA;
}
