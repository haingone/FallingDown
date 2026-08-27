/**
 * 2D 평면 투영 (P1 HD-2D 전환) — M1의 원근 핀홀 투영을 대체한다.
 *
 * 기획서 v2 4장: 카메라는 고정 프레임. 소녀는 화면 세로 40~45%·가로 중앙에 떠 있고,
 * 게임플레이(판정)는 전부 하나의 2D 평면 위에서 일어난다. 3D 오브젝트 레이어는 연출 전용이라
 * 판정에 관여하지 않는다 → 투영은 "월드 wu ↔ 화면 px"의 선형 변환으로 닫힌다.
 *
 * 좌표계:
 *  - 월드: 소녀의 정위치(홈) = 원점. +x = 화면 오른쪽, **+y = 화면 위쪽**.
 *    적은 화면 아래(y 음수)에서 스폰해 +y로 상승, 링을 스치고 화면 위로 프레임 아웃한다.
 *  - 화면: CSS px, 원점 = 스테이지 좌상단, +x 우측, +y 아래 (y축 부호가 월드와 반대).
 *  - 카메라는 고정(월드 원점 기준). 도약 중 소녀만 화면 안을 이동한다.
 *  - 줌아웃(zoomOut)은 렌더러와 판정이 동일 값을 써야 한다 (기획서 4장 미세 줌 1.0→1.06).
 *    셰이크는 판정에 영향을 주지 않도록 배경·전경 레이어에만 적용한다 (리포트 편차 기록).
 */

export interface Viewport {
  width: number;   // CSS px
  height: number;  // CSS px
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export class Plane2D {
  viewport: Viewport = { width: 390, height: 844 };
  /** 화면 세로에 담기는 월드 높이 (wu) — 이 값이 wu↔px 스케일을 결정 */
  worldHeightWu = 10;
  /** 소녀의 화면 세로 위치 비율 (기획서 4장: 0.40~0.45) */
  girlScreenYPct = 0.42;
  /** 카메라 줌아웃 배수 (1.0 = 기준, 1.06 = 최고속). 클수록 더 넓게 보임 */
  zoomOut = 1;

  /** wu → px 스케일 */
  pxPerWu(): number {
    return this.viewport.height / (this.worldHeightWu * this.zoomOut);
  }

  /** 월드 원점(소녀 홈)의 화면 좌표 */
  originX(): number { return this.viewport.width / 2; }
  originY(): number { return this.viewport.height * this.girlScreenYPct; }

  /** 월드 (x, y) → 화면 CSS px */
  toScreen(wx: number, wy: number): ScreenPoint {
    const s = this.pxPerWu();
    return { x: this.originX() + wx * s, y: this.originY() - wy * s };
  }

  /** 화면 CSS px → 월드 (x, y) */
  toWorld(sx: number, sy: number): { x: number; y: number } {
    const s = this.pxPerWu();
    return { x: (sx - this.originX()) / s, y: (this.originY() - sy) / s };
  }

  /** 월드 반경 → 화면 반경 px */
  radiusToPx(worldRadius: number): number {
    return worldRadius * this.pxPerWu();
  }

  /** 화면 가로 절반의 월드 폭 (wu) */
  halfWidthWu(): number { return this.viewport.width / 2 / this.pxPerWu(); }
  /** 소녀 홈에서 화면 하단까지의 월드 거리 (wu) */
  belowWu(): number { return (this.viewport.height - this.originY()) / this.pxPerWu(); }
  /** 소녀 홈에서 화면 상단까지의 월드 거리 (wu) */
  aboveWu(): number { return this.originY() / this.pxPerWu(); }
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
