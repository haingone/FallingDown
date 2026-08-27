/**
 * 레이어 ③ 3D 오브젝트 레이어 — HD-2D 성립 검증용 최소 구현 (기획서 v2 4장).
 * 로우폴리 프리미티브 유적 3종(아치 / 계단 / 잔해)이 원근 카메라 아래 스크롤에 따라
 * 깊이감 있게 통과한다. **연출 전용 — 판정에 일절 관여하지 않는다.**
 *
 * 에셋 금지 원칙: 지오메트리는 three.js 프리미티브 조합, 머티리얼은 단색 + 안개 페이드.
 */
import * as THREE from 'three';

export type RuinKind = 'arch' | 'stairs' | 'debris';

interface RuinObject {
  root: THREE.Group;
  spin: number;
}

const RUIN_COLOR = 0x6f8ea6;
const RUIN_COLOR_FAR = 0x4a6b83;

export class Objects3DLayer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(52, 9 / 16, 0.5, 160);
  private objects: RuinObject[] = [];
  private geoCache = new Map<RuinKind, THREE.BufferGeometry[]>();
  private matNear: THREE.MeshLambertMaterial;
  private matFar: THREE.MeshLambertMaterial;
  private readonly maxObjects = 24;
  /** 스폰/리셋 범위 (월드 y) */
  private readonly bottomY = -46;
  private readonly topY = 42;

  constructor(fogColor = 0x1b4f6d) {
    this.camera.position.set(0, 0, 0);
    this.camera.lookAt(0, 0, -1);
    this.scene.fog = new THREE.Fog(fogColor, 34, 150); // 깊이감 보조 (원경일수록 하늘색에 묻힌다)

    this.scene.add(new THREE.AmbientLight(0xdff0ff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(-3, 6, 2);
    this.scene.add(key);

    this.matNear = new THREE.MeshLambertMaterial({ color: RUIN_COLOR, fog: true });
    this.matFar = new THREE.MeshLambertMaterial({ color: RUIN_COLOR_FAR, fog: true });

    for (let i = 0; i < this.maxObjects; i++) {
      const kind: RuinKind = i % 3 === 0 ? 'arch' : i % 3 === 1 ? 'stairs' : 'debris';
      const root = this.buildRuin(kind, i);
      root.visible = false;
      this.scene.add(root);
      const o: RuinObject = { root, spin: (Math.random() - 0.5) * 0.25 };
      this.objects.push(o);
      this.reset(o, true);
    }
  }

  private geometriesFor(kind: RuinKind): THREE.BufferGeometry[] {
    let g = this.geoCache.get(kind);
    if (g) return g;
    if (kind === 'arch') {
      // 반원 아치 + 기둥 2 (부록 A-3 "부유 계단·아치 유적" 참조)
      g = [
        new THREE.TorusGeometry(2.2, 0.42, 5, 12, Math.PI),
        new THREE.BoxGeometry(0.8, 3.0, 0.8),
      ];
    } else if (kind === 'stairs') {
      g = [new THREE.BoxGeometry(2.6, 0.5, 1.4)];
    } else {
      g = [new THREE.IcosahedronGeometry(1, 0), new THREE.BoxGeometry(1.6, 0.4, 1.6)];
    }
    this.geoCache.set(kind, g);
    return g;
  }

  private buildRuin(kind: RuinKind, index: number): THREE.Group {
    const root = new THREE.Group();
    const geos = this.geometriesFor(kind);
    const mat = index % 2 === 0 ? this.matNear : this.matFar;
    if (kind === 'arch') {
      const arch = new THREE.Mesh(geos[0], mat);
      root.add(arch);
      for (const sx of [-1, 1]) {
        const pillar = new THREE.Mesh(geos[1], mat);
        pillar.position.set(sx * 2.2, -1.5, 0);
        root.add(pillar);
      }
    } else if (kind === 'stairs') {
      for (let i = 0; i < 4; i++) {
        const step = new THREE.Mesh(geos[0], mat);
        step.position.set(i * 0.9, -i * 0.5, 0);
        step.scale.set(1, 1, 1 - i * 0.12);
        root.add(step);
      }
    } else {
      const chunk = new THREE.Mesh(geos[0], mat);
      chunk.scale.setScalar(0.8 + (index % 3) * 0.35);
      root.add(chunk);
      const slab = new THREE.Mesh(geos[1], mat);
      slab.position.set(0.9, -0.7, -0.4);
      slab.rotation.set(0.4, 0.7, 0.2);
      root.add(slab);
    }
    return root;
  }

  private reset(o: RuinObject, randomY: boolean): void {
    // 깊이: 가까운 것(빠르게 스침)부터 먼 것(느리게 흐름)까지.
    // 게임플레이 레이어를 가리지 않도록 최소 깊이를 충분히 두고, 근경일수록 화면 가장자리로 밀어낸다.
    const depth = 24 + Math.random() * 76;
    const spread = 6 + depth * 0.30;
    // 가로 위치: 화면 중앙(전투 공간)을 피해 좌우로 치우치게 배치
    const side = Math.random() < 0.5 ? -1 : 1;
    o.root.position.set(
      side * (spread * (0.35 + Math.random() * 0.65)),
      randomY ? this.bottomY + Math.random() * (this.topY - this.bottomY) : this.bottomY - Math.random() * 8,
      -depth,
    );
    o.root.rotation.set(Math.random() * 0.6 - 0.3, Math.random() * Math.PI * 2, Math.random() * 0.5 - 0.25);
    const s = 0.9 + Math.random() * 2.4;
    o.root.scale.setScalar(s);
    o.spin = (Math.random() - 0.5) * 0.2;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** 활성 오브젝트 수 (튜닝 패널: 3D 오브젝트 밀도) */
  setDensity(n: number): void {
    const k = Math.max(0, Math.min(this.maxObjects, Math.round(n)));
    for (let i = 0; i < this.objects.length; i++) this.objects[i].root.visible = i < k;
  }

  activeCount(): number { return this.objects.filter(o => o.root.visible).length; }

  /**
   * 낙하 = 오브젝트가 상방으로 흐른다. 월드 속도는 동일하고 깊이(원근)가 패럴랙스를 만든다.
   * @param scrollSpeed 초당 월드 이동량 (wu/s 기준을 3D 씬 스케일로 환산해 전달)
   */
  update(scrollSpeed: number, dtSec: number): void {
    for (const o of this.objects) {
      if (!o.root.visible) continue;
      o.root.position.y += scrollSpeed * dtSec;
      o.root.rotation.y += o.spin * dtSec;
      if (o.root.position.y > this.topY) this.reset(o, false);
    }
  }
}
