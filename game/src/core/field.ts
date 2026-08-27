/**
 * 2D 플레이 평면 ↔ 화면 좌표 매핑 — M1의 원근 투영(projection.ts)을 대체한다.
 * 순수 TS, three.js/DOM 미의존 (로직-렌더링 분리 유지).
 *
 * 좌표계 (기획서 v2 4장 HD-2D 다운 스크롤):
 *  - 필드 단위: 1.0 = 화면 폭. 원점 = 화면 중앙.
 *  - x+ = 오른쪽, **y+ = 위쪽** (적은 하단에서 진입해 y+ 방향으로 상승하며 통과).
 *  - 화면: CSS px, 원점 = 스테이지 좌상단, +x 우측, +y 아래.
 *
 * 줌은 화면 중앙 기준으로 적용되며, 렌더러와 판정이 동일한 값을 쓴다 (시각-판정 동기).
 * 셰이크는 순수 연출이라 이 매핑에 반영하지 않는다 (리포트 편차 항목 참조).
 */

export interface ScreenPoint {
  x: number;
  y: number;
}

export class Field {
  width = 390;   // CSS px
  height = 844;  // CSS px
  zoom = 1;

  /** 화면 세로/가로 비 — 필드 높이(단위)와 같다 */
  get aspect(): number {
    return this.height / this.width;
  }

  setViewport(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** 화면 세로 비율(위에서부터 0~1)에 해당하는 필드 y */
  yAtScreenFraction(frac: number): number {
    return (0.5 - frac) * this.aspect;
  }

  /** 필드 상단/하단 경계 y */
  get topY(): number { return this.aspect / 2; }
  get bottomY(): number { return -this.aspect / 2; }

  /** 필드 좌표 → 화면 CSS px */
  toScreen(x: number, y: number): ScreenPoint {
    const s = this.width * this.zoom;
    return {
      x: this.width / 2 + x * s,
      y: this.height / 2 - y * s,
    };
  }

  /** 필드 길이 → 화면 px */
  toScreenLength(len: number): number {
    return len * this.width * this.zoom;
  }

  /** 화면 CSS px → 필드 좌표 */
  toField(sx: number, sy: number): { x: number; y: number } {
    const s = this.width * this.zoom;
    return {
      x: (sx - this.width / 2) / s,
      y: (this.height / 2 - sy) / s,
    };
  }
}

/** 선분 (a→b) 과 원(center c, 반경 r)의 교차 여부 — 스와이프 궤적 히트 판정 */
export function segmentIntersectsCircle(
  ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, r: number,
): boolean {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = 0;
  if (len2 > 0) {
    t = ((cx - ax) * dx + (cy - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const px = ax + t * dx - cx;
  const py = ay + t * dy - cy;
  return px * px + py * py <= r * r;
}

/**
 * 원 안의 점 p에서 방향 u로 진행할 때 원 밖으로 나가기까지의 거리.
 * 통과형의 "링 체류 시간" 규칙(기획서 v2 7장)을 2D에서 정확히 재현하기 위해 쓴다:
 * 링 내부 이동 속도 = (진입 시 산출한 잔여 경로) / dwellTime(현재 낙하 속도).
 */
export function distanceToExit(
  px: number, py: number, dirX: number, dirY: number,
  cx: number, cy: number, r: number,
): number {
  const len = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / len, uy = dirY / len;
  const mx = px - cx, my = py - cy;
  const b = mx * ux + my * uy;
  const c = mx * mx + my * my - r * r;
  const disc = b * b - c;
  if (disc <= 0) return 0;
  return Math.max(0, -b + Math.sqrt(disc));
}
