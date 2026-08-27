/**
 * three.js 렌더러 — 시뮬레이션 상태를 구독해 그리기만 한다 (로직 없음).
 * 카메라 모델은 core/projection.ts의 Projector와 동일해야 한다 (축 정렬, camHeight, FOV).
 */
import * as THREE from 'three';
import type { Sim, Enemy, EnemyType } from '../core/sim';
import { config } from '../core/balance';

const ENEMY_COLOR: Record<EnemyType, number> = {
  'a-1': 0x9aa0a6, // 하급: 무채색 계열
  'a-2': 0x7fb3a6,
  'a-3': 0xb8a97f,
  'a-4': 0x8f6fb3, // 중급: 보라 계열
  'a-5': 0xb36f8a,
};
const HIGHLIGHT = 0x33ff88;   // 링 진입 하이라이트
const TELEGRAPH = 0xff4422;   // 공격 예고 발광

interface EnemyView {
  root: THREE.Group;
  body: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  label: THREE.Sprite;
  enemyId: number;
}

interface Burst {
  points: THREE.Points;
  mat: THREE.PointsMaterial;
  vel: Float32Array;
  life: number;
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private girl: THREE.Mesh;
  private girlMat: THREE.MeshLambertMaterial;
  private ring: THREE.Mesh;
  private ringMat: THREE.MeshBasicMaterial;
  private enemyViews: EnemyView[] = [];
  private projViews: THREE.Mesh[] = [];
  private clouds: THREE.Mesh[] = [];
  private speedLines: THREE.LineSegments;
  private speedLinePos: Float32Array;
  private speedLineMat: THREE.LineBasicMaterial;
  private bursts: Burst[] = [];
  private labelTextures = new Map<string, THREE.SpriteMaterial>();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setClearColor(0x101622);
    this.camera = new THREE.PerspectiveCamera(60, 9 / 16, 0.1, 100);
    this.camera.up.set(0, 0, -1); // 화면 위 = -z (Projector와 일치)

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(2, 5, -3);
    this.scene.add(dir);

