/**
 * Sprite-Gen 반입 로더 (지시문 P1.5 §B-1).
 *
 * `art/sprites/manifest.json` + 시트 PNG를 읽어 실루엣 플레이스홀더를 자동 대체한다.
 * **시트가 없으면 조용히 null을 돌려주고 기존 실루엣이 유지된다** — 점진 적용 구조.
 *
 * Sprite-Gen 실제 출력 스키마를 아직 확인하지 못했으므로(AD 산출 대기),
 * 흔한 표기 변형을 폭넓게 수용하도록 관용적으로 파싱한다.
 * 정식 규격은 `art/sprites/README.md` 참조 — AD 산출물이 오면 그쪽을 정본으로 삼고 여기를 좁힌다.
 */
import * as THREE from 'three';

/** 게임이 요구하는 클립 키 (manifest에서 이 이름으로 찾는다) */
export type ClipKey = 'girl.folded' | 'girl.open' | 'a-1' | 'a-2' | 'a-3' | 'a-4' | 'a-5';

export interface SpriteFrame {
  texture: THREE.Texture;
  /** 가로/세로 비 — 스프라이트 셀 비율에 맞춰 메시를 늘린다 */
  aspect: number;
}

export interface SpriteClip {
  frames: SpriteFrame[];
  fps: number;
}

export interface SpriteAtlas {
  clips: Map<ClipKey, SpriteClip>;
  sheetFile: string;
  sheetWidth: number;
  sheetHeight: number;
  frameCount: number;
}

interface RawRect { x: number; y: number; w: number; h: number }

const CLIP_ALIASES: Record<ClipKey, string[]> = {
  'girl.folded': ['girl.folded', 'girl_folded', 'girl-folded', 'girl_closed', 'girl.umbrella_closed', 'folded'],
  'girl.open': ['girl.open', 'girl_open', 'girl-open', 'girl.umbrella_open', 'open'],
  'a-1': ['a-1', 'a_1', 'a1'],
  'a-2': ['a-2', 'a_2', 'a2'],
  'a-3': ['a-3', 'a_3', 'a3'],
  'a-4': ['a-4', 'a_4', 'a4'],
  'a-5': ['a-5', 'a_5', 'a5'],
};

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** {x,y,w,h} / {x,y,width,height} / {frame:{...}} 를 모두 수용 */
function readRect(raw: unknown): RawRect | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.frame) return readRect(o.frame);
  const x = num(o.x), y = num(o.y);
  const w = num(o.w) ?? num(o.width);
  const h = num(o.h) ?? num(o.height);
  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w, h };
}

/** 클립 하나의 프레임 사각형 목록을 뽑는다. 명시 rect 배열 또는 row/count + 셀 크기 방식 지원 */
function readFrames(raw: unknown, cellW: number, cellH: number): RawRect[] {
  if (Array.isArray(raw)) {
    return raw.map(readRect).filter((r): r is RawRect => r !== null);
  }
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;

  if (Array.isArray(o.frames)) {
    const rects = o.frames.map(readRect).filter((r): r is RawRect => r !== null);
    if (rects.length > 0) return rects;
  }

  // row/count 방식: 셀 크기를 알아야 계산 가능
  const count = num(o.count) ?? num(o.frameCount) ?? (Array.isArray(o.frames) ? o.frames.length : null);
  const row = num(o.row) ?? num(o.y) ?? 0;
  const col0 = num(o.col) ?? num(o.x) ?? 0;
  if (count !== null && cellW > 0 && cellH > 0) {
    const out: RawRect[] = [];
    for (let i = 0; i < count; i++) {
      out.push({ x: (col0 + i) * cellW, y: row * cellH, w: cellW, h: cellH });
    }
    return out;
  }
  return [];
}

