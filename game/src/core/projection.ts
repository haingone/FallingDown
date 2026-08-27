/**
 * 순수 TS 핀홀 투영 — 렌더러(three.js PerspectiveCamera)와 동일한 카메라 모델.
 * 스와이프 히트 판정(화면 공간 선분-원 교차)이 로직 모듈 안에서 완결되도록 하기 위한 장치.
 *
 * 좌표계:
 *  - 월드: 소녀 = 원점 근방. -Y = 낙하 방향(적이 오는 쪽), 카메라 = (0, camHeight, 0)에서 -Y를 내려다봄.
 *  - 적은 y가 음수(원경)에서 +y로 접근, 소녀의 판정 평면 y=0을 지나 카메라 뒤로 프레임 아웃.
 *  - 화면: CSS px, 원점 = 스테이지 좌상단, +x 우측, +y 아래.
 *  - 월드 x → 화면 x, 월드 z → 화면 y (축 정렬 카메라라 투영이 단순 나눗셈으로 닫힘).
 */

export interface Viewport {
  width: number;   // CSS px
  height: number;  // CSS px
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export class Projector {
  viewport: Viewport = { width: 360, height: 640 };
  fovDeg = 60;
  camHeight = 6;

  /** 수직 FOV 기준 초점 거리 (px) */
  focal(): number {
    return (this.viewport.height / 2) / Math.tan((this.fovDeg * Math.PI) / 360);
  }

  /** 월드 (x, y, z) → 화면 CSS px. 카메라 뒤(depth<=0)는 null. */
  project(wx: number, wy: number, wz: number): ScreenPoint | null {
    const depth = this.camHeight - wy;
    if (depth <= 0.05) return null;
    const f = this.focal();
    return {
      x: this.viewport.width / 2 + (wx * f) / depth,
      y: this.viewport.height / 2 + (wz * f) / depth,
    };
  }

  /** 월드 반경 → 해당 깊이에서의 화면 반경(px) */
  projectRadius(worldRadius: number, wy: number): number {
    const depth = this.camHeight - wy;
    if (depth <= 0.05) return 0;
    return (worldRadius * this.focal()) / depth;
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
