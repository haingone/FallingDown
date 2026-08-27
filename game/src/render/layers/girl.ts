/**
 * 소녀 플레이스홀더 스프라이트 — 2등신 비율의 단색 실루엣(측면 뷰), 접음/펼침 2포즈.
 * 기획서 v2 4장 + P1 지시문 1. 아트 에셋 금지 원칙 → THREE.Shape 프로시저럴 폴리곤.
 *
 * 로컬 좌표: 머리 위 0.63 ~ 발 -0.47 (머리 지름 0.54 ≈ 목~발 높이 → 2등신), 원점 = 허리.
 */
import * as THREE from 'three';

const SILHOUETTE = 0x16202e;
const RIM = 0xeaf7ff;

export type GirlPose = 'fold' | 'open';

function polyShape(points: [number, number][]): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) s.lineTo(points[i][0], points[i][1]);
  s.closePath();
  return s;
}

/** 링 세그먼트(호) 모양 — 펼친 우산 캐노피용 */
function arcShape(cx: number, cy: number, rOut: number, rIn: number, a0: number, a1: number): THREE.Shape {
  const s = new THREE.Shape();
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    const x = cx + Math.cos(a) * rOut, y = cy + Math.sin(a) * rOut;
    if (i === 0) s.moveTo(x, y); else s.lineTo(x, y);
  }
  for (let i = steps; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / steps;
    s.lineTo(cx + Math.cos(a) * rIn, cy + Math.sin(a) * rIn);
  }
  s.closePath();
  return s;
}

function circleShape(cx: number, cy: number, r: number): THREE.Shape {
  const s = new THREE.Shape();
  s.absarc(cx, cy, r, 0, Math.PI * 2, false);
  return s;
}

/** 공통 몸체: 머리 + 위로 나부끼는 머리카락 + 몸통 + 다리 + 위로 뒤집힌 옷자락 */
function bodyShapes(): THREE.Shape[] {
  return [
    // 머리 (2등신: 머리 지름 ≈ 목~발 높이)
    circleShape(0.0, 0.36, 0.27),
    // 머리카락 (상방 나부낌 — 낙하 중이므로 위로 흐른다)
    polyShape([[-0.10, 0.55], [-0.30, 0.74], [-0.44, 0.66], [-0.34, 0.50], [-0.22, 0.42]]),
    polyShape([[0.04, 0.58], [0.20, 0.74], [0.30, 0.64], [0.18, 0.50]]),
    // 몸통 (어깨~허리)
    polyShape([[-0.13, 0.11], [0.13, 0.11], [0.11, -0.14], [-0.11, -0.14]]),
    // 코트 자락 (위로 뒤집힘)
    polyShape([[-0.12, 0.08], [-0.27, 0.24], [-0.31, 0.04], [-0.15, -0.08]]),
    polyShape([[0.12, 0.06], [0.26, 0.20], [0.28, 0.00], [0.14, -0.08]]),
    // 다리 (아래로 — 낙하 자세)
    polyShape([[-0.10, -0.12], [-0.015, -0.12], [-0.025, -0.47], [-0.095, -0.47]]),
    polyShape([[0.025, -0.12], [0.11, -0.12], [0.10, -0.43], [0.035, -0.43]]),
  ];
}

function foldShapes(): THREE.Shape[] {
  return [
    // 접은 우산: 손에서 아래-뒤로 뻗은 가는 막대 + 손잡이
    polyShape([[0.11, 0.00], [0.18, 0.04], [0.50, -0.42], [0.43, -0.47]]),
    polyShape([[0.11, 0.00], [0.18, 0.04], [0.07, 0.14], [0.02, 0.09]]),
    // 팔
    polyShape([[0.00, 0.08], [0.15, 0.04], [0.16, -0.04], [0.00, 0.00]]),
  ];
}

function openShapes(): THREE.Shape[] {
  return [
    // 펼친 우산 캐노피 (머리 위 반원 호 — 감속 자세)
    arcShape(0.0, 0.60, 0.54, 0.43, Math.PI * 0.05, Math.PI * 0.95),
    // 우산대
    polyShape([[-0.02, 0.62], [0.02, 0.62], [0.035, 0.06], [-0.005, 0.06]]),
    // 뽑은 검 (반대 손, 가늘고 예리)
    polyShape([[0.15, 0.00], [0.20, 0.03], [0.56, 0.28], [0.54, 0.21]]),
    // 팔
    polyShape([[0.00, 0.08], [0.17, 0.04], [0.18, -0.04], [0.00, 0.00]]),
  ];
}

function buildPose(shapes: THREE.Shape[]): THREE.Group {
  const g = new THREE.Group();
  const geo = new THREE.ShapeGeometry(shapes, 8);
  const rim = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: RIM, transparent: true, opacity: 0.6 }));
  rim.scale.setScalar(1.06);
  rim.position.z = -0.01;
  const body = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: SILHOUETTE }));
  g.add(rim, body);
  return g;
}

export class GirlSprite {
  readonly root = new THREE.Group();
  private fold: THREE.Group;
  private open: THREE.Group;

  constructor(heightWu = 1.15) {
    this.fold = buildPose([...bodyShapes(), ...foldShapes()]);
    this.open = buildPose([...bodyShapes(), ...openShapes()]);
    this.open.visible = false;
    const scale = heightWu / 1.21; // 로컬 실루엣 높이 ≈ 1.21 (머리 위 0.63 ~ 발 -0.47 + 여유)
    this.root.scale.setScalar(scale);
    this.root.add(this.fold, this.open);
  }

  setPose(pose: GirlPose): void {
    this.fold.visible = pose === 'fold';
    this.open.visible = pose === 'open';
  }
}
