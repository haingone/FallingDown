/**
 * 격파 피드백("손맛") 이펙트 — 지시문 P1 r3-2, 기획서 v2.2 16장 1번.
 * 전부 프로시저럴 (셰이더 + 런타임 지오메트리). 아트 에셋 없음.
 *
 * 담당 항목:
 *  1. 파편 버스트 — 적 색상 파편 + 흰 코어 스파크, 스와이프 방향 지향성 분사
 *  2. 임팩트 플래시 + 격파 스프라이트 화이트아웃 → 스케일 팝(1.0→1.25→0)
 *  3. 카메라 펀치 (줌킥) — 다중 격파는 1회로 합산
 *  5. 밴드 히트 플래시 — 격파 순간 밴드가 밝아지고 두꺼워짐
 *
 * 과부하 방지: 파편은 고정 버퍼(총량 상한 config.particleBudget)를 링 버퍼로 재사용하고,
 * 플래시·고스트·펀치는 풀 상한 + 프레임당 1회 합산으로 묶는다.
 */
import * as THREE from 'three';
import { config } from '../core/balance';
import * as PAL from './palette';

const MAX_DEBRIS = 260;
const MAX_SPARKS = 140;
const FLASH_POOL = 8;
const GHOST_POOL = 10;

/** 포인트 스프라이트: 부드러운 원형 도트, 개별 색·크기·알파 */
const POINT_VERT = /* glsl */`
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  uniform float uPxPerUnit;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    gl_PointSize = max(1.0, aSize * uPxPerUnit);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const POINT_FRAG = /* glsl */`
  precision mediump float;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float a = smoothstep(0.5, 0.12, d) * vAlpha;
    if (a <= 0.001) discard;
    gl_FragColor = vec4(vColor, a);
  }
`;

/** 방사형 임팩트 플래시 */
const FLASH_FRAG = /* glsl */`
  precision mediump float;
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float d = length(p);
    float core = smoothstep(0.55, 0.0, d);
    // 방사 스파이크
    float ang = atan(p.y, p.x);
    float rays = 0.5 + 0.5 * cos(ang * 8.0);
    float ring = smoothstep(1.0, 0.55, d) * rays * 0.45;
    float a = (core + ring) * uAlpha;
    gl_FragColor = vec4(mix(uColor, vec3(1.0), core), a);
  }
