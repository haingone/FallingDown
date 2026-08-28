/**
 * 베기 궤적 이펙트 — 기획서 v2 부록 A-2 / 16장 1번 "손맛".
 * 본 개편의 액션 아이덴티티: 화면을 가로지르는 과장된 절단 궤적 + 잔광.
 *
 * 전부 프로시저럴 (셰이더 + 런타임 생성 지오메트리). 텍스처 에셋 없음.
 * 우산 = 넓은 호(弧), 검 = 가늘고 예리한 직선 — 기획서 v2 5장 2스탠스 차별화.
 *
 * 주의: **판정은 실제 손가락 궤적으로만** 이루어진다 (core/sim.applySwipeSegment).
 * 이 궤적의 화면 횡단 연출은 시각적 과장이며 판정 범위를 넓히지 않는다.
 */
import * as THREE from 'three';
import type { Stance } from '../core/sim';
import { config } from '../core/balance';
import * as PAL from './palette';

const MAX_SEG = 40;               // 리본 분할 수
const POOL_SIZE = 6;
const UMBRELLA_WIDTH = 0.115;     // 필드 단위 (1.0 = 화면 폭)
const SWORD_WIDTH = 0.042;
const UMBRELLA_BOW = 0.13;        // 호의 부풀림
const TARGET_LENGTH = 1.55;       // 화면 폭의 1.55배 — "화면을 가로지르는" 과장

const VERT = /* glsl */`
  attribute float aU;
  attribute float aV;
  varying float vU;
  varying float vV;
  void main() {
    vU = aU;
    vV = aV;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision mediump float;
  uniform float uAge;      // 0..1
  uniform vec3 uEdgeColor;
  uniform float uCoreWidth;
  varying float vU;
  varying float vV;
  void main() {
    // 폭 방향: 중앙이 흰 코어, 바깥으로 갈수록 색이 붙고 사라진다
    float across = abs(vV * 2.0 - 1.0);
    float body = pow(1.0 - across, 1.6);
    float core = smoothstep(uCoreWidth, 0.0, across);

    // 길이 방향: 양 끝이 뾰족하게 사라지는 초승달 형태
    float along = sin(3.14159 * clamp(vU, 0.0, 1.0));
    along = pow(along, 0.55);

    // 잔광: 시간이 지나며 코어부터 죽고 색만 남는다
    float fade = 1.0 - uAge;
    float alpha = body * along * fade;
    vec3 color = mix(uEdgeColor, vec3(1.0), core * fade);
    gl_FragColor = vec4(color, alpha * (0.55 + 0.45 * fade));
  }
`;

interface Ribbon {
  mesh: THREE.Mesh;
  geo: THREE.BufferGeometry;
  pos: THREE.BufferAttribute;
  mat: THREE.ShaderMaterial;
  life: number;
  maxLife: number;
}

export class SlashTrails {
  private pool: Ribbon[] = [];

  constructor(scene: THREE.Scene, z: number) {
    const index: number[] = [];
    for (let i = 0; i < MAX_SEG; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      index.push(a, b, c, b, d, c);
    }
    const aU = new Float32Array((MAX_SEG + 1) * 2);
    const aV = new Float32Array((MAX_SEG + 1) * 2);
    for (let i = 0; i <= MAX_SEG; i++) {
      const u = i / MAX_SEG;
      aU[i * 2] = u; aU[i * 2 + 1] = u;
      aV[i * 2] = 0; aV[i * 2 + 1] = 1;
    }

    for (let p = 0; p < POOL_SIZE; p++) {
      const geo = new THREE.BufferGeometry();
      const pos = new THREE.BufferAttribute(new Float32Array((MAX_SEG + 1) * 2 * 3), 3);
      pos.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', pos);
      geo.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
      geo.setAttribute('aV', new THREE.BufferAttribute(aV, 1));
      geo.setIndex(index);
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: {
          uAge: { value: 1 },
          uEdgeColor: { value: new THREE.Color(PAL.COLD_CYAN) },
          uCoreWidth: { value: 0.45 },
        },
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        // 리본의 삼각형 와인딩은 스와이프 방향에 따라 뒤집힌다 → 양면 렌더 필수
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.z = z;
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      this.pool.push({ mesh, geo, pos, mat, life: 0, maxLife: 0.3 });
    }
  }

