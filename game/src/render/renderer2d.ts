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
import * as PAL from './palette';

/**
 * 실루엣 폴백용 적 색 (fx_palette §3 확정 팔레트 범위 안에서 선택).
 * 반입 스프라이트는 자체 색을 가지므로 흰색(=무틴트)으로 그린다.
 */
const ENEMY_COLOR: Record<EnemyType, number> = {
  'a-1': PAL.DEBRIS_COLORS[1],
  'a-2': PAL.DEBRIS_COLORS[2],
  'a-3': PAL.DEBRIS_COLORS[0],
  'a-4': PAL.VIOLET,
  'a-5': PAL.CYAN_DEEP,
};

const GIRL_HEIGHT = 0.22;   // 필드 단위 (1.0 = 화면 폭)
const ENEMY_SIZE = 0.14;
const RUIN_COUNT = 9;
const SPEEDLINE_COUNT = 70;

interface EnemyView {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  type: EnemyType | null;
  aspect: number;
  /** 그림이 향하는 방향 (진행 방향 회전 보정용) */
  facing: number;
}

interface Ruin {
  group: THREE.Group;
  speedFactor: number;
}

/**
 * 구름 텍스처 (background_p15 §2): **가로로 긴 둥근 사각 덩어리** — 사실적 구름 실루엣 금지.
 * 상하 경계에 1px 체커 디더를 넣어 픽셀 톤을 맞춘다.
 * @param bandPx 띠의 세로 두께 (텍스처 픽셀)
 */
