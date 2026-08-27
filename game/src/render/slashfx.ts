/**
 * 베기 궤적 이펙트 — 본 개편의 액션 아이덴티티 (P1 지시문 3, 기획서 v2 부록 A-2).
 *
 * 스와이프 궤적을 화면을 가로지르는 과장된 절단 궤적으로 확장해 그린다.
 *  - 우산(접음): 넓은 호 — 궤적을 바깥으로 부풀리고 폭이 크며 잔광이 길다
 *  - 검(펼침):   가늘고 예리 — 직선에 가깝고 선단이 날카로우며 잔광이 짧다
 * 텍스처 에셋 금지 → 리본 지오메트리 + 셰이더(프로시저럴)로만 구현.
 *
 * 화면 좌표(CSS px) 공간에서 동작한다 (y 아래 방향). 판정과 무관한 순수 연출 레이어.
 */
import * as THREE from 'three';
import type { Stance } from '../core/sim';

const MAX_POINTS = 28;
const MAX_SLASHES = 4;

const VERT = `
attribute float aT;
attribute float aV;
varying float vT;
varying float vV;
void main() {
  vT = aT; vV = aV;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = `
precision mediump float;
varying float vT;
varying float vV;
uniform vec3 uColor;
uniform vec3 uCore;
uniform float uSweep;    // 0..1 절단선이 지나간 지점
uniform float uFade;     // 0..1 잔광 감쇠
uniform float uCoreWidth;
void main() {
  // 아직 칼이 지나가지 않은 구간은 그리지 않는다 (절단이 훑고 지나가는 느낌)
  float pass = step(vT, uSweep);
  // 가로(폭) 방향: 폭넓은 잔광 + 그 안의 밝은 코어 (부록 A-2의 "폭이 크고 잔광이 남는 흰 궤적")
  float a = abs(vV);
  float glow = pow(1.0 - a, 3.0);
  float core = smoothstep(uCoreWidth, 0.0, a);
  // 절단 선단(sweep front) 근처를 강하게 발광
  float front = smoothstep(0.24, 0.0, uSweep - vT);
  vec3 col = mix(uColor, uCore, clamp(core + front, 0.0, 1.0));
  float body = core * 1.5 + glow * 0.6 + front * 0.9;
  float alpha = body * uFade * pass;
  if (alpha < 0.008) discard;
  gl_FragColor = vec4(col * (1.0 + front * 1.4), alpha);
}
`;

interface Slash {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  posAttr: THREE.BufferAttribute;
  tAttr: THREE.BufferAttribute;
  vAttr: THREE.BufferAttribute;
  life: number;
  duration: number;
}

export interface SlashStyle {
  widthPx: number;
  durationSec: number;
  sweepFraction: number; // 수명 중 절단선이 훑는 구간 비율
  bow: number;           // 호 부풀림 (궤적 길이 대비)
  extend: number;        // 화면 가로지르기 연장 배수
  color: number;
  core: number;
  coreWidth: number;
}

export const UMBRELLA_STYLE: SlashStyle = {
  widthPx: 112, durationSec: 0.32, sweepFraction: 0.28, bow: 0.17, extend: 1.9,
  color: 0xfff0d8, core: 0xffffff, coreWidth: 0.30,
};
export const SWORD_STYLE: SlashStyle = {
  widthPx: 44, durationSec: 0.20, sweepFraction: 0.20, bow: 0.03, extend: 2.3,
  color: 0xd8f0ff, core: 0xffffff, coreWidth: 0.14,
};

export class SlashFx {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  private pool: Slash[] = [];
  private cursor = 0;
  private width = 390;
  private height = 844;

  constructor() {
    // 화면 px 공간 (좌상단 원점, +y 아래) — 스와이프 좌표를 그대로 쓴다
    this.camera = new THREE.OrthographicCamera(0, this.width, 0, this.height, -1, 1);

    for (let i = 0; i < MAX_SLASHES; i++) {
      const geo = new THREE.BufferGeometry();
      const pos = new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 2 * 3), 3);
      const aT = new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 2), 1);
      const aV = new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 2), 1);
      pos.setUsage(THREE.DynamicDrawUsage);
      aT.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', pos);
      geo.setAttribute('aT', aT);
      geo.setAttribute('aV', aV);
      const idx: number[] = [];
      for (let s = 0; s < MAX_POINTS - 1; s++) {
        const a = s * 2, b = s * 2 + 1, c = s * 2 + 2, d = s * 2 + 3;
        idx.push(a, b, c, b, d, c);
      }
      geo.setIndex(idx);
      geo.setDrawRange(0, 0);
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        // 리본 삼각형의 감김 방향은 스와이프 방향에 따라 뒤집히므로 양면 렌더가 필수
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        uniforms: {
          uColor: { value: new THREE.Color(UMBRELLA_STYLE.color) },
          uCore: { value: new THREE.Color(0xffffff) },
          uSweep: { value: 0 },
          uFade: { value: 0 },
          uCoreWidth: { value: 0.3 },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.scene.add(mesh);
      this.pool.push({ mesh, mat, posAttr: pos, tAttr: aT, vAttr: aV, life: 0, duration: 1 });
    }
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.camera.left = 0; this.camera.right = width;
    this.camera.top = 0; this.camera.bottom = height;
    this.camera.updateProjectionMatrix();
  }

  activeCount(): number { return this.pool.filter(s => s.life > 0).length; }

  /**
   * 스와이프 궤적(화면 px) → 과장된 절단 궤적 생성.
   * @param path 스와이프 경로 (최소 2점)
   */
  trigger(path: { x: number; y: number }[], stance: Stance): void {
    if (path.length < 2) return;
    const style = stance === 'umbrella' ? UMBRELLA_STYLE : SWORD_STYLE;
    const slash = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % MAX_SLASHES;

    // 1) 균등 리샘플 (손가락 궤적의 들쭉날쭉함 제거)
    const sampled = resample(path, MAX_POINTS);
    // 2) 시작→끝 방향으로 양끝 연장 → "화면을 가로지르는" 과장
    const ax = sampled[0].x, ay = sampled[0].y;
    const bx = sampled[sampled.length - 1].x, by = sampled[sampled.length - 1].y;
    let dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len; dy /= len;
    const diag = Math.hypot(this.width, this.height);
    const target = Math.min(diag * 1.05, len * style.extend);
    const ext = Math.max(0, (target - len) / 2);
    // 3) 우산은 진행 방향 수직으로 부풀려 넓은 호를 만든다
    const nx = -dy, ny = dx;
    const bow = style.bow * target * curveSign(sampled, nx, ny);

    const pts: { x: number; y: number }[] = [];
    const n = MAX_POINTS;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      // 연장 구간 포함 전체 파라미터 (-ext .. len+ext)
      const s = -ext + t * (len + ext * 2);
      let px: number, py: number;
      if (s < 0 || s > len) {
        px = ax + dx * s; py = ay + dy * s;
      } else {
        const q = sampleAt(sampled, s / len);
        px = q.x; py = q.y;
      }
      const bulge = Math.sin(Math.PI * t) * bow;
      pts.push({ x: px + nx * bulge, y: py + ny * bulge });
    }

    // 4) 리본 정점 생성 (방추형 폭 프로파일)
    const pos = slash.posAttr, aT = slash.tAttr, aV = slash.vAttr;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const prev = pts[Math.max(0, i - 1)], next = pts[Math.min(n - 1, i + 1)];
      let tx = next.x - prev.x, ty = next.y - prev.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl; ty /= tl;
      const half = style.widthPx * 0.5 * widthProfile(t, stance);
      const ox = -ty * half, oy = tx * half;
      pos.setXYZ(i * 2, pts[i].x + ox, pts[i].y + oy, 0);
      pos.setXYZ(i * 2 + 1, pts[i].x - ox, pts[i].y - oy, 0);
      aT.setX(i * 2, t); aT.setX(i * 2 + 1, t);
      aV.setX(i * 2, 1); aV.setX(i * 2 + 1, -1);
    }
    pos.needsUpdate = true; aT.needsUpdate = true; aV.needsUpdate = true;
    slash.mesh.geometry.setDrawRange(0, (n - 1) * 6);
    slash.mat.uniforms.uColor.value.setHex(style.color);
    slash.mat.uniforms.uCore.value.setHex(style.core);
    slash.mat.uniforms.uCoreWidth.value = style.coreWidth;
    slash.mat.uniforms.uSweep.value = 0;
    slash.mat.uniforms.uFade.value = 1;
    slash.duration = style.durationSec;
    slash.life = style.durationSec;
    slash.mesh.visible = true;
    (slash.mesh.userData as { sweepFraction: number }).sweepFraction = style.sweepFraction;
  }

  update(dtSec: number): void {
    for (const s of this.pool) {
      if (s.life <= 0) continue;
      s.life -= dtSec;
      if (s.life <= 0) { s.mesh.visible = false; continue; }
      const elapsed = 1 - s.life / s.duration;
      const sweepFraction = (s.mesh.userData as { sweepFraction: number }).sweepFraction ?? 0.3;
      s.mat.uniforms.uSweep.value = Math.min(1, elapsed / sweepFraction);
      // 잔광: 절단 직후 최대, 이후 감쇠
      s.mat.uniforms.uFade.value = Math.pow(s.life / s.duration, 0.85);
    }
  }
}

/** 폭 프로파일 — 우산: 가운데가 두꺼운 방추형 / 검: 대부분 균일하고 선단만 뾰족 */
function widthProfile(t: number, stance: Stance): number {
  if (stance === 'umbrella') return Math.pow(Math.sin(Math.PI * t), 0.55);
  return Math.pow(Math.min(1, 5 * t * (1 - t)), 0.28);
}

/** 궤적의 휨 방향 부호 (실제 스와이프가 휜 쪽으로 호를 부풀린다) */
function curveSign(pts: { x: number; y: number }[], nx: number, ny: number): number {
  const a = pts[0], b = pts[pts.length - 1];
  const m = pts[Math.floor(pts.length / 2)];
  const s = (m.x - (a.x + b.x) / 2) * nx + (m.y - (a.y + b.y) / 2) * ny;
  return s >= 0 ? 1 : -1;
}

/** 경로를 n개 점으로 등간격 리샘플 */
function resample(path: { x: number; y: number }[], n: number): { x: number; y: number }[] {
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
  }
  const total = cum[cum.length - 1];
  if (total <= 0.0001) return [path[0], path[path.length - 1]];
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const target = (total * i) / (n - 1);
    let k = 1;
    while (k < cum.length - 1 && cum[k] < target) k++;
    const seg = cum[k] - cum[k - 1] || 1;
    const f = (target - cum[k - 1]) / seg;
    out.push({
      x: path[k - 1].x + (path[k].x - path[k - 1].x) * f,
      y: path[k - 1].y + (path[k].y - path[k - 1].y) * f,
    });
  }
  return out;
}

/** 리샘플된 경로에서 0..1 파라미터 위치 */
function sampleAt(pts: { x: number; y: number }[], u: number): { x: number; y: number } {
  const f = Math.max(0, Math.min(1, u)) * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  const k = f - i;
  return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * k, y: pts[i].y + (pts[i + 1].y - pts[i].y) * k };
}
