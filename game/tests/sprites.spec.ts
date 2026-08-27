/**
 * 스프라이트 반입 체계 자가 검증 (P1.5 §B-1·§B-2).
 *
 * AD 산출물이 아직 없으므로, 테스트가 **합성 시트 + manifest를 라우트로 주입**해
 * 로더가 실루엣을 실제로 대체하는지 확인한다. 미반입 상태의 폴백도 함께 검증한다.
 */
import { test, expect, Page } from '@playwright/test';
import { ready } from './helpers';

/** 4셀(48×48) 시트를 런타임 생성해 `/sprites/*` 요청에 응답하도록 라우트를 건다 */
async function serveSyntheticSheet(page: Page, opts: { manifest?: unknown } = {}): Promise<void> {
  // 128×96 시트: (0,0) 빨강 / (48,0) 파랑 / (0,48) 초록 / (48,48) 노랑
  const png = await page.evaluate(() => {
    const cv = document.createElement('canvas');
    cv.width = 128; cv.height = 96;
    const c = cv.getContext('2d')!;
    const cells: [number, number, string][] = [
      [0, 0, '#e04040'], [48, 0, '#4060e0'], [0, 48, '#40c060'], [48, 48, '#e0c040'],
    ];
    for (const [x, y, color] of cells) {
      c.fillStyle = color;
      c.fillRect(x + 4, y + 4, 40, 40);
    }
    return cv.toDataURL('image/png');
  });
  const body = Buffer.from(png.split(',')[1], 'base64');

  const manifest = opts.manifest ?? {
    sheet: 'sprite-sheet-alpha.png',
    cellSize: 48,
    fps: 6,
    clips: {
      'girl.folded': { frames: [{ x: 0, y: 0, w: 48, h: 48 }] },
      'girl.open': { frames: [{ x: 48, y: 0, w: 48, h: 48 }] },
      'a-1': { frames: [{ x: 0, y: 48, w: 48, h: 48 }, { x: 48, y: 48, w: 48, h: 48 }], fps: 8 },
      'a-3': { frames: [{ x: 48, y: 48, w: 48, h: 48 }] },
    },
  };

  await page.route('**/sprites/manifest.json', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) }));
  await page.route('**/sprites/*.png', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body }));
}

test('미반입 상태: 실루엣 플레이스홀더가 유지되고 게임은 정상 동작한다', async ({ page }) => {
  await ready(page, { idle: true });
  const info = await page.evaluate(() => (window as any).__fd.renderer.spriteInfo());
  expect(info.loaded).toBe(false); // art/sprites/ 에 시트가 없는 현 상태
  // 실루엣만으로도 격파가 성립하는지 (점진 적용 구조의 핵심)
  const kills = await page.evaluate(() => {
    const sim = (window as any).__fd.sim;
    const e = sim.enemies[0];
    e.active = true; e.type = 'a-1'; e.lifecycle = 'pass'; e.phase = 'ring';
    e.hp = 1; e.entryKind = 'down'; e.lastCountedHitMs = -1e9;
    e.x = sim.girlX; e.y = sim.girlY;
    const p = sim.field.toScreen(e.x, e.y);
    const hits = sim.applySwipeSegment(0, p.y, sim.field.width, p.y, sim.time * 1000 + 1);
    sim.endSwipe(hits);
    return sim.kills;
  });
  expect(kills).toBe(1);
});

