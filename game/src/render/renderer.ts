/**
 * HD-2D 레이어 렌더러 (P1) — 시뮬레이션 상태를 구독해 그리기만 한다 (로직 없음).
 *
 * 레이어 구성 (기획서 v2 4장):
 *  ① 원경  — 스카이 그라데이션 + 지구/달 구체            (layers/sky.ts, 직교)
 *  ② 중경  — 패럴랙스 구름 3장                            (layers/sky.ts, 직교)
 *  ③ 3D    — 로우폴리 유적 3종 (원근 카메라, 연출 전용)   (layers/objects3d.ts)
 *  ④ 게임플레이 — 소녀·적·투사체·판정 링 (2D 평면, 판정과 동일 좌표계)
 *  ⑤ 전경  — 속도선·파편 파티클 + 베기 궤적               (screen px 공간, slashfx.ts)
 *
 * 카메라는 고정. 속도 표현은 스크롤 속도 + 미세 줌아웃(1.0→1.06) + 셰이크로 한다.
 * **셰이크는 배경(③)·전경(⑤)에만 적용한다** — 게임플레이 레이어를 흔들면 화면 좌표 판정과
 * 렌더가 어긋나므로(판정 투영은 셰이크를 모른다) 판정-렌더 일치를 우선했다. (리포트 편차 기록)
 *
 * 픽셀 스케일링 정책 검증(기획서 v2 17장 7): 'pixel' 모드에서 저해상도 렌더타깃에 그린 뒤
 * NearestFilter로 정수 배 업스케일한다. 'native'는 기기 해상도 그대로.
 */
import * as THREE from 'three';
import type { Sim, EnemyType, Stance } from '../core/sim';
import { enemyRadius } from '../core/sim';
import { config } from '../core/balance';
import { SkyLayer, PALETTE_TEAL_DAY } from './layers/sky';
import { Objects3DLayer } from './layers/objects3d';
import { GirlSprite } from './layers/girl';
import { SlashFx } from './slashfx';

THREE.ColorManagement.enabled = false; // 그레이박스: 지정한 색을 그대로 출력 (팔레트 예측 가능성)

const ENEMY_COLOR: Record<EnemyType, number> = {
  'a-1': 0x2b3446,
  'a-2': 0x35564f,
  'a-3': 0x4a4436,
  'a-4': 0x51386b,
  'a-5': 0x6b3550,
};
const HIGHLIGHT = 0x33ff88; // 링 진입 하이라이트 (M1 이월 — 명도 대비 큼)
const TELEGRAPH = 0xff4422; // 공격 예고 발광

interface EnemyView {
  root: THREE.Group;
  body: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  rim: THREE.Mesh;
  rimMat: THREE.MeshBasicMaterial;
  label: THREE.Sprite;
  enemyId: number;
}

interface Burst {
  points: THREE.Points;
  mat: THREE.PointsMaterial;
  vel: Float32Array;
  life: number;
}

