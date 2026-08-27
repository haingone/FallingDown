/**
 * HD-2D 레이어 렌더러 — 기획서 v2 4장.
 * 시뮬레이션 상태를 구독해 그리기만 한다 (로직 없음).
 *
 * 2패스 합성:
 *   패스 1 (원근 카메라, sceneWorld): ① 스카이 그라데이션+구체 ② 패럴랙스 구름 ③ 3D 오브젝트 레이어
 *   패스 2 (직교 카메라, sceneGame):  ④ 게임플레이 2D 평면 ⑤ 전경 속도선·파티클·베기 궤적
 *
 * 직교 카메라는 core/field.ts의 매핑과 정확히 일치한다 (프러스텀 = 필드 단위, zoom = field.zoom).
 * → 화면에 보이는 위치와 스와이프 판정 위치가 어긋나지 않는다.
 */
import * as THREE from 'three';
import type { Sim, Enemy, EnemyType } from '../core/sim';
import { config, speedT } from '../core/balance';
import { SlashTrails } from './slash';
import { SpriteTextures } from './sprites';
import { JuiceFx } from './juice';

const ENEMY_COLOR: Record<EnemyType, number> = {
  'a-1': 0x8e97a8,
  'a-2': 0x6fb3a4,
  'a-3': 0xbfa878,
  'a-4': 0x9a72c4,
  'a-5': 0xc4728f,
};
const HIGHLIGHT = 0x59ffa8; // 링 진입 하이라이트
const TELEGRAPH = 0xff4a2e; // 공격 예고 발광

const GIRL_HEIGHT = 0.22;   // 필드 단위 (1.0 = 화면 폭)
const ENEMY_SIZE = 0.14;
const RUIN_COUNT = 9;
const SPEEDLINE_COUNT = 70;

interface EnemyView {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  type: EnemyType | null;
  aspect: number;
}

interface Ruin {
  group: THREE.Group;
  speedFactor: number;
}

function cloudTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 256;
  const ctx = cv.getContext('2d')!;
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 22 + Math.random() * 52;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 판정 밴드(B안) — 위아래 경계가 밝게 서고 안쪽은 은은하게 빛나는 가로 띠 */
const BAND_FRAG = /* glsl */`
  precision mediump float;
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uHit;                      // 격파 순간 플래시 0..1 (r3 항목 5)
  varying vec2 vUv;
  void main() {
    float d = abs(vUv.y * 2.0 - 1.0);      // 0 = 중앙, 1 = 경계
    float edgeStart = 0.82 - 0.16 * uHit;  // 히트 시 경계선이 두꺼워진다
    float edge = smoothstep(edgeStart, 1.0, d);
    float fill = (1.0 - d) * (0.16 + 0.30 * uHit);
    float a = (edge * 0.95 + fill) * uAlpha;
    vec3 col = mix(uColor, vec3(1.0), 0.75 * uHit);
    gl_FragColor = vec4(col * (0.55 + 0.45 * edge) * (1.0 + 0.9 * uHit), a);
  }
`;

const SKY_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SKY_FRAG = /* glsl */`
  precision mediump float;
  uniform vec3 uTop;
  uniform vec3 uBottom;
  varying vec2 vUv;
  void main() {
    gl_FragColor = vec4(mix(uBottom, uTop, pow(vUv.y, 0.85)), 1.0);
  }
`;

export class Renderer2D {
  readonly renderer: THREE.WebGLRenderer;
  readonly sceneWorld = new THREE.Scene();
  readonly sceneGame = new THREE.Scene();
  readonly camWorld: THREE.PerspectiveCamera;
  readonly camGame: THREE.OrthographicCamera;

  private textures = new SpriteTextures();
  private slash: SlashTrails;