  /**
   * 스와이프 궤적 발사. start/end는 필드 좌표.
   * 실제 손가락 경로의 시작·끝만 받아 화면 횡단 길이로 과장한다.
   */
  spawn(startX: number, startY: number, endX: number, endY: number, stance: Stance): void {
    let dx = endX - startX, dy = endY - startY;
    let len = Math.hypot(dx, dy);
    if (len < 1e-4) { dx = 1; dy = 0; len = 1; }
    const ux = dx / len, uy = dy / len;

    // 화면을 가로지르도록 양 끝을 연장 (연출 전용 — 판정과 무관)
    const extend = Math.max(0, (TARGET_LENGTH - len) / 2);
    const ax = startX - ux * extend, ay = startY - uy * extend;
    const bx = endX + ux * extend, by = endY + uy * extend;

    const isUmbrella = stance === 'umbrella';
    const width = isUmbrella ? UMBRELLA_WIDTH : SWORD_WIDTH;
    const bow = isUmbrella ? UMBRELLA_BOW : 0;
    // 호의 볼록 방향: 진행 방향의 왼쪽
    const cx = (ax + bx) / 2 - uy * bow;
    const cy = (ay + by) / 2 + ux * bow;

    const r = this.pool.find(rb => rb.life <= 0) ?? this.oldest();
    const arr = r.pos.array as Float32Array;
    for (let i = 0; i <= MAX_SEG; i++) {
      const t = i / MAX_SEG;
      const mt = 1 - t;
      // 2차 베지어
      const px = mt * mt * ax + 2 * mt * t * cx + t * t * bx;
      const py = mt * mt * ay + 2 * mt * t * cy + t * t * by;
      // 접선 → 법선
      const tx = 2 * mt * (cx - ax) + 2 * t * (bx - cx);
      const ty = 2 * mt * (cy - ay) + 2 * t * (by - cy);
      const tl = Math.hypot(tx, ty) || 1;
      const nx = -ty / tl, ny = tx / tl;
      // 폭 프로파일: 중앙이 두껍고 양 끝이 뾰족
      const w = (width / 2) * Math.pow(Math.sin(Math.PI * t), 0.7);
      const o = i * 6;
      arr[o + 0] = px - nx * w; arr[o + 1] = py - ny * w; arr[o + 2] = 0;
      arr[o + 3] = px + nx * w; arr[o + 4] = py + ny * w; arr[o + 5] = 0;
    }
    r.pos.needsUpdate = true;
    r.mat.uniforms.uAge.value = 0;
    r.mat.uniforms.uCoreWidth.value = isUmbrella ? 0.42 : 0.62; // 검은 코어 비중이 커 더 예리해 보인다
    // **우산/검 구분은 색이 아니라 형태**다 (fx_palette §2.2) — 양쪽 모두 콜드 시안 계열.
    // 우산은 바깥으로 갈수록 저명도 시안, 검은 고명도 시안 단색.
    (r.mat.uniforms.uEdgeColor.value as THREE.Color).setHex(isUmbrella ? PAL.CYAN_DEEP : PAL.COLD_CYAN);
    r.mesh.visible = true;
    r.maxLife = Math.max(0.05, config.slashLifeSec);
    r.life = r.maxLife;
  }

  private oldest(): Ribbon {
    let best = this.pool[0];
    for (const r of this.pool) if (r.life < best.life) best = r;
    return best;
  }

  update(dtSec: number): void {
    for (const r of this.pool) {
      if (r.life <= 0) continue;
      r.life -= dtSec;
      if (r.life <= 0) {
        r.mesh.visible = false;
        continue;
      }
      r.mat.uniforms.uAge.value = 1 - r.life / r.maxLife;
    }
  }

  activeCount(): number {
    return this.pool.reduce((n, r) => n + (r.life > 0 ? 1 : 0), 0);
  }
}