function findClipEntry(
  clipMap: Record<string, unknown>, key: ClipKey,
): unknown | null {
  const lowered = new Map<string, unknown>();
  for (const [k, v] of Object.entries(clipMap)) lowered.set(k.toLowerCase(), v);
  for (const alias of CLIP_ALIASES[key]) {
    const hit = lowered.get(alias.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return null;
}

/**
 * 스프라이트 아틀라스 로드. 실패(파일 없음·형식 불일치)하면 null — 호출측은 실루엣을 유지한다.
 * @param baseUrl 기본 './sprites/' (vite base 상대 — 하위 경로 배포에서도 동작)
 */
export async function loadSpriteAtlas(baseUrl = './sprites/'): Promise<SpriteAtlas | null> {
  let manifest: Record<string, unknown>;
  try {
    const res = await fetch(`${baseUrl}manifest.json`, { cache: 'no-cache' });
    if (!res.ok) return null;
    manifest = await res.json();
  } catch {
    return null; // 아직 반입 전 — 정상 경로
  }

  const sheetFile =
    (typeof manifest.sheet === 'string' && manifest.sheet) ||
    (typeof manifest.image === 'string' && manifest.image) ||
    (typeof manifest.file === 'string' && manifest.file) ||
    'sprite-sheet-alpha.png';

  const cell = num(manifest.cellSize) ?? num(manifest.cell) ?? 0;
  const cellW = num(manifest.cellWidth) ?? cell;
  const cellH = num(manifest.cellHeight) ?? cell;
  const defaultFps = num(manifest.fps) ?? 6;

  const clipSource =
    (manifest.clips as Record<string, unknown> | undefined) ??
    (manifest.animations as Record<string, unknown> | undefined) ??
    (manifest.states as Record<string, unknown> | undefined);
  if (!clipSource || typeof clipSource !== 'object') return null;

  let texture: THREE.Texture;
  try {
    texture = await new THREE.TextureLoader().loadAsync(`${baseUrl}${sheetFile}`);
  } catch {
    console.warn('[sprites] 시트 PNG 로드 실패 — 실루엣 유지:', sheetFile);
    return null;
  }
  // 픽셀 아트: 확대 시 보간 금지
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  const sheetW = texture.image?.width ?? 0;
  const sheetH = texture.image?.height ?? 0;
  if (sheetW <= 0 || sheetH <= 0) return null;

  const clips = new Map<ClipKey, SpriteClip>();
  let frameCount = 0;
  for (const key of Object.keys(CLIP_ALIASES) as ClipKey[]) {
    const entry = findClipEntry(clipSource, key);
    if (entry === null) continue;
    const rects = readFrames(entry, cellW, cellH);
    if (rects.length === 0) continue;

    const fps = (typeof entry === 'object' && entry !== null ? num((entry as Record<string, unknown>).fps) : null) ?? defaultFps;
    const frames: SpriteFrame[] = rects.map((r) => {
      // 프레임마다 offset/repeat만 다른 클론 — three.js 클론은 .source를 공유하므로 GPU 업로드는 1회
      const t = texture.clone();
      t.needsUpdate = true;
      t.repeat.set(r.w / sheetW, r.h / sheetH);
      // three.js UV 원점은 좌하단, 시트 좌표는 좌상단 기준
      t.offset.set(r.x / sheetW, 1 - (r.y + r.h) / sheetH);
      return { texture: t, aspect: r.h > 0 ? r.w / r.h : 1 };
    });
    frameCount += frames.length;
    clips.set(key, { frames, fps: Math.max(1, fps) });
  }

  if (clips.size === 0) {
    console.warn('[sprites] manifest에서 인식 가능한 클립을 찾지 못함 — 실루엣 유지');
    return null;
  }
  console.info(`[sprites] 반입 완료: ${clips.size}클립 / ${frameCount}프레임 (${sheetFile} ${sheetW}×${sheetH})`);
  return { clips, sheetFile, sheetWidth: sheetW, sheetHeight: sheetH, frameCount };
}