test('시트 반입: manifest를 읽어 실루엣을 대체한다', async ({ page }) => {
  await serveSyntheticSheet(page);
  await ready(page, { idle: true });

  const info = await page.evaluate(async () => {
    const fd = (window as any).__fd;
    await fd.renderer.loadSprites();
    return fd.renderer.spriteInfo();
  });
  expect(info.loaded).toBe(true);
  expect(info.clips).toBe(4);       // girl.folded / girl.open / a-1 / a-3
  expect(info.frames).toBe(5);      // a-1 이 2프레임
  expect(info.size).toBe('128×96');

  // 소녀 스탠스가 서로 다른 텍스처(=다른 UV 오프셋)를 쓰는지
  const uv = await page.evaluate(() => {
    const t = (window as any).__fd.renderer.spriteTextures;
    const folded = t.girl(false, 0);
    const open = t.girl(true, 0);
    return {
      folded: { x: folded.texture.offset.x, y: folded.texture.offset.y, aspect: folded.aspect },
      open: { x: open.texture.offset.x, y: open.texture.offset.y, aspect: open.aspect },
    };
  });
  expect(uv.folded.x).toBeCloseTo(0, 4);
  expect(uv.open.x).toBeCloseTo(48 / 128, 4);   // 두 번째 셀
  expect(uv.folded.y).toBeCloseTo(1 - 48 / 96, 4); // 좌상단 원점 → UV 변환
  expect(uv.folded.aspect).toBeCloseTo(1, 4);   // 48×48 정사각 셀
});

test('시트 반입: 다중 프레임 클립이 시간에 따라 순환한다', async ({ page }) => {
  await serveSyntheticSheet(page);
  await ready(page, { idle: true });
  const frames = await page.evaluate(async () => {
    const fd = (window as any).__fd;
    await fd.renderer.loadSprites();
    const t = fd.renderer.spriteTextures;
    // a-1 은 fps 8 → 0.125초마다 프레임 교체
    return [0, 0.13, 0.26].map((sec) => t.enemy('a-1', sec).texture.offset.x);
  });
  expect(frames[0]).not.toBeCloseTo(frames[1], 4); // 프레임 전환 발생
  expect(frames[0]).toBeCloseTo(frames[2], 4);     // 2프레임 순환
});

test('시트 반입: 인식 불가 manifest는 조용히 무시하고 실루엣을 유지한다', async ({ page }) => {
  await serveSyntheticSheet(page, { manifest: { sheet: 'sprite-sheet-alpha.png', clips: { unknown_thing: {} } } });
  await ready(page, { idle: true });
  const info = await page.evaluate(async () => {
    const fd = (window as any).__fd;
    await fd.renderer.loadSprites();
    return fd.renderer.spriteInfo();
  });
  expect(info.loaded).toBe(false); // 실루엣 유지 — 게임이 깨지지 않는다
});

test('시트 반입: row/count 축약 표기도 읽는다', async ({ page }) => {
  await serveSyntheticSheet(page, {
    manifest: {
      image: 'sprite-sheet-alpha.png',
      cellSize: 48,
      animations: {
        girl_folded: { row: 0, col: 0, count: 1 },
        girl_open: { row: 0, col: 1, count: 1 },
        a1: { row: 1, col: 0, count: 2 },
      },
    },
  });
  await ready(page, { idle: true });
  const info = await page.evaluate(async () => {
    const fd = (window as any).__fd;
    await fd.renderer.loadSprites();
    return fd.renderer.spriteInfo();
  });
  expect(info.loaded).toBe(true);
  expect(info.clips).toBe(3);
  expect(info.frames).toBe(4);
});

test('§B-2 픽셀 스케일링이 기본 ON이다', async ({ page }) => {
  await ready(page, { idle: true });
  const r = await page.evaluate(() => {
    const c = document.getElementById('game-canvas') as HTMLCanvasElement;
    return {
      mode: (window as any).__fd.config.pixelScaleMode,
      factor: (window as any).__fd.config.pixelScaleFactor,
      bufferW: c.width,
      cssW: c.clientWidth,
      rendering: getComputedStyle(c).imageRendering,
    };
  });
  expect(r.mode).toBe('pixel');
  expect(r.bufferW).toBeLessThan(r.cssW);      // 저해상도 렌더타깃
  expect(r.rendering).toBe('pixelated');       // 정수 배 확대 질감
  expect(Math.round(r.cssW / r.bufferW)).toBe(r.factor);
});
