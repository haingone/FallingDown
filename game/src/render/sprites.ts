/**
 * 플레이스홀더 스프라이트 — 전부 런타임 캔버스 생성 (에셋 임포트 금지 원칙).
 * 흰색 실루엣 + 알파로 그려 머티리얼 color로 틴트한다.
 *
 * 소녀: 2등신 비율 측면 뷰, 접음/펼침 2포즈 (기획서 v2 4장·부록 A).
 * 적: 상승하는 조류형 다트 실루엣 + 코드명 라벨 (기획서 10장 "선입견 금지" — 코드명만).
 */
import * as THREE from 'three';
import type { EnemyType } from '../core/sim';

function makeCanvas(w: number, h: number): { cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  return { cv, ctx: cv.getContext('2d')! };
}

function toTexture(cv: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/**
 * 소녀 실루엣. 2등신 = 머리 지름이 전체 높이의 약 1/2.
 * open=false: 접은 우산을 든 낙하 자세 / open=true: 펼친 우산 + 뽑은 검
 */
function drawGirl(ctx: CanvasRenderingContext2D, w: number, h: number, open: boolean): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const cx = w * 0.5;
  const headR = h * 0.19;
  const headY = h * 0.30;

  // 머리카락 (위로 나부낌) — 낙하 방향의 반대
  ctx.beginPath();
  ctx.moveTo(cx - headR * 0.9, headY - headR * 0.2);
  ctx.quadraticCurveTo(cx - headR * 2.0, headY - headR * 1.5, cx - headR * 2.6, headY - headR * 2.6);
  ctx.quadraticCurveTo(cx - headR * 0.9, headY - headR * 2.0, cx - headR * 0.2, headY - headR * 1.1);
  ctx.closePath();
  ctx.fill();

  // 머리
  ctx.beginPath();
  ctx.arc(cx, headY, headR, 0, Math.PI * 2);
  ctx.fill();

  // 몸통 (코트) — 아래로 갈수록 좁아지고 옷자락이 위로 흩날림
  const bodyTop = headY + headR * 0.82;
  const bodyBot = h * 0.80;
  ctx.beginPath();
  ctx.moveTo(cx - headR * 0.66, bodyTop);
  ctx.lineTo(cx + headR * 0.66, bodyTop);
  ctx.quadraticCurveTo(cx + headR * 0.9, bodyBot * 0.92, cx + headR * 0.42, bodyBot);
  ctx.lineTo(cx - headR * 0.42, bodyBot);
  ctx.quadraticCurveTo(cx - headR * 1.15, bodyBot * 0.90, cx - headR * 0.66, bodyTop);
  ctx.closePath();
  ctx.fill();

  // 다리 (아래로)
  ctx.lineWidth = headR * 0.34;
  ctx.beginPath();
  ctx.moveTo(cx - headR * 0.22, bodyBot);
  ctx.lineTo(cx - headR * 0.34, h * 0.96);
  ctx.moveTo(cx + headR * 0.22, bodyBot);
  ctx.lineTo(cx + headR * 0.46, h * 0.93);
  ctx.stroke();

  if (!open) {
    // 접은 우산: 앞으로 겨눈 가는 막대
    ctx.lineWidth = headR * 0.20;
    ctx.beginPath();
    ctx.moveTo(cx + headR * 0.35, bodyTop + headR * 0.45);
    ctx.lineTo(cx + headR * 2.35, bodyTop - headR * 0.55);
    ctx.stroke();
    // 팔
    ctx.lineWidth = headR * 0.28;
    ctx.beginPath();
    ctx.moveTo(cx + headR * 0.45, bodyTop + headR * 0.25);
    ctx.lineTo(cx + headR * 0.95, bodyTop + headR * 0.30);
    ctx.stroke();
  } else {
    // 펼친 우산: 머리 위 돔 + 대
    ctx.beginPath();
    ctx.arc(cx, headY - headR * 1.15, headR * 1.75, Math.PI * 1.04, Math.PI * 1.96);
    ctx.lineTo(cx, headY - headR * 1.15);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = headR * 0.16;
    ctx.beginPath();
    ctx.moveTo(cx, headY - headR * 1.15);
    ctx.lineTo(cx - headR * 0.30, bodyTop + headR * 0.55);
    ctx.stroke();
    // 뽑은 검 (반대 손, 아래로 겨눔)
    ctx.lineWidth = headR * 0.15;
    ctx.beginPath();
    ctx.moveTo(cx + headR * 0.45, bodyTop + headR * 0.30);
    ctx.lineTo(cx + headR * 2.05, bodyTop + headR * 1.75);
    ctx.stroke();
    ctx.lineWidth = headR * 0.30;
    ctx.beginPath();
    ctx.moveTo(cx + headR * 0.40, bodyTop + headR * 0.10);
    ctx.lineTo(cx + headR * 0.80, bodyTop + headR * 0.45);
    ctx.stroke();
  }
}

/** 적: 위를 향해 상승하는 조류형 다트 실루엣 + 코드명 */
function drawEnemy(ctx: CanvasRenderingContext2D, w: number, h: number, type: EnemyType): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  const cx = w * 0.5;
  const cy = h * 0.42;
  const s = w * 0.30;
  const stay = type === 'a-4' || type === 'a-5';

  ctx.beginPath();
  if (stay) {
    // 체류형: 각진 마름모 몸통 + 양 날개 (통과형과 실루엣으로 구분)
    ctx.moveTo(cx, cy - s * 1.15);
    ctx.lineTo(cx + s * 0.55, cy);
    ctx.lineTo(cx + s * 1.30, cy + s * 0.30);
    ctx.lineTo(cx + s * 0.45, cy + s * 0.62);
    ctx.lineTo(cx, cy + s * 1.20);
    ctx.lineTo(cx - s * 0.45, cy + s * 0.62);
    ctx.lineTo(cx - s * 1.30, cy + s * 0.30);
    ctx.lineTo(cx - s * 0.55, cy);
  } else {
    // 통과형: 위로 쐐기진 새 (진행 방향 = 위)
    ctx.moveTo(cx, cy - s * 1.25);
    ctx.lineTo(cx + s * 1.35, cy + s * 0.55);
    ctx.lineTo(cx + s * 0.38, cy + s * 0.22);
    ctx.lineTo(cx, cy + s * 1.05);
    ctx.lineTo(cx - s * 0.38, cy + s * 0.22);
    ctx.lineTo(cx - s * 1.35, cy + s * 0.55);
  }
  ctx.closePath();
  ctx.fill();

  ctx.font = `bold ${Math.round(w * 0.20)}px monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(type, cx, h * 0.87);
}

export class SpriteTextures {
  readonly girlFolded: THREE.CanvasTexture;
  readonly girlOpen: THREE.CanvasTexture;
  private enemyCache = new Map<EnemyType, THREE.CanvasTexture>();

  constructor() {
    const a = makeCanvas(160, 224);
    drawGirl(a.ctx, 160, 224, false);
    this.girlFolded = toTexture(a.cv);

    const b = makeCanvas(160, 224);
    drawGirl(b.ctx, 160, 224, true);
    this.girlOpen = toTexture(b.cv);
  }

  enemy(type: EnemyType): THREE.CanvasTexture {
    let tex = this.enemyCache.get(type);
    if (!tex) {
      const { cv, ctx } = makeCanvas(96, 112);
      drawEnemy(ctx, 96, 112, type);
      tex = toTexture(cv);
      this.enemyCache.set(type, tex);
    }
    return tex;
  }
}