    // 소녀: 캡슐 프리미티브, 접음=빨강 / 펼침=파랑 (지시문 3)
    this.girlMat = new THREE.MeshLambertMaterial({ color: 0xdd3333 });
    this.girl = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 0.7, 4, 10), this.girlMat);
    this.scene.add(this.girl);

    // 판정 링: 상시 표시 (기획서 15장)
    this.ringMat = new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(config.ringRadiusWu, 0.035, 6, 48), this.ringMat);
    this.ring.rotation.x = Math.PI / 2; // XZ 평면에 눕힘
    this.scene.add(this.ring);

    // 적 뷰 풀 (64) — 구체 + 코드명 라벨
    const sphereGeo = new THREE.SphereGeometry(1, 10, 8);
    for (let i = 0; i < 64; i++) {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const body = new THREE.Mesh(sphereGeo, mat);
      const root = new THREE.Group();
      root.add(body);
      const label = new THREE.Sprite(this.labelMaterial('a-1'));
      label.position.set(0, 0, -0.75); // 화면상 위쪽(-z)
      label.scale.set(0.9, 0.34, 1);
      root.add(label);
      root.visible = false;
      this.scene.add(root);
      this.enemyViews.push({ root, body, mat, label, enemyId: -1 });
    }

    // 투사체 뷰 풀 (16)
    const projGeo = new THREE.SphereGeometry(0.14, 8, 6);
    const projMatBase = new THREE.MeshBasicMaterial({ color: 0xffaa22 });
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(projGeo, projMatBase);
      m.visible = false;
      this.scene.add(m);
      this.projViews.push(m);
    }

    // 배경 스크롤 구름/먼지 (낙하 표현 — 지시문 1: 배경 스크롤 방식)
    const cloudGeo = new THREE.BoxGeometry(1, 0.25, 1);
    const cloudMat = new THREE.MeshLambertMaterial({ color: 0x2a3550, transparent: true, opacity: 0.8 });
    for (let i = 0; i < 36; i++) {
      const c = new THREE.Mesh(cloudGeo, cloudMat);
      this.resetCloud(c, true);
      this.scene.add(c);
      this.clouds.push(c);
    }

    // 방사형 속도선: 낙하축 방향 수직 스트릭 — 축 방향 시점에서 방사형으로 투영됨
    const N = 90;
    this.speedLinePos = new Float32Array(N * 6);
    for (let i = 0; i < N; i++) this.resetSpeedLine(i, true);
    const slGeo = new THREE.BufferGeometry();
    slGeo.setAttribute('position', new THREE.BufferAttribute(this.speedLinePos, 3));
    this.speedLineMat = new THREE.LineBasicMaterial({ color: 0x99bbff, transparent: true, opacity: 0 });
    this.speedLines = new THREE.LineSegments(slGeo, this.speedLineMat);
    this.scene.add(this.speedLines);

    // 격파 파티클 버스트 풀 (8 × 14점)
    for (let i = 0; i < 8; i++) {
      const g = new THREE.BufferGeometry();
      const pos = new Float32Array(14 * 3);
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({ color: 0xffee88, size: 0.12, transparent: true, opacity: 0 });
      const points = new THREE.Points(g, mat);
      points.visible = false;
      this.scene.add(points);
      this.bursts.push({ points, mat, vel: new Float32Array(14 * 3), life: 0 });
    }
  }

  private labelMaterial(text: string): THREE.SpriteMaterial {
    let mat = this.labelTextures.get(text);
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
    mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.9, depthTest: false });
    this.labelTextures.set(text, mat);
    return mat;
  }

  private resetCloud(c: THREE.Mesh, randomY: boolean): void {
    const r = 3 + Math.random() * 9;
    const a = Math.random() * Math.PI * 2;
    c.position.set(Math.cos(a) * r, randomY ? -40 + Math.random() * 44 : -40 - Math.random() * 6, Math.sin(a) * r);
    const s = 0.6 + Math.random() * 2.2;
    c.scale.set(s, 1, s * (0.5 + Math.random()));
  }

  private resetSpeedLine(i: number, randomY: boolean): void {
    const r = 2.2 + Math.random() * 6;
    const a = Math.random() * Math.PI * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const y = randomY ? -30 + Math.random() * 34 : -30 - Math.random() * 4;
    const len = 1.5 + Math.random() * 2;
    this.speedLinePos[i * 6 + 0] = x;
    this.speedLinePos[i * 6 + 1] = y;
    this.speedLinePos[i * 6 + 2] = z;
    this.speedLinePos[i * 6 + 3] = x;
    this.speedLinePos[i * 6 + 4] = y - len;
    this.speedLinePos[i * 6 + 5] = z;
  }

  setSize(width: number, height: number, dpr: number): void {
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  spawnBurst(x: number, y: number, z: number): void {
    const b = this.bursts.find(bb => bb.life <= 0) ?? this.bursts[0];
    const pos = b.points.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < 14; i++) {
      pos.setXYZ(i, x, y, z);
      b.vel[i * 3] = (Math.random() - 0.5) * 4;
      b.vel[i * 3 + 1] = (Math.random() - 0.5) * 4;
      b.vel[i * 3 + 2] = (Math.random() - 0.5) * 4;
    }
    pos.needsUpdate = true;
    b.life = 0.35;
    b.points.visible = true;
    b.mat.opacity = 1;
  }

  drawCalls(): number {
    return this.renderer.info.render.calls;
  }

  render(sim: Sim, alpha: number, dtSec: number): void {
    const lerp = (a: number, b: number) => a + (b - a) * alpha;
    const gx = lerp(sim.girlPrevX, sim.girlX);
    const gy = lerp(sim.girlPrevY, sim.girlY);
    const gz = lerp(sim.girlPrevZ, sim.girlZ);

    // 카메라: 소녀 상방에서 낙하 방향(-y)을 내려다봄, FOV는 속도 연동 (Projector와 동일 모델)
    this.camera.fov = sim.fov;
    this.camera.position.set(gx, gy + config.camHeightWu, gz);
    this.camera.lookAt(gx, gy, gz);
    this.camera.updateProjectionMatrix();

    // 소녀: 상태 색 + 도약 시 돌진 자세(전방 기울임)
    this.girl.position.set(gx, gy, gz);
    this.girlMat.color.setHex(sim.diveActive ? 0xffcc33 : sim.umbrellaOpen ? 0x3355dd : 0xdd3333);
    this.girl.rotation.x = sim.diveActive ? Math.PI * 0.35 : 0;

    // 판정 링 (반경 튜닝 실시간 반영)
    this.ring.position.set(gx, gy, gz);
    const ringScale = config.ringRadiusWu / 1.6;
    this.ring.scale.set(ringScale, ringScale, ringScale);
    this.ringMat.color.setHex(sim.diveActive ? 0xffdd55 : 0x66ccff);

    // 적
    const activeEnemies: Enemy[] = [];
    for (const e of sim.enemies) if (e.active) activeEnemies.push(e);
    for (let i = 0; i < this.enemyViews.length; i++) {
      const v = this.enemyViews[i];
      const e = activeEnemies[i];
      if (!e) {
        v.root.visible = false;
        v.enemyId = -1;
        continue;
      }
      v.root.visible = true;
      v.root.position.set(lerp(e.prevX, e.x), lerp(e.prevY, e.y), lerp(e.prevZ, e.z));
      const def = e.type;
      if (v.enemyId !== e.id) {
        v.enemyId = e.id;
        v.label.material = this.labelMaterial(def);
      }
      const inRing = e.phase === 'ring' || (e.phase === 'orbit' && (e.type !== 'a-5' || e.exposeTimer > 0));
      let color = ENEMY_COLOR[def];
      if (e.telegraphing) color = TELEGRAPH;            // 공격 예고 0.6초 발광
      else if (inRing) color = HIGHLIGHT;               // 링 진입 하이라이트
      else if (e.type === 'a-4' && e.armorBroken) color = 0xddaaff; // 장갑 파괴 표현
      v.mat.color.setHex(color);
      const r = e.type === 'a-4' || e.type === 'a-5' ? 0.38 : e.type === 'a-3' ? 0.28 : 0.32;
      v.body.scale.set(r, r, r);
    }

    // 투사체
    const activeProj = sim.projectiles.filter(p => p.active);
    for (let i = 0; i < this.projViews.length; i++) {
      const m = this.projViews[i];
      const p = activeProj[i];
      if (!p) { m.visible = false; continue; }
      m.visible = true;
      m.position.set(p.x, p.y, p.z);
    }

    // 배경 스크롤: 낙하 속도 비례
    const scroll = 6 * sim.speed * (sim.diveActive ? 2 : 1);
    for (const c of this.clouds) {
      c.position.y += scroll * dtSec;
      if (c.position.y > config.camHeightWu + 2) this.resetCloud(c, false);
    }

    // 속도선: 밀도(불투명도)·속도 모두 낙하 속도 비례
    const speedT = (sim.speed - config.speedMin) / (config.speedMax - config.speedMin);
    this.speedLineMat.opacity = sim.diveActive ? 0.75 : speedT * 0.55;
    const slv = (10 + 26 * speedT) * (sim.diveActive ? 2 : 1);
    for (let i = 0; i < 90; i++) {
      this.speedLinePos[i * 6 + 1] += slv * dtSec;
      this.speedLinePos[i * 6 + 4] += slv * dtSec;
      if (this.speedLinePos[i * 6 + 4] > config.camHeightWu + 1) this.resetSpeedLine(i, false);
    }
    (this.speedLines.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;

    // 파티클 버스트
    for (const b of this.bursts) {
      if (b.life <= 0) continue;
      b.life -= dtSec;
      if (b.life <= 0) { b.points.visible = false; continue; }
      const pos = b.points.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < 14; i++) {
        pos.setXYZ(i, pos.getX(i) + b.vel[i * 3] * dtSec, pos.getY(i) + b.vel[i * 3 + 1] * dtSec, pos.getZ(i) + b.vel[i * 3 + 2] * dtSec);
      }
      pos.needsUpdate = true;
      b.mat.opacity = b.life / 0.35;
    }

    this.renderer.render(this.scene, this.camera);
  }
}
