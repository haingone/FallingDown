/**
 * 레이어 ① 원경 (스카이 그라데이션 + 지구/달 구체) + 레이어 ② 중경 (패럴랙스 구름 2~3장).
 * 기획서 v2 4장. 텍스처 에셋 금지 원칙에 따라 전부 프로시저럴 셰이더로 그린다.
 *
 * 팔레트는 부록 A-1 "청록 낮 하늘" 컨셉 목업 기준 (프로덕션 확정본 아님 — AD 소관).
 */
import * as THREE from 'three';

/** 값 노이즈 + 3옥타브 fbm (구름용, 모바일 부하 고려해 옥타브 최소화) */
const NOISE_GLSL = `
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.55;
  for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
  return v;
}
`;

const SKY_VERT = `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const SKY_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uHorizon;
uniform vec3 uOrbColor;
uniform vec2 uOrbPos;     // 화면 비율 좌표
uniform float uOrbRadius;
uniform float uAspect;
void main() {
  float t = vUv.y;
  vec3 col = mix(uBottom, uHorizon, smoothstep(0.0, 0.55, t));
  col = mix(col, uTop, smoothstep(0.45, 1.0, t));
  // 지구/달 구체: 소프트 디스크 + 명암 (별도 지오메트리 없이 스카이 패스에 합성 = 드로우콜 1)
  vec2 d = (vUv - uOrbPos) * vec2(uAspect, 1.0);
  float r = length(d) / uOrbRadius;
  float disk = smoothstep(1.0, 0.94, r);
  float shade = 0.55 + 0.45 * clamp(1.0 - length(d - vec2(-0.03, 0.04)) / (uOrbRadius * 1.6), 0.0, 1.0);
  col = mix(col, uOrbColor * shade, disk * 0.92);
  float halo = smoothstep(1.7, 1.0, r) * 0.10;
  col += uOrbColor * halo;
  gl_FragColor = vec4(col, 1.0);
}
`;

const CLOUD_FRAG = `
precision mediump float;
varying vec2 vUv;
uniform vec3 uColor;
uniform float uScroll;
uniform vec2 uScale;
uniform float uThreshold;
uniform float uOpacity;
uniform float uAspect;
${NOISE_GLSL}
void main() {
  vec2 p = vec2(vUv.x * uAspect * uScale.x, vUv.y * uScale.y + uScroll);
  float n = fbm(p);
  float m = smoothstep(uThreshold, uThreshold + 0.22, n);
  // 위/아래 가장자리 페이드 (레이어 경계가 직선으로 드러나지 않도록)
  m *= smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.88, vUv.y);
  gl_FragColor = vec4(uColor, m * uOpacity);
  if (gl_FragColor.a < 0.004) discard;
}
`;

export interface SkyPalette {
  top: number; horizon: number; bottom: number;
  orb: number; cloudNear: number; cloudFar: number;
}

/** 챕터 1 "청록 낮 하늘" (부록 A-1) */
export const PALETTE_TEAL_DAY: SkyPalette = {
  top: 0x8fdcea,
  horizon: 0x59b6cf,
  bottom: 0x1b4f6d,
  orb: 0xdff4ff,
  cloudNear: 0xffffff,
  cloudFar: 0xbfe4f2,
};

interface CloudLayer {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  parallax: number; // 스크롤 속도 계수 (원경일수록 작다)
}

export class SkyLayer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 10);
  private skyMat: THREE.ShaderMaterial;
  private clouds: CloudLayer[] = [];

  constructor(palette: SkyPalette = PALETTE_TEAL_DAY) {
    const quad = new THREE.PlaneGeometry(2, 2);

    this.skyMat = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color(palette.top) },
        uHorizon: { value: new THREE.Color(palette.horizon) },
        uBottom: { value: new THREE.Color(palette.bottom) },
        uOrbColor: { value: new THREE.Color(palette.orb) },
        uOrbPos: { value: new THREE.Vector2(0.74, 0.88) },
        uOrbRadius: { value: 0.12 },
        uAspect: { value: 9 / 16 },
      },
    });
    const sky = new THREE.Mesh(quad, this.skyMat);
    sky.frustumCulled = false;
    sky.renderOrder = 0;
    this.scene.add(sky);

    // 구름 3장: 원경(느림·연함) → 근경(빠름·진함). 패럴랙스 = 속도 차등 (기획서 4장 2번)
    const specs = [
      { color: palette.cloudFar, scale: [2.0, 1.3], threshold: 0.52, opacity: 0.38, parallax: 0.10 },
      { color: palette.cloudFar, scale: [3.2, 2.0], threshold: 0.50, opacity: 0.48, parallax: 0.26 },
      { color: palette.cloudNear, scale: [4.6, 3.0], threshold: 0.54, opacity: 0.62, parallax: 0.55 },
    ];
    for (let i = 0; i < specs.length; i++) {
      const s = specs[i];
      const mat = new THREE.ShaderMaterial({
        vertexShader: SKY_VERT,
        fragmentShader: CLOUD_FRAG,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        uniforms: {
          uColor: { value: new THREE.Color(s.color) },
          uScroll: { value: Math.random() * 10 },
          uScale: { value: new THREE.Vector2(s.scale[0], s.scale[1]) },
          uThreshold: { value: s.threshold },
          uOpacity: { value: s.opacity },
          uAspect: { value: 9 / 16 },
        },
      });
      const mesh = new THREE.Mesh(quad, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 1 + i;
      this.scene.add(mesh);
      this.clouds.push({ mesh, mat, parallax: s.parallax });
    }
  }

  /** 레이어 수 (오버드로우 추정치 = 풀스크린 패스 수) */
  get fullscreenPasses(): number { return 1 + this.clouds.length; }

  setAspect(aspect: number): void {
    this.skyMat.uniforms.uAspect.value = aspect;
    for (const c of this.clouds) c.mat.uniforms.uAspect.value = aspect;
  }

  /** scrollDistance(wu 누적) 기준으로 각 레이어를 상방 스크롤 */
  update(scrollDistance: number): void {
    for (const c of this.clouds) {
      c.mat.uniforms.uScroll.value = -scrollDistance * c.parallax * 0.18;
    }
  }
}