const BURST_COUNT = 12;
const SPEED_LINE_COUNT = 72;

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly sky = new SkyLayer(PALETTE_TEAL_DAY);
  readonly objects3d = new Objects3DLayer(PALETTE_TEAL_DAY.bottom);
  readonly slashFx = new SlashFx();

  /** ④ 게임플레이 (2D 평면, 월드 wu 좌표 — Plane2D와 동일 매핑) */
  readonly playScene = new THREE.Scene();
  readonly playCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  /** ⑤ 전경 (화면 px 좌표, slashFx 카메라 공유) */
  readonly fgScene = new THREE.Scene();

  private girl: GirlSprite;
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private ringPulse = 0;
  private enemyViews: EnemyView[] = [];
  private projViews: THREE.Mesh[] = [];
  private bursts: Burst[] = [];
  private speedLines: THREE.LineSegments;
  private speedLinePos: Float32Array;
  private speedLineMat: THREE.LineBasicMaterial;
  private labelMaterials = new Map<string, THREE.SpriteMaterial>();

  private widthCss = 390;
  private heightCss = 844;
  private dpr = 1;
  private rt: THREE.WebGLRenderTarget | null = null;
  private rtScale = 0;
  private blitScene = new THREE.Scene();
  private blitCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private blitMat: THREE.MeshBasicMaterial;
  private shakeX = 0;
  private shakeY = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(PALETTE_TEAL_DAY.bottom);
    this.renderer.autoClear = false;
    // 한 프레임에 여러 패스를 그리므로 draw call 통계를 패스마다 리셋하지 않는다 (프레임 합계 측정)
    this.renderer.info.autoReset = false;

    // ── ④ 게임플레이 레이어 ──
    this.girl = new GirlSprite(1.15);
    this.playScene.add(this.girl.root);

    // 판정 링: 상시 표시 (기획서 15장). 2D 원 = 얇은 애뉼러스
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.55 });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.975, 1.0, 64), this.ringMat);
    this.playScene.add(this.ring);

    // 적 뷰 풀 (64) — 원형 실루엣 + 림 + 코드명 라벨
    const circle = new THREE.CircleGeometry(1, 14);
    for (let i = 0; i < 64; i++) {
      const root = new THREE.Group();
      const rimMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 });
      const rim = new THREE.Mesh(circle, rimMat);
      rim.position.z = -0.02;
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const body = new THREE.Mesh(circle, mat);
      const label = new THREE.Sprite(this.labelMaterial('a-1'));
      label.position.set(0, 0.52, 0.1);
      label.scale.set(0.62, 0.24, 1);
      root.add(rim, body, label);
      root.visible = false;
      this.playScene.add(root);
      this.enemyViews.push({ root, body, mat, rim, rimMat, label, enemyId: -1 });
    }

    // 투사체 풀 (16)
    const projGeo = new THREE.CircleGeometry(0.18, 10);
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(projGeo, new THREE.MeshBasicMaterial({ color: 0xffb43c }));
      m.visible = false;
      this.playScene.add(m);
      this.projViews.push(m);
    }

    // 격파 파편 버스트 풀 (10 × 12점)
    for (let i = 0; i < 10; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BURST_COUNT * 3), 3));
      const mat = new THREE.PointsMaterial({ color: 0xfff2c0, size: 8, sizeAttenuation: false, transparent: true, opacity: 0 });
      const points = new THREE.Points(g, mat);
      points.visible = false;
      points.frustumCulled = false;
      this.playScene.add(points);
      this.bursts.push({ points, mat, vel: new Float32Array(BURST_COUNT * 3), life: 0 });
    }

    // ── ⑤ 전경: 수직 속도선 (화면 px 공간) ──
    this.speedLinePos = new Float32Array(SPEED_LINE_COUNT * 6);
    for (let i = 0; i < SPEED_LINE_COUNT; i++) this.resetSpeedLine(i, true);
    const slGeo = new THREE.BufferGeometry();
    slGeo.setAttribute('position', new THREE.BufferAttribute(this.speedLinePos, 3));
    this.speedLineMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0 });
    this.speedLines = new THREE.LineSegments(slGeo, this.speedLineMat);
    this.speedLines.frustumCulled = false;
    this.fgScene.add(this.speedLines);

    // ── 픽셀 스케일링 블릿 ──
    this.blitMat = new THREE.MeshBasicMaterial({ transparent: false });
    const blitQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMat);
    blitQuad.frustumCulled = false;
    this.blitScene.add(blitQuad);
  }

  private labelMaterial(text: string): THREE.SpriteMaterial {
    let mat = this.labelMaterials.get(text);
    if (mat) return mat;
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 48;
    const c = cv.getContext('2d')!;
    c.font = 'bold 30px monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#ffffff';
    c.fillText(text, 64, 24);
    const tex = new THREE.CanvasTexture(cv);
    mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.75, depthTest: false });
    this.labelMaterials.set(text, mat);
    return mat;
  }

  private resetSpeedLine(i: number, randomY: boolean): void {
    const x = Math.random() * this.widthCss;
    const y = randomY ? Math.random() * this.heightCss : this.heightCss + Math.random() * 200;
    const len = 40 + Math.random() * 120;
    this.speedLinePos[i * 6 + 0] = x;
    this.speedLinePos[i * 6 + 1] = y;
    this.speedLinePos[i * 6 + 2] = 0;
    this.speedLinePos[i * 6 + 3] = x;
    this.speedLinePos[i * 6 + 4] = y + len;
    this.speedLinePos[i * 6 + 5] = 0;
  }

  setSize(width: number, height: number, dpr: number): void {
    this.widthCss = width;
    this.heightCss = height;
    this.dpr = Math.min(dpr, 2);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    this.sky.setAspect(aspect);
    this.objects3d.setAspect(aspect);
    this.slashFx.setSize(width, height);
    this.rtScale = 0; // 다음 프레임에 렌더타깃 재생성
  }

  /** 격파 파편 (월드 wu 좌표) */
  spawnBurst(x: number, y: number): void {
    const b = this.bursts.find(bb => bb.life <= 0) ?? this.bursts[0];
    const pos = b.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < BURST_COUNT; i++) {
      pos.setXYZ(i, x, y, 0.2);
      const a = Math.random() * Math.PI * 2;
      const sp = 1.2 + Math.random() * 3.2;
      b.vel[i * 3] = Math.cos(a) * sp;
      b.vel[i * 3 + 1] = Math.sin(a) * sp + 1.0; // 낙하 중이므로 파편은 위로 흐른다
      b.vel[i * 3 + 2] = 0;
    }
    pos.needsUpdate = true;
    b.life = 0.4;
    b.points.visible = true;
    b.mat.opacity = 1;
  }

  /** 스와이프 궤적 → 베기 이펙트 */
  spawnSlash(path: { x: number; y: number }[], stance: Stance): void {
    this.slashFx.trigger(path, stance);
  }

  drawCalls(): number { return this.renderer.info.render.calls; }

  /** 오버드로우 추정치: 화면 전체를 덮는 패스 수 (스카이 1 + 구름 3 + 블릿) */
  fullscreenPasses(): number {
    return this.sky.fullscreenPasses + (config.pixelScaling === 'pixel' ? 1 : 0);
  }

  /** 활성 레이어 수 (기획서 4장 5레이어) */
  layerCount(): number {
    return 3 + (this.objects3d.activeCount() > 0 ? 1 : 0) + 1; // 원경·중경·게임플레이·(3D)·전경
  }

  renderResolution(): { w: number; h: number } {
    if (config.pixelScaling === 'pixel' && this.rt) return { w: this.rt.width, h: this.rt.height };
    return { w: Math.round(this.widthCss * this.dpr), h: Math.round(this.heightCss * this.dpr) };
  }

  private ensureRenderTarget(): THREE.WebGLRenderTarget | null {
    if (config.pixelScaling !== 'pixel') return null;
    const k = Math.max(2, Math.min(4, Math.round(config.pixelScaleFactor)));
    if (this.rt && this.rtScale === k) return this.rt;
    this.rt?.dispose();
    const w = Math.max(1, Math.floor(this.widthCss / k));
    const h = Math.max(1, Math.floor(this.heightCss / k));
    this.rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter, // 정수 배 업스케일: 보간 없이 픽셀 확대
      depthBuffer: true,
    });
    this.rtScale = k;
    this.blitMat.map = this.rt.texture;
    this.blitMat.needsUpdate = true;
    return this.rt;
  }

  render(sim: Sim, alpha: number, dtSec: number): void {
    const lerp = (a: number, b: number) => a + (b - a) * alpha;
    const gx = lerp(sim.girlPrevX, sim.girlX);
    const gy = lerp(sim.girlPrevY, sim.girlY);
    const zoom = sim.zoomOut;

    // ── 카메라 (게임플레이): Plane2D와 동일한 매핑 ──
    const aspect = this.widthCss / this.heightCss;
    const visH = config.worldHeightWu * zoom;
    const visW = visH * aspect;
    this.playCamera.left = -visW / 2;
    this.playCamera.right = visW / 2;
    this.playCamera.top = visH / 2;
    this.playCamera.bottom = -visH / 2;
    this.playCamera.position.set(0, -(0.5 - config.girlScreenYPct) * visH, 10);
    this.playCamera.updateProjectionMatrix();

    // ── 셰이크 (배경·전경 전용) ──
    const shake = sim.shakeImpulse * config.shakeIntensity;
    this.shakeX = (Math.random() - 0.5) * shake * 0.5;
    this.shakeY = (Math.random() - 0.5) * shake * 0.5;

    // ── ① ② 스카이·구름 ──
    this.sky.update(sim.scrollDistance);

    // ── ③ 3D 오브젝트 ──
    this.objects3d.setDensity(config.object3dDensity);
    const scrollSpeed = config.approachBaseWu * config.scrollSpeedCoef * sim.speed * (sim.diveActive ? 2.2 : 1) * 3.2;
    this.objects3d.update(scrollSpeed, dtSec);
    this.objects3d.camera.position.set(this.shakeX * 0.6, this.shakeY * 0.6, 0);
    this.objects3d.camera.fov = 52 * zoom;
    this.objects3d.camera.updateProjectionMatrix();

    // ── ④ 소녀 ──
    this.girl.root.position.set(gx, gy, 0.5);
    this.girl.setPose(sim.umbrellaOpen ? 'open' : 'fold');
    if (sim.diveActive) {
      // 머리를 앞세운 돌진 자세 (기획서 4장 도약 연출)
      const dx = sim.girlX - sim.girlPrevX, dy = sim.girlY - sim.girlPrevY;
      const ang = Math.hypot(dx, dy) > 1e-5 ? Math.atan2(dy, dx) - Math.PI / 2 : 0;
      this.girl.root.rotation.z = ang;
    } else {
      this.girl.root.rotation.z *= 0.85;
    }
    // 피격 무적 깜빡임
    this.girl.root.visible = !(sim.invulnTimer > 0 && Math.floor(sim.time * 20) % 2 === 0);

    // ── ④ 판정 링 ──
    this.ring.position.set(gx, gy, 0.3);
    this.ring.scale.setScalar(config.ringRadiusWu);
    this.ringPulse = Math.max(0, this.ringPulse - dtSec * 3);
    const ringHot = sim.hittableInRingCount() > 0;
    this.ringMat.color.setHex(sim.diveActive ? 0xffdd66 : ringHot ? 0x8bffcb : 0x9fe8ff);
    this.ringMat.opacity = 0.42 + (ringHot ? 0.3 : 0) + this.ringPulse * 0.3;

    // ── ④ 적 ──
    let ai = 0;
    for (const e of sim.enemies) {
      if (!e.active) continue;
      const v = this.enemyViews[ai++];
      if (!v) break;
      v.root.visible = true;
      v.root.position.set(lerp(e.prevX, e.x), lerp(e.prevY, e.y), 0.4);
      if (v.enemyId !== e.id) {
        v.enemyId = e.id;
        v.label.material = this.labelMaterial(e.type);
      }
      const inRing = e.phase === 'ring' || (e.phase === 'orbit' && (e.type !== 'a-5' || e.exposeTimer > 0));
      let color = ENEMY_COLOR[e.type];
      let rimColor = 0xe8f6ff;
      if (e.telegraphing) { color = TELEGRAPH; rimColor = 0xffd0c0; }      // 공격 예고 0.6초
      else if (inRing) { color = HIGHLIGHT; rimColor = 0xffffff; }         // 링 진입 하이라이트
      else if (e.type === 'a-4' && e.armorBroken) color = 0x9a6fd0;        // 장갑 파괴
      v.mat.color.setHex(color);
      v.rimMat.color.setHex(rimColor);
      v.rimMat.opacity = inRing || e.telegraphing ? 1 : 0.55;
      const r = enemyRadius(e.type);
      v.body.scale.setScalar(r);
      v.rim.scale.setScalar(r * 1.16);
      v.root.rotation.z = e.lifecycle === 'pass' ? Math.atan2(e.dirY, e.dirX) - Math.PI / 2 : 0;
      // 링을 놓치고 통과 중인 적은 흐려져 "이제 벨 수 없다"를 알린다 (질문 5 확정 규칙의 시각화)
      if (e.phase === 'passing') { v.mat.color.setHex(0x555f6e); v.rimMat.opacity = 0.2; }
    }
    for (; ai < this.enemyViews.length; ai++) {
      this.enemyViews[ai].root.visible = false;
      this.enemyViews[ai].enemyId = -1;
    }

    // ── ④ 투사체 ──
    let pi = 0;
    for (const p of sim.projectiles) {
      if (!p.active) continue;
      const m = this.projViews[pi++];
      if (!m) break;
      m.visible = true;
      m.position.set(lerp(p.prevX, p.x), lerp(p.prevY, p.y), 0.45);
    }
    for (; pi < this.projViews.length; pi++) this.projViews[pi].visible = false;

    // ── ④ 파편 ──
    for (const b of this.bursts) {
      if (b.life <= 0) continue;
      b.life -= dtSec;
      if (b.life <= 0) { b.points.visible = false; continue; }
      const pos = b.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < BURST_COUNT; i++) {
        pos.setXYZ(i, pos.getX(i) + b.vel[i * 3] * dtSec, pos.getY(i) + b.vel[i * 3 + 1] * dtSec, 0.2);
      }
      pos.needsUpdate = true;
      b.mat.opacity = b.life / 0.4;
    }

    // ── ⑤ 전경: 속도선 (낙하 속도 비례 밀도·속도) ──
    const speedT = (sim.speed - config.speedMin) / (config.speedMax - config.speedMin);
    this.speedLineMat.opacity = sim.diveActive ? 0.7 : speedT * 0.42;
    const slv = (260 + 1500 * speedT) * (sim.diveActive ? 2.2 : 1) * config.scrollSpeedCoef;
    for (let i = 0; i < SPEED_LINE_COUNT; i++) {
      this.speedLinePos[i * 6 + 1] -= slv * dtSec;
      this.speedLinePos[i * 6 + 4] -= slv * dtSec;
      if (this.speedLinePos[i * 6 + 4] < -20) this.resetSpeedLine(i, false);
    }
    (this.speedLines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    this.speedLines.position.set(this.shakeX * 12, this.shakeY * 12, 0);
    this.slashFx.update(dtSec);

    // ── 합성 ──
    this.renderer.info.reset(); // 프레임 시작: draw call 합계 리셋
    const rt = this.ensureRenderTarget();
    this.renderer.setRenderTarget(rt);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.sky.scene, this.sky.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.objects3d.scene, this.objects3d.camera);
    this.renderer.clearDepth();
    this.renderer.render(this.playScene, this.playCamera);
    this.renderer.clearDepth();
    this.renderer.render(this.fgScene, this.slashFx.camera);
    this.renderer.render(this.slashFx.scene, this.slashFx.camera);

    if (rt) {
      this.renderer.setRenderTarget(null);
      this.renderer.clear(true, true, true);
      this.renderer.render(this.blitScene, this.blitCamera);
    }
  }

  /** 링 진입 시 시각 큐 강화 (main.ts 이벤트 훅) */
  pulseRing(): void { this.ringPulse = 1; }
}