`;
const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

interface ParticleField {
  points: THREE.Points;
  pos: THREE.BufferAttribute;
  col: THREE.BufferAttribute;
  size: THREE.BufferAttribute;
  alpha: THREE.BufferAttribute;
  mat: THREE.ShaderMaterial;
  vx: Float32Array;
  vy: Float32Array;
  life: Float32Array;
  maxLife: Float32Array;
  cursor: number;
  capacity: number;
  /** 총량 상한(config.particleBudget) 중 이 버퍼가 가져가는 몫 */
  budgetShare: number;
}

interface Flash {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  life: number;
  maxLife: number;
}

interface Ghost {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  baseSize: number;
  color: THREE.Color;
}

function makeParticleField(
  scene: THREE.Scene, capacity: number, z: number, additive: boolean, budgetShare: number,
): ParticleField {
  const geo = new THREE.BufferGeometry();
  const pos = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
  const col = new THREE.BufferAttribute(new Float32Array(capacity * 3), 3);
  const size = new THREE.BufferAttribute(new Float32Array(capacity), 1);
  const alpha = new THREE.BufferAttribute(new Float32Array(capacity), 1);
  pos.setUsage(THREE.DynamicDrawUsage);
  col.setUsage(THREE.DynamicDrawUsage);
  size.setUsage(THREE.DynamicDrawUsage);
  alpha.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', pos);
  geo.setAttribute('aColor', col);
  geo.setAttribute('aSize', size);
  geo.setAttribute('aAlpha', alpha);
  const mat = new THREE.ShaderMaterial({
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    uniforms: { uPxPerUnit: { value: 390 } },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.position.z = z;
  points.frustumCulled = false;
  scene.add(points);
  return {
    points, pos, col, size, alpha, mat,
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    life: new Float32Array(capacity),
    maxLife: new Float32Array(capacity),
    cursor: 0,
    capacity,
    budgetShare,
  };
}

export class JuiceFx {
  private debris: ParticleField;
  private sparks: ParticleField;
  private flashes: Flash[] = [];
  private ghosts: Ghost[] = [];

  private punch = 0;        // 현재 카메라 펀치 (줌 배수 - 1)
  private punchLife = 0;
  private punchMax = 0;
  private punchArmed = false; // 이번 프레임에 이미 펀치했는가 (다중 격파 합산)

  private bandFlashLife = 0;
  private bandFlashMax = 0;

  constructor(scene: THREE.Scene, zBase: number) {
    // 총량 상한을 두 버퍼가 용량 비율로 나눠 가진다 → 합계가 config.particleBudget을 넘지 않는다
    const total = MAX_DEBRIS + MAX_SPARKS;
    this.debris = makeParticleField(scene, MAX_DEBRIS, zBase, false, MAX_DEBRIS / total);
    this.sparks = makeParticleField(scene, MAX_SPARKS, zBase + 0.01, true, MAX_SPARKS / total);

    const quad = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < FLASH_POOL; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: QUAD_VERT,
        fragmentShader: FLASH_FRAG,
        uniforms: { uColor: { value: new THREE.Color(0xffffff) }, uAlpha: { value: 0 } },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(quad, mat);
      mesh.position.z = zBase + 0.02;
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.flashes.push({ mesh, mat, life: 0, maxLife: 0.1 });
    }

    for (let i = 0; i < GHOST_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
      const mesh = new THREE.Mesh(quad, mat);
      mesh.position.z = zBase + 0.015;
      mesh.visible = false;
      mesh.frustumCulled = false;
      scene.add(mesh);
      this.ghosts.push({ mesh, mat, life: 0, maxLife: 0.14, baseSize: 0.14, color: new THREE.Color(0xffffff) });
    }
  }

  /** 렌더 해상도 변경 시 포인트 크기 기준 갱신 */
  setPixelsPerUnit(px: number): void {
    this.debris.mat.uniforms.uPxPerUnit.value = px;
    this.sparks.mat.uniforms.uPxPerUnit.value = px;
  }

  /** 프레임 시작 — 다중 격파를 1회 펀치로 합산하기 위한 래치 해제 */
  beginFrame(): void {
    this.punchArmed = false;
  }

  private emit(
    f: ParticleField, count: number, x: number, y: number,
    color: THREE.Color, dirX: number, dirY: number,
    speedScale: number, sizeMin: number, sizeMax: number, life: number,
  ): void {
    // 총량 상한: 링 버퍼 커서가 예산 범위 안에서만 돈다 (오래된 파편부터 덮어쓴다)
    const budget = Math.max(8, Math.min(f.capacity, Math.round(config.particleBudget * f.budgetShare)));
    for (let i = 0; i < count; i++) {
      const idx = f.cursor % budget;
      f.cursor = (f.cursor + 1) % budget;
      const ang = Math.random() * Math.PI * 2;
      const rx = Math.cos(ang), ry = Math.sin(ang);
      // 지향성: 방사 방향과 스와이프 방향의 블렌드
      const k = Math.max(0, Math.min(1, config.burstDirectionality));
      let vx = rx * (1 - k) + dirX * k;
      let vy = ry * (1 - k) + dirY * k;
      // 지향 성분에 옆으로 퍼짐을 약간 섞어 부채꼴로
      vx += rx * 0.35;
      vy += ry * 0.35;
      const len = Math.hypot(vx, vy) || 1;
      const sp = config.burstSpeed * speedScale * (0.45 + Math.random() * 0.9);
      f.vx[idx] = (vx / len) * sp;
      f.vy[idx] = (vy / len) * sp;
      f.pos.setXYZ(idx, x, y, 0);
      f.col.setXYZ(idx, color.r, color.g, color.b);
      f.size.setX(idx, sizeMin + Math.random() * (sizeMax - sizeMin));
      f.alpha.setX(idx, 1);
      f.life[idx] = life;
      f.maxLife[idx] = life;
    }
    f.pos.needsUpdate = true;
    f.col.needsUpdate = true;
    f.size.needsUpdate = true;
    f.alpha.needsUpdate = true;
  }

  /**
   * 격파 순간 연출 일괄 발동.
   * @param dirX,dirY 스와이프 진행 방향 (필드 단위, 정규화). 도약 자동 격파는 0,0 → 순수 방사
   */
  spawnKill(
    x: number, y: number, colorHex: number,
    dirX: number, dirY: number,
    texture: THREE.Texture | null, spriteSize: number,
  ): void {
    const color = new THREE.Color(colorHex);
    const life = Math.max(0.05, config.burstLifeSec);

    // 1. 파편 버스트 — 적 본체 색에서 채취, 20%만 명도 점프 (fx_palette §2.3)
    const total = Math.round(config.burstDebrisCount);
    if (total > 0) {
      const lit = Math.round(total * PAL.DEBRIS_HIGHLIGHT_RATIO);
      if (total - lit > 0) {
        this.emit(this.debris, total - lit, x, y, color, dirX, dirY, 1, 0.006, 0.016, life);
      }
      if (lit > 0) {
        this.emit(this.debris, lit, x, y, new THREE.Color(PAL.DEBRIS_HIGHLIGHT), dirX, dirY, 1.15, 0.006, 0.014, life);
      }
    }
    if (config.burstSparkCount > 0) {
      this.emit(this.sparks, Math.round(config.burstSparkCount), x, y, new THREE.Color(0xffffff), dirX, dirY, 1.6, 0.004, 0.009, life * 0.6);
    }

    // 2. 임팩트 플래시 + 스케일 팝 고스트
    if (config.impactFlashStrength > 0) {
      const fl = this.flashes.find(f => f.life <= 0) ?? this.flashes[0];
      fl.mesh.position.set(x, y, fl.mesh.position.z);
      fl.mesh.scale.setScalar(spriteSize * 3.2);
      // 임팩트 코어는 화이트 (fx_palette §2.3 — 1프레임 한정, §1 화이트 예약)
      (fl.mat.uniforms.uColor.value as THREE.Color).setHex(PAL.WHITE);
      fl.maxLife = 0.09;
      fl.life = fl.maxLife;
      fl.mesh.visible = true;
    }
    if (config.deathPopMs > 0 && texture) {
      const g = this.ghosts.find(gh => gh.life <= 0) ?? this.ghosts[0];
      g.mesh.position.set(x, y, g.mesh.position.z);
      g.mat.map = texture;
      g.mat.needsUpdate = true;
      g.color.copy(color);
      g.baseSize = spriteSize;
      g.maxLife = config.deathPopMs / 1000;
      g.life = g.maxLife;
      g.mesh.visible = true;
    }

    // 3. 카메라 펀치 — 프레임당 1회 (다중 격파 합산)
    if (config.cameraPunch > 0 && !this.punchArmed) {
      this.punchArmed = true;
      this.punchMax = Math.max(0.001, config.cameraPunchMs / 1000);
      this.punchLife = this.punchMax;
      this.punch = config.cameraPunch;
    }

    // 5. 밴드 히트 플래시
    if (config.bandFlashStrength > 0) {
      this.bandFlashMax = Math.max(0.001, config.bandFlashMs / 1000);
      this.bandFlashLife = this.bandFlashMax;
    }
  }

  private updateField(f: ParticleField, dt: number, drag: number, gravity: number): number {
    let alive = 0;
    for (let i = 0; i < f.capacity; i++) {
      if (f.life[i] <= 0) continue;
      f.life[i] -= dt;
      if (f.life[i] <= 0) {
        f.alpha.setX(i, 0);
        continue;
      }
      alive++;
      f.vx[i] *= drag;
      f.vy[i] = f.vy[i] * drag + gravity * dt;
      f.pos.setXYZ(i, f.pos.getX(i) + f.vx[i] * dt, f.pos.getY(i) + f.vy[i] * dt, 0);
      const t = f.life[i] / f.maxLife[i];
      f.alpha.setX(i, t * t);
    }
    f.pos.needsUpdate = true;
    f.alpha.needsUpdate = true;
    return alive;
  }

  update(dt: number): void {
    this.updateField(this.debris, dt, 0.94, -0.45);
    this.updateField(this.sparks, dt, 0.90, 0);

    for (const fl of this.flashes) {
      if (fl.life <= 0) continue;
      fl.life -= dt;
      if (fl.life <= 0) { fl.mesh.visible = false; fl.mat.uniforms.uAlpha.value = 0; continue; }
      const t = fl.life / fl.maxLife;
      fl.mat.uniforms.uAlpha.value = t * config.impactFlashStrength;
      fl.mesh.scale.setScalar(fl.mesh.scale.x * (1 + 2.2 * dt));
    }

    for (const g of this.ghosts) {
      if (g.life <= 0) continue;
      g.life -= dt;
      if (g.life <= 0) { g.mesh.visible = false; continue; }
      const p = 1 - g.life / g.maxLife; // 0 → 1
      // 스케일 팝: 1.0 → 1.25 → 0
      const scale = p < 0.45
        ? g.baseSize * (1 + 0.25 * (p / 0.45))
        : g.baseSize * 1.25 * (1 - (p - 0.45) / 0.55);
      g.mesh.scale.setScalar(Math.max(0, scale));
      // 화이트아웃 후 색으로 되돌아가며 소멸
      const white = Math.max(0, 1 - p * 2.4);
      g.mat.color.copy(g.color).lerp(new THREE.Color(0xffffff), white);
      g.mat.opacity = 1 - p;
    }

    if (this.punchLife > 0) {
      this.punchLife -= dt;
      if (this.punchLife <= 0) this.punch = 0;
    }
    if (this.bandFlashLife > 0) this.bandFlashLife -= dt;
  }

  /** 현재 카메라 줌 가산분 (렌더 전용 — 판정 좌표계에는 반영하지 않는다) */
  punchAmount(): number {
    if (this.punchLife <= 0) return 0;
    const t = this.punchLife / this.punchMax;
    return this.punch * t;
  }

  /** 밴드 히트 플래시 0..1 */
  bandFlash(): number {
    if (this.bandFlashLife <= 0) return 0;
    return (this.bandFlashLife / this.bandFlashMax) * config.bandFlashStrength;
  }

  activeParticles(): number {
    let n = 0;
    for (let i = 0; i < this.debris.capacity; i++) if (this.debris.life[i] > 0) n++;
    for (let i = 0; i < this.sparks.capacity; i++) if (this.sparks.life[i] > 0) n++;
    return n;
  }
}