  // 레이어 ①
  private sky: THREE.Mesh;
  private sphere: THREE.Mesh;
  // 레이어 ②
  private cloudPlanes: { mesh: THREE.Mesh; factor: number; span: number }[] = [];
  // 레이어 ③
  private ruins: Ruin[] = [];
  // 레이어 ④
  private girl: THREE.Mesh;
  private girlMat: THREE.MeshBasicMaterial;
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private band: THREE.Mesh;
  private bandMat: THREE.ShaderMaterial;
  private enemyViews: EnemyView[] = [];
  private projViews: THREE.Mesh[] = [];
  // 레이어 ⑤
  private speedLines: THREE.LineSegments;
  private speedLinePos: Float32Array;
  private speedLineMat: THREE.LineBasicMaterial;
  private juice: JuiceFx;

  private cssWidth = 390;
  private drawCallCount = 0;
  private shakeT = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x0b1020);
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;

    this.camWorld = new THREE.PerspectiveCamera(50, 9 / 16, 0.5, 200);
    this.camWorld.position.set(0, 0, 0);
    this.camGame = new THREE.OrthographicCamera(-0.5, 0.5, 1, -1, -10, 10);

    // ── ① 스카이 그라데이션 + 구체 ──
    const skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      uniforms: {
        uTop: { value: new THREE.Color(0x1a2a52) },
        uBottom: { value: new THREE.Color(0x4d3a6b) },
      },
      depthWrite: false,
    });
    this.sky = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), skyMat);
    this.sky.position.z = -90;
    this.sky.frustumCulled = false;
    this.sceneWorld.add(this.sky);

    this.sphere = new THREE.Mesh(
      new THREE.SphereGeometry(7, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0x2f6f7a }),
    );
    this.sphere.position.set(-9, 16, -62);
    this.sceneWorld.add(this.sphere);

    // ── ② 패럴랙스 구름 (3 레이어 × 2장 순환) ──
    const cloudTex = cloudTexture();
    const cloudDepths = [
      { z: -44, factor: 0.45, tint: 0x5b4a80, opacity: 0.55, scale: 46 },
      { z: -30, factor: 0.7, tint: 0x6f5a94, opacity: 0.5, scale: 34 },
      { z: -18, factor: 1.0, tint: 0x8a6fae, opacity: 0.4, scale: 24 },
    ];
    for (const d of cloudDepths) {
      for (let i = 0; i < 2; i++) {
        const mat = new THREE.MeshBasicMaterial({
          map: cloudTex, transparent: true, opacity: d.opacity,
          color: d.tint, depthWrite: false,
        });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(d.scale * 1.6, d.scale), mat);
        mesh.position.set(0, i * d.scale, d.z);
        this.sceneWorld.add(mesh);
        this.cloudPlanes.push({ mesh, factor: d.factor, span: d.scale });
      }
    }

    // ── ③ 3D 오브젝트 레이어 (로우폴리 부유 유적) ──
    for (let i = 0; i < RUIN_COUNT; i++) {
      const group = this.makeRuin(i % 3);
      this.resetRuin(group, true);
      this.sceneWorld.add(group);
      this.ruins.push({ group, speedFactor: 1 });
    }

    // ── ④ 게임플레이 2D 평면 ──
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0x6fd0ff, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false,
    });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.978, 1.0, 72), this.ringMat);
    this.ring.position.z = -1;
    this.sceneGame.add(this.ring);

    // 판정 영역 B안: 화면 가로 발광 밴드 (지시문 P1 r2)
    this.bandMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT, // vUv만 전달하면 되므로 공용
      fragmentShader: BAND_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(0x6fd0ff) },
        uAlpha: { value: 0.9 },
        uHit: { value: 0 },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.band = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.bandMat);
    this.band.position.z = -1;
    this.band.visible = false;
    this.band.frustumCulled = false;
    this.sceneGame.add(this.band);

    // 스프라이트 메시는 단위 평면 — 크기는 프레임 종횡비에 맞춰 매 프레임 scale로 정한다
    // (Sprite-Gen 셀 비율이 실루엣과 다를 수 있으므로)
    const unitQuad = new THREE.PlaneGeometry(1, 1);
    this.girlMat = new THREE.MeshBasicMaterial({
      map: this.textures.girlFolded, transparent: true, color: 0xf2f4ff, depthWrite: false,
    });
    this.girl = new THREE.Mesh(unitQuad, this.girlMat);
    this.girl.position.z = 0;
    this.sceneGame.add(this.girl);

    for (let i = 0; i < 64; i++) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false });
      const mesh = new THREE.Mesh(unitQuad, mat);
      mesh.position.z = 0.1;
      mesh.visible = false;
      this.sceneGame.add(mesh);
      this.enemyViews.push({ mesh, mat, type: null, aspect: 96 / 112 });
    }

    const projGeo = new THREE.CircleGeometry(0.028, 10);
    const projMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(projGeo, projMat);
      m.position.z = 0.2;
      m.visible = false;
      this.sceneGame.add(m);
      this.projViews.push(m);
    }

    // ── ⑤ 전경: 속도선 · 파티클 · 베기 궤적 ──
    this.speedLinePos = new Float32Array(SPEEDLINE_COUNT * 6);
    for (let i = 0; i < SPEEDLINE_COUNT; i++) this.resetSpeedLine(i, true);
    const slGeo = new THREE.BufferGeometry();
    slGeo.setAttribute('position', new THREE.BufferAttribute(this.speedLinePos, 3));
    this.speedLineMat = new THREE.LineBasicMaterial({ color: 0xcfe4ff, transparent: true, opacity: 0 });
    this.speedLines = new THREE.LineSegments(slGeo, this.speedLineMat);
    this.speedLines.frustumCulled = false;
    this.sceneGame.add(this.speedLines);

    // 격파 피드백 (r3 손맛 주스) — 파편·플래시·스케일 팝·카메라 펀치·밴드 플래시
    this.juice = new JuiceFx(this.sceneGame, 0.24);

    this.slash = new SlashTrails(this.sceneGame, 0.3);
  }

  /** 로우폴리 유적 3종: 0=아치문, 1=계단, 2=잔해 */
  private makeRuin(kind: number): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: 0x3d3358 });
    const edge = new THREE.MeshBasicMaterial({ color: 0x6a5b8f, wireframe: true });
    if (kind === 0) {
      const arch = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.28, 5, 10, Math.PI), mat);
      g.add(arch);
      for (const s of [-1, 1]) {
        const col = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.2, 0.5), mat);
        col.position.set(s * 1.6, -1.1, 0);
        g.add(col);
      }
      const base = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.34, 1.2), edge);
      base.position.y = -2.3;
      g.add(base);
    } else if (kind === 1) {
      for (let i = 0; i < 4; i++) {
        const step = new THREE.Mesh(new THREE.BoxGeometry(2.6 - i * 0.4, 0.42, 1.5), i % 2 ? edge : mat);
        step.position.set(i * 0.5, i * 0.62, 0);
        g.add(step);
      }
    } else {
      const chunk = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 0), mat);
      g.add(chunk);
      const shard = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 0), edge);
      shard.position.set(1.5, -0.9, 0.4);
      g.add(shard);
    }
    return g;
  }

  private resetRuin(g: THREE.Group, randomY: boolean): void {
    const z = -26 + Math.random() * 16;
    const spreadX = 6 + Math.abs(z) * 0.42;
    g.position.set(
      (Math.random() * 2 - 1) * spreadX,
      randomY ? -22 + Math.random() * 46 : -24 - Math.random() * 6,
      z,
    );
    g.rotation.set(Math.random() * 0.5 - 0.25, Math.random() * Math.PI * 2, Math.random() * 0.4 - 0.2);
    const s = 0.7 + Math.random() * 0.9;
    g.scale.setScalar(s);
  }

  private resetSpeedLine(i: number, randomY: boolean): void {
    const x = (Math.random() * 2 - 1) * 0.56;
    const y = randomY ? (Math.random() * 2 - 1) * 1.3 : -1.25 - Math.random() * 0.25;
    const len = 0.07 + Math.random() * 0.16;
    this.speedLinePos[i * 6 + 0] = x;
    this.speedLinePos[i * 6 + 1] = y;
    this.speedLinePos[i * 6 + 2] = 0.25;
    this.speedLinePos[i * 6 + 3] = x;
    this.speedLinePos[i * 6 + 4] = y - len;
    this.speedLinePos[i * 6 + 5] = 0.25;
  }

  /**
   * 해상도 설정. 픽셀 스케일링 정책 검증 (기획서 v2 17장 7):
   *  - 'native': DPR 그대로 (최대 2)
   *  - 'pixel' : 1/N 저해상도 렌더타깃 → CSS로 N배 확대 (image-rendering: pixelated)
   */
  setSize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = cssWidth;
    this.juice.setPixelsPerUnit(cssWidth);
    const canvas = this.renderer.domElement;

    if (config.pixelScaleMode === 'pixel') {
      const s = Math.max(2, Math.round(config.pixelScaleFactor));
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(Math.round(cssWidth / s), Math.round(cssHeight / s), false);
      canvas.style.imageRendering = 'pixelated';
    } else {
      this.renderer.setPixelRatio(Math.min(dpr, 2));
      this.renderer.setSize(cssWidth, cssHeight, false);
      canvas.style.imageRendering = 'auto';
    }
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const aspect = cssHeight / cssWidth;
    this.camWorld.aspect = cssWidth / cssHeight;
    this.camWorld.updateProjectionMatrix();

    this.camGame.left = -0.5;
    this.camGame.right = 0.5;
    this.camGame.top = aspect / 2;
    this.camGame.bottom = -aspect / 2;
    this.camGame.updateProjectionMatrix();

    // 스카이 평면을 원근 프러스텀에 맞춰 리사이즈
    const d = 90;
    const h = 2 * d * Math.tan((this.camWorld.fov * Math.PI) / 360) * 1.15;
    this.sky.scale.set(h * this.camWorld.aspect, h, 1);
  }

  /**
   * 격파 순간 연출 (r3 항목 1·2·3·5 일괄).
   * @param dirX,dirY 스와이프 진행 방향 (필드 단위 정규화). 도약 자동 격파는 0,0 → 순수 방사
   */
  spawnKill(x: number, y: number, type: EnemyType, dirX: number, dirY: number): void {
    // 격파 고스트는 정지 이미지 — 실루엣/시트 어느 쪽이든 현재 프레임 텍스처를 그대로 승계
    this.juice.spawnKill(x, y, ENEMY_COLOR[type], dirX, dirY, this.textures.enemy(type).texture, ENEMY_SIZE);
  }

  /** 프레임 시작 — 다중 격파 카메라 펀치 합산용 래치 해제 */
  beginFrame(): void {
    this.juice.beginFrame();
  }

  spawnSlash(startX: number, startY: number, endX: number, endY: number, stance: 'umbrella' | 'sword'): void {
    this.slash.spawn(startX, startY, endX, endY, stance);
  }

  drawCalls(): number { return this.drawCallCount; }
  /**
   * AD 산출 스프라이트 시트 반입 (P1.5 §B-1).
   * 반입 실패·미반입이면 실루엣 플레이스홀더가 그대로 유지된다.
   */
  async loadSprites(): Promise<boolean> {
    return this.textures.loadAtlas();
  }
  /** 스프라이트 반입 상태 (패널 표시·검증용) */
  spriteInfo(): ReturnType<SpriteTextures['atlasInfo']> { return this.textures.atlasInfo(); }
  /** 스프라이트 공급자 (자가 검증용 접근) */
  get spriteTextures(): SpriteTextures { return this.textures; }

  /** 현재 살아있는 베기 궤적 수 */
  slashActiveCount(): number { return this.slash.activeCount(); }
  /** 현재 살아있는 격파 파편 수 (총량 상한 확인용) */
  activeParticles(): number { return this.juice.activeParticles(); }
  /** 현재 카메라 펀치 가산분 (연출 전용) */
  punchAmount(): number { return this.juice.punchAmount(); }
  /** 현재 밴드 히트 플래시 0..1 */
  bandFlashAmount(): number { return this.juice.bandFlash(); }
  /** 오버드로우 추정: 화면을 덮는 반투명 레이어 수 */
  overdrawEstimate(): number {
    const clouds = this.cloudPlanes.filter(c => c.mesh.visible).length;
    return 1 + clouds + this.slash.activeCount();
  }

  render(sim: Sim, alpha: number, dtSec: number): void {
    const lerp = (a: number, b: number) => a + (b - a) * alpha;
    const gx = lerp(sim.girlPrevX, sim.girlX);
    const gy = lerp(sim.girlPrevY, sim.girlY);
    const t = speedT(sim.speed);
    const scroll = config.scrollSpeedCoef * sim.speed * (sim.diveActive ? 2.2 : 1);

    // ── 카메라: 줌은 field와 동일 + 격파 펀치(연출 전용), 셰이크도 연출 전용 ──
    this.juice.update(dtSec);
    this.camGame.zoom = sim.field.zoom * (1 + this.juice.punchAmount());
    this.camGame.updateProjectionMatrix();
    this.shakeT += dtSec * 34;
    const shakeAmp = (config.shakeStrength / this.cssWidth) * (sim.diveActive ? 1.4 : t);
    const shx = Math.sin(this.shakeT * 1.7) * shakeAmp;
    const shy = Math.cos(this.shakeT * 2.3) * shakeAmp;
    this.camGame.position.set(shx, shy, 5);
    this.camWorld.position.set(shx * 6, shy * 6, 0);

    // ── ① 스카이·구체 ──
    this.sphere.position.y += scroll * 0.35 * dtSec;
    if (this.sphere.position.y > 40) this.sphere.position.y = -40;

    // ── ② 패럴랙스 구름 ──
    for (const c of this.cloudPlanes) {
      c.mesh.position.y += scroll * c.factor * 2.6 * dtSec;
      if (c.mesh.position.y > c.span) c.mesh.position.y -= c.span * 2;
    }

    // ── ③ 3D 오브젝트 레이어 ──
    const activeRuins = Math.round(Math.max(0, Math.min(1, config.objectDensity)) * RUIN_COUNT);
    for (let i = 0; i < this.ruins.length; i++) {
      const r = this.ruins[i];
      const on = i < activeRuins;
      r.group.visible = on;
      if (!on) continue;
      // 가까운(z가 큰) 오브젝트일수록 빠르게 = 깊이감
      const depthFactor = 1 + (r.group.position.z + 26) / 16;
      r.group.position.y += scroll * 2.2 * depthFactor * dtSec;
      r.group.rotation.y += 0.12 * dtSec;
      if (r.group.position.y > 26) this.resetRuin(r.group, false);
    }

    // ── ④ 게임플레이 ──
    // 판정 영역 A(원형 링) / B(화면 밴드) 전환 — 지시문 P1 r2
    const bandMode = config.judgeArea === 'band';
    this.ring.visible = !bandMode;
    this.band.visible = bandMode;
    if (bandMode) {
      // 밴드는 화면 가로 전체 (레터박스 여유 포함)
      this.band.position.set(0, gy, -1);
      this.band.scale.set(1.25, config.bandHeightFrac, 1);
      (this.bandMat.uniforms.uColor.value as THREE.Color).setHex(sim.diveActive ? 0xffd45e : 0x6fd0ff);
      this.bandMat.uniforms.uAlpha.value = sim.diveActive ? 1.0 : 0.9;
      this.bandMat.uniforms.uHit.value = this.juice.bandFlash(); // r3 항목 5
    } else {
      this.ring.position.set(gx, gy, -1);
      this.ring.scale.setScalar(config.ringRadiusFrac);
      this.ringMat.color.setHex(sim.diveActive ? 0xffd45e : 0x6fd0ff);
      this.ringMat.opacity = sim.diveActive ? 0.85 : 0.6;
    }

    this.girl.position.set(gx, gy, 0);
    const girlFrame = this.textures.girl(sim.umbrellaOpen, sim.time);
    if (this.girlMat.map !== girlFrame.texture) {
      this.girlMat.map = girlFrame.texture;
      this.girlMat.needsUpdate = true;
    }
    this.girl.scale.set(GIRL_HEIGHT * girlFrame.aspect, GIRL_HEIGHT, 1);
    // 피격 무적 점멸 / 도약 시 돌진 자세(진행 방향으로 기울임)
    const blinking = sim.invulnTimer > 0 && Math.floor(sim.invulnTimer * 20) % 2 === 0;
    this.girlMat.color.setHex(sim.diveActive ? 0xffe08a : blinking ? 0xff8080 : 0xf2f4ff);
    this.girl.rotation.z = sim.diveActive
      ? Math.atan2(sim.girlY - sim.girlPrevY, sim.girlX - sim.girlPrevX) - Math.PI / 2
      : 0;

    const active: Enemy[] = [];
    for (const e of sim.enemies) if (e.active) active.push(e);
    for (let i = 0; i < this.enemyViews.length; i++) {
      const v = this.enemyViews[i];
      const e = active[i];
      if (!e) { v.mesh.visible = false; continue; }
      v.mesh.visible = true;
      v.mesh.position.set(lerp(e.prevX, e.x), lerp(e.prevY, e.y), 0.1);
      // 스프라이트 시트가 반입되면 프레임 애니메이션이 붙는다 (개체별 위상차)
      const frame = this.textures.enemy(e.type, sim.time + e.zigzagSeed);
      if (v.mat.map !== frame.texture) {
        v.mat.map = frame.texture;
        v.mat.needsUpdate = true;
      }
      v.type = e.type;
      v.aspect = frame.aspect;
      const inRing = e.phase === 'ring' || (e.phase === 'orbit' && (e.type !== 'a-5' || e.exposeTimer > 0));
      let color = ENEMY_COLOR[e.type];
      if (e.telegraphing) color = TELEGRAPH;
      else if (inRing) color = HIGHLIGHT;
      else if (e.type === 'a-4' && e.armorBroken) color = 0xd7b0ff;
      v.mat.color.setHex(color);
      v.mat.opacity = 0.35 + 0.65 * e.spawnAnimT;
      // 진행 방향으로 회전 (통과형)
      if (e.lifecycle === 'pass') v.mesh.rotation.z = Math.atan2(e.dirY, e.dirX) - Math.PI / 2;
      else v.mesh.rotation.z = 0;
      const s = e.telegraphing ? 1.18 : 1;
      v.mesh.scale.set(ENEMY_SIZE * v.aspect * s, ENEMY_SIZE * s, 1);
    }

    const activeProj = sim.projectiles.filter(p => p.active);
    for (let i = 0; i < this.projViews.length; i++) {
      const m = this.projViews[i];
      const p = activeProj[i];
      if (!p) { m.visible = false; continue; }
      m.visible = true;
      m.position.set(lerp(p.prevX, p.x), lerp(p.prevY, p.y), 0.2);
    }

    // ── ⑤ 전경 ──
    this.speedLineMat.opacity = sim.diveActive ? 0.8 : t * 0.6;
    const slv = (0.5 + 1.9 * t) * (sim.diveActive ? 2.4 : 1) * config.scrollSpeedCoef;
    for (let i = 0; i < SPEEDLINE_COUNT; i++) {
      this.speedLinePos[i * 6 + 1] += slv * dtSec;
      this.speedLinePos[i * 6 + 4] += slv * dtSec;
      if (this.speedLinePos[i * 6 + 4] > 1.3) this.resetSpeedLine(i, false);
    }
    (this.speedLines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    this.slash.update(dtSec);

    // ── 합성 ──
    this.renderer.info.reset();
    this.renderer.clear();
    this.renderer.render(this.sceneWorld, this.camWorld);
    this.renderer.render(this.sceneGame, this.camGame);
    this.drawCallCount = this.renderer.info.render.calls;
  }
}