function cloudTexture(bandPx: number): THREE.CanvasTexture {
  const W = 256, H = 256;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#ffffff';

  const count = Math.max(3, Math.round(H / (bandPx * 3)));
  for (let i = 0; i < count; i++) {
    const h = bandPx * (0.7 + Math.random() * 0.6);
    const w = W * (0.25 + Math.random() * 0.45);
    const x = Math.random() * (W - w);
    const y = (i + Math.random() * 0.6) * (H / count);
    const r = Math.min(h / 2, 6);
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
    // 상하 경계 1px 디더
    for (let px = 0; px < w; px += 2) {
      ctx.fillRect(x + px, y - 1, 1, 1);
      ctx.fillRect(x + px + 1, y + h, 1, 1);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/**
 * 판정 밴드 — 위아래 경계의 **실제 픽셀 두께 라인** (fx_palette §2.4).
 * 스펙의 "1px / 격파 시 2px"는 면적이 아니라 선 두께이므로, 화면 픽셀 기준으로 두께를 잡는다
 * (fwidth 로 UV→픽셀 환산). 소프트 그라데이션으로 그리면 화소당 대비가 사라져 선이 보이지 않는다.
 */
const BAND_FRAG = /* glsl */`
  precision mediump float;
  uniform vec3 uColor;
  uniform float uAlpha;
  uniform float uHit;        // 격파 순간 플래시 0..1 (r3 항목 5)
  uniform float uGlowPx;     // 적 진입 시 외곽 발광 두께 (px, 0 = 없음)
  varying vec2 vUv;
  void main() {
    float d = abs(vUv.y * 2.0 - 1.0);     // 0 = 중앙, 1 = 경계
    float px = max(fwidth(d), 1e-6);      // UV 1픽셀에 해당하는 d 변화량
    float linePx = 1.0 + uHit;            // 평상 1px → 격파 2px
    float line = 1.0 - smoothstep(0.0, px * linePx, 1.0 - d);
    float glow = uGlowPx > 0.0
      ? (1.0 - smoothstep(0.0, px * uGlowPx, 1.0 - d)) * 0.45
      : 0.0;
    float a = min(1.0, line * uAlpha + glow * uAlpha);
    vec3 col = mix(uColor, vec3(1.0), 0.5 * uHit);
    gl_FragColor = vec4(col * (1.0 + 0.8 * uHit), a);
  }
`;

const SKY_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
/**
 * 스카이 5단 밴딩 (background_p15 §1) — 부드러운 보간이 아니라 단을 눈에 보이게 끊고,
 * 경계마다 1px 체커 디더를 넣어 픽셀 톤을 유지한다. 낙하에 따라 전체가 위로 스크롤된다.
 */
const SKY_FRAG = /* glsl */`
  precision mediump float;
  uniform vec3 uBand[5];
  uniform float uStop[4];
  uniform float uScroll;
  varying vec2 vUv;
  void main() {
    // vUv.y: 0=아래, 1=위 → 화면 세로 위치(0=상단)로 변환 후 스크롤 적용
    float p = fract(1.0 - vUv.y + uScroll);
    vec3 col = uBand[4];
    if (p < uStop[0])      col = uBand[0];
    else if (p < uStop[1]) col = uBand[1];
    else if (p < uStop[2]) col = uBand[2];
    else if (p < uStop[3]) col = uBand[3];

    // 경계 1px 디더 — 위아래 색 1:1 체커
    float checker = mod(floor(gl_FragCoord.x) + floor(gl_FragCoord.y), 2.0);
    for (int i = 0; i < 4; i++) {
      float d = abs(p - uStop[i]);
      if (d < 0.004) {
        vec3 lo = (i == 0) ? uBand[0] : (i == 1) ? uBand[1] : (i == 2) ? uBand[2] : uBand[3];
        vec3 hi = (i == 0) ? uBand[1] : (i == 1) ? uBand[2] : (i == 2) ? uBand[3] : uBand[4];
        col = (checker > 0.5) ? lo : hi;
      }
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** 캐릭터 뒤 소프트 비네트 (background_p15 §1.1 — 가독성 필수 요소) */
const VIGNETTE_FRAG = /* glsl */`
  precision mediump float;
  uniform vec3 uColor;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    float d = length(vUv * 2.0 - 1.0);
    gl_FragColor = vec4(uColor, (1.0 - smoothstep(0.0, 1.0, d)) * uAlpha);
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
  private skyMat: THREE.ShaderMaterial;
  private sphere: THREE.Mesh;
  private vignette: THREE.Mesh;
  private vignetteMat: THREE.ShaderMaterial;
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
  private enemyGlows: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }[] = [];
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
        uBand: { value: PAL.SKY_BANDS.map((c) => new THREE.Color(c)) },
        uStop: { value: [...PAL.SKY_STOPS] },
        uScroll: { value: 0 },
      },
      depthWrite: false,
    });
    this.skyMat = skyMat;
    this.sky = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), skyMat);
    this.sky.position.z = -90;
    this.sky.frustumCulled = false;
    this.sceneWorld.add(this.sky);

    this.sphere = new THREE.Mesh(
      new THREE.SphereGeometry(7, 20, 14),
      new THREE.MeshBasicMaterial({ color: PAL.CYAN_DEEP }),
    );
    this.sphere.position.set(-9, 16, -62);
    this.sceneWorld.add(this.sphere);

    // ── ② 패럴랙스 구름 (3 레이어 × 2장 순환) ──
    // background_p15 §2: 2장이면 충분 — 원경/근경, 색·알파·패럴랙스 배속 스펙 그대로
    const cloudTexFar = cloudTexture(11);  // 원경: 세로 8~14px 띠
    const cloudTexNear = cloudTexture(20); // 근경: 세로 16~24px 띠
    const cloudDepths = [
      { z: -40, factor: PAL.CLOUD_LAYERS[0].parallax, tint: PAL.CLOUD_LAYERS[0].color, opacity: PAL.CLOUD_LAYERS[0].opacity, scale: 42 },
      { z: -22, factor: PAL.CLOUD_LAYERS[1].parallax, tint: PAL.CLOUD_LAYERS[1].color, opacity: PAL.CLOUD_LAYERS[1].opacity, scale: 28 },
    ];
    for (const d of cloudDepths) {
      const cloudTex = d.z < -30 ? cloudTexFar : cloudTexNear;
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

    // 캐릭터 뒤 소프트 비네트 — 배경 명도 분리 (background_p15 §1.1, 상시 ON)
    this.vignetteMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: VIGNETTE_FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(PAL.VIGNETTE.color) },
        uAlpha: { value: PAL.VIGNETTE.alpha },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.vignette = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.vignetteMat);
    this.vignette.position.z = -3;
    this.vignette.frustumCulled = false;
    this.sceneGame.add(this.vignette);

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
        uColor: { value: new THREE.Color(PAL.BAND_IDLE.color) },
        uAlpha: { value: PAL.BAND_IDLE.alpha },
        uHit: { value: 0 },
        uGlowPx: { value: 0 },
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
      this.enemyViews.push({ mesh, mat, type: null, aspect: 96 / 112, facing: Math.PI / 2 });

      // 점등 시 뒤에 깔리는 확대 실루엣 = 외곽 1px 발광 (fx_palette §2.5)
      const glowMat = new THREE.MeshBasicMaterial({
        transparent: true, depthTest: false, depthWrite: false,
        blending: THREE.AdditiveBlending, opacity: 0,
      });
      const glow = new THREE.Mesh(unitQuad, glowMat);
      glow.position.z = 0.05;
      glow.visible = false;
      this.sceneGame.add(glow);
      this.enemyGlows.push({ mesh: glow, mat: glowMat });
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
    this.speedLineMat = new THREE.LineBasicMaterial({ color: PAL.SPEEDLINE_SLOW, transparent: true, opacity: 0 });
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
    // 3D 오브젝트는 P1.5 범위 외 — 색만 예약 팔레트로 맞춘다 (background_p15 §3)
    const mat = new THREE.MeshBasicMaterial({ color: PAL.RUIN_BODY });
    const edge = new THREE.MeshBasicMaterial({ color: PAL.RUIN_EDGE, wireframe: true });
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
    // 화면 중앙 40%는 항상 클린 — 전투 공간을 가리지 않는다 (fx_palette §2.6)
    const clear = PAL.SPEEDLINE_CENTER_CLEAR;
    const side = Math.random() < 0.5 ? -1 : 1;
    const x = side * (clear + Math.random() * (0.56 - clear));
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

    // ── ① 스카이·구체 ── 그라데이션 전체를 위로 스크롤 = 낙하 표현 (background_p15 §1)
    this.skyMat.uniforms.uScroll.value += scroll * 0.012 * dtSec;
    this.sphere.position.y += scroll * 0.35 * dtSec;
    if (this.sphere.position.y > 40) this.sphere.position.y = -40;

    // 캐릭터 뒤 비네트 — 소녀를 따라다닌다 (가독성 필수, 끄지 않는다)
    this.vignette.position.set(gx, gy, -3);
    this.vignette.scale.setScalar(PAL.VIGNETTE.radiusFrac * 4);

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
      // 밴드 3상태 (fx_palette §2.4): 평상 → 적 진입 → 격파. 색상을 바꾸지 않고 명도·알파만 올린다
      const hit = this.juice.bandFlash(); // r3 항목 5
      const enemyIn = sim.hittableCount() > 0;
      const state = hit > 0 ? PAL.BAND_KILL : enemyIn ? PAL.BAND_ENEMY_IN : PAL.BAND_IDLE;
      (this.bandMat.uniforms.uColor.value as THREE.Color).setHex(sim.diveActive ? PAL.COLD_CYAN : state.color);
      this.bandMat.uniforms.uAlpha.value = sim.diveActive ? 1.0 : state.alpha;
      this.bandMat.uniforms.uHit.value = hit;
      // 적 진입 시에만 외곽 1px 발광 (fx_palette §2.4)
      this.bandMat.uniforms.uGlowPx.value = enemyIn || hit > 0 ? 3 : 0;
    } else {
      this.ring.position.set(gx, gy, -1);
      this.ring.scale.setScalar(config.ringRadiusFrac);
      this.ringMat.color.setHex(sim.diveActive ? PAL.COLD_CYAN : PAL.CYAN_DEEP);
      this.ringMat.opacity = sim.diveActive ? 0.85 : 0.6;
    }

    this.girl.position.set(gx, gy, 0);
    const girlFrame = this.textures.girl(sim.umbrellaOpen, sim.time);
    if (this.girlMat.map !== girlFrame.texture) {
      this.girlMat.map = girlFrame.texture;
      this.girlMat.needsUpdate = true;
    }
    this.girl.scale.set(GIRL_HEIGHT * girlFrame.aspect, GIRL_HEIGHT, 1);
    // 피격 플래시는 **핫 마젠타** — 마젠타 예약의 유일한 예외 (fx_palette §2.7, 소녀 위에서만)
    const blinking = sim.invulnTimer > 0 && Math.floor(sim.invulnTimer * 20) % 2 === 0;
    const girlTint = girlFrame.fromAtlas ? 0xffffff : 0xf2f4ff; // 반입 스프라이트는 무틴트
    this.girlMat.color.setHex(blinking ? PAL.HOT_MAGENTA : girlTint);
    if (sim.diveActive && !blinking) this.girlMat.color.multiplyScalar(PAL.LIT_BRIGHTNESS);
    this.girl.rotation.z = sim.diveActive
      ? Math.atan2(sim.girlY - sim.girlPrevY, sim.girlX - sim.girlPrevX) - Math.PI / 2
      : 0;

    const active: Enemy[] = [];
    for (const e of sim.enemies) if (e.active) active.push(e);
    for (let i = 0; i < this.enemyViews.length; i++) {
      const v = this.enemyViews[i];
      const e = active[i];
      if (!e) {
        v.mesh.visible = false;
        this.enemyGlows[i].mesh.visible = false;
        continue;
      }
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
      v.facing = frame.facing;
      // 점등 = **명도 점프 + 외곽 발광** (fx_palette §2.5 — 새 색상을 얻지 않는다)
      const inRing = e.phase === 'ring' || (e.phase === 'orbit' && (e.type !== 'a-5' || e.exposeTimer > 0));
      // 반입 스프라이트는 자체 색을 가지므로 무틴트(흰색), 실루엣은 타입 색으로 칠한다
      const base = frame.fromAtlas ? 0xffffff : ENEMY_COLOR[e.type];
      const gain = e.telegraphing ? PAL.TELEGRAPH_BRIGHTNESS : inRing ? PAL.LIT_BRIGHTNESS : 1;
      v.mat.color.setHex(base).multiplyScalar(gain);
      v.mat.opacity = 0.35 + 0.65 * e.spawnAnimT;

      const glow = this.enemyGlows[i];
      if (gain > 1) {
        glow.mesh.visible = true;
        glow.mesh.position.copy(v.mesh.position);
        glow.mesh.position.z = 0.05;
        // 공격 예고는 적 액센트(바이올렛), 판정 진입은 대상 색을 밝힌 것
        glow.mat.color.setHex(e.telegraphing ? PAL.VIOLET : base).multiplyScalar(1.9);
        glow.mat.opacity = PAL.GLOW_ALPHA * e.spawnAnimT;
        if (glow.mat.map !== v.mat.map) {
          glow.mat.map = v.mat.map;
          glow.mat.needsUpdate = true;
        }
      } else {
        glow.mesh.visible = false;
      }
      // 진행 방향으로 회전 (통과형). 그림이 향하는 방향(facing)만큼 보정한다
      if (e.lifecycle === 'pass') v.mesh.rotation.z = Math.atan2(e.dirY, e.dirX) - v.facing;
      else v.mesh.rotation.z = 0;
      const s = e.telegraphing ? 1.18 : 1;
      v.mesh.scale.set(ENEMY_SIZE * v.aspect * s, ENEMY_SIZE * s, 1);
      if (this.enemyGlows[i].mesh.visible) {
        this.enemyGlows[i].mesh.rotation.z = v.mesh.rotation.z;
        this.enemyGlows[i].mesh.scale.copy(v.mesh.scale).multiplyScalar(PAL.GLOW_SCALE);
      }
    }

    const activeProj = sim.projectiles.filter(p => p.active);
    for (let i = 0; i < this.projViews.length; i++) {
      const m = this.projViews[i];
      const p = activeProj[i];
      if (!p) { m.visible = false; continue; }
      m.visible = true;
      m.position.set(lerp(p.prevX, p.x), lerp(p.prevY, p.y), 0.2);
    }

    // ── ⑤ 전경 ── 속도는 채도가 아니라 **명도**로 표현 (fx_palette §2.6)
    this.speedLineMat.color.setHex(PAL.SPEEDLINE_SLOW).lerp(new THREE.Color(PAL.SPEEDLINE_FAST), t);
    this.speedLineMat.opacity = sim.diveActive ? 0.55 : 0.25 + 0.30 * t;
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
