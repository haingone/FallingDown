/**
 * 스프라이트 반입 자가 검증 (P1.5 §B-1·B-2·B-3).
 *
 * AD 실산출물(`art/sprites/girl`·`enemies`)이 실제로 붙는지 확인하고,
 * 미반입 폴백·형식 불일치 폴백·픽셀 스케일링·**밸런스 불변**을 함께 검증한다.
 */
import { test, expect, Page } from '@playwright/test';
import { ready } from './helpers';

/** 모든 스프라이트 요청을 404로 막아 "미반입" 상황을 재현 */
async function blockSprites(page: Page): Promise<void> {
  await page.route('**/sprites/**', (route) => route.fulfill({ status: 404, body: '' }));
}

/** 합성 시트를 특정 폴더 경로에 주입 (형식 변형 수용 검증용) */
async function serveSyntheticSheet(page: Page, folder: string, manifest: unknown): Promise<void> {
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
  await page.route('**/sprites/**', (route) => {
    const url = route.request().url();
    if (!url.includes(`/sprites/${folder}/`)) return route.fulfill({ status: 404, body: '' });
    if (url.endsWith('.json')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) });
    }
    return route.fulfill({ status: 200, contentType: 'image/png', body });
  });
}

test('AD 실산출물이 반입되어 실루엣을 대체한다', async ({ page }) => {
  await ready(page, { idle: true });
  const info = await page.evaluate(async () => {
    const fd = (window as any).__fd;
    await fd.renderer.loadSprites();
    return fd.renderer.spriteInfo();
  });
  expect(info.loaded).toBe(true);
  // girl: fall_closed·fall_open (각 3F) / enemies: a1_fly·a3_fly (각 2F)
  expect(info.keys.sort()).toEqual(['a-1', 'a-3', 'girl.folded', 'girl.open']);
  expect(info.frames).toBe(10);
  expect(info.sheets.join(' ')).toContain('girl/sprite-sheet-alpha.png 144×96');
  expect(info.sheets.join(' ')).toContain('enemies/sprite-sheet-alpha.png 64×64');
});

test('반입 스프라이트의 UV·종횡비·방향 보정이 올바르다', async ({ page }) => {
  await ready(page, { idle: true });
  const r = await page.evaluate(async () => {
    const fd = (window as any).__fd;
    await fd.renderer.loadSprites();
    const t = fd.renderer.spriteTextures;
    const folded = t.girl(false, 0);
    const open = t.girl(true, 0);
    const a1 = t.enemy('a-1', 0);
    const a4 = t.enemy('a-4', 0); // 전용 시트 없음 → 실루엣 유지
    return {
      folded: { y: folded.texture.offset.y, aspect: folded.aspect, atlas: folded.fromAtlas },
      open: { y: open.texture.offset.y, atlas: open.fromAtlas },
      a1: { facing: a1.facing, atlas: a1.fromAtlas },
      a4: { facing: a4.facing, atlas: a4.fromAtlas },
    };
  });
  // girl 시트 144×96, fall_closed = row0(y=0..48) → UV offset.y = 1 - 48/96 = 0.5
  expect(r.folded.y).toBeCloseTo(0.5, 4);
  // fall_open = row1(y=48..96) → UV offset.y = 0
  expect(r.open.y).toBeCloseTo(0, 4);
  expect(r.folded.aspect).toBeCloseTo(1, 4); // 48×48 정사각 셀
  expect(r.folded.atlas).toBe(true);
  expect(r.open.atlas).toBe(true);
  // 적 그림은 좌향 → 진행 방향 회전 보정값이 PI
  expect(r.a1.atlas).toBe(true);
  expect(r.a1.facing).toBeCloseTo(Math.PI, 4);
  // 전용 시트 없는 적은 실루엣(+Y 방향) 유지
  expect(r.a4.atlas).toBe(false);
  expect(r.a4.facing).toBeCloseTo(Math.PI / 2, 4);
});

test('다중 프레임 클립이 시간에 따라 순환한다 (소녀 낙하 루프 3F)', async ({ page }) => {
  await ready(page, { idle: true });
  const offsets = await page.evaluate(async () => {
    const fd = (window as any).__fd;
    await fd.renderer.loadSprites();
    const t = fd.renderer.spriteTextures;
    // fps 6 → 프레임당 약 0.167초, 3프레임 순환
    return [0, 0.17, 0.34, 0.51].map((sec) => t.girl(false, sec).texture.offset.x);
  });
  expect(offsets[0]).not.toBeCloseTo(offsets[1], 4);
  expect(offsets[1]).not.toBeCloseTo(offsets[2], 4);
  expect(offsets[0]).toBeCloseTo(offsets[3], 4); // 3프레임 후 처음으로
});

test('미반입 폴백: 실루엣이 유지되고 게임은 정상 동작한다', async ({ page }) => {
  await blockSprites(page);
  await ready(page, { idle: true });
  const r = await page.evaluate(async () => {
    const fd = (window as any).__fd;
    await fd.renderer.loadSprites();
    const sim = fd.sim;
    const e = sim.enemies[0];
    e.active = true; e.type = 'a-1'; e.lifecycle = 'pass'; e.phase = 'ring';
    e.hp = 1; e.entryKind = 'down'; e.lastCountedHitMs = -1e9;
    e.x = sim.girlX; e.y = sim.girlY;
    const p = sim.field.toScreen(e.x, e.y);
    const hits = sim.applySwipeSegment(0, p.y, sim.field.width, p.y, sim.time * 1000 + 1);
    sim.endSwipe(hits);
    return { info: fd.renderer.spriteInfo(), kills: sim.kills, atlas: fd.renderer.spriteTextures.girl(false, 0).fromAtlas };
  });
  expect(r.info.loaded).toBe(false);
  expect(r.atlas).toBe(false);
  expect(r.kills).toBe(1); // 실루엣만으로도 격파 성립
});

test('형식 불일치 manifest는 조용히 무시한다', async ({ page }) => {
  await serveSyntheticSheet(page, 'girl', { sheet: 'sprite-sheet-alpha.png', clips: { unknown_thing: {} } });
  await ready(page, { idle: true });
  const info = await page.evaluate(async () => {
    const fd = (window as any).__fd;
    await fd.renderer.loadSprites();
    return fd.renderer.spriteInfo();
  });
  expect(info.loaded).toBe(false); // 게임이 깨지지 않는다
});

test('row/count 축약 표기도 읽는다 (다른 산출 경로 대비)', async ({ page }) => {
  await serveSyntheticSheet(page, 'girl', {
    image: 'sprite-sheet-alpha.png',
    cellSize: 48,
    animations: {
      girl_folded: { row: 0, col: 0, count: 1 },
      girl_open: { row: 0, col: 1, count: 1 },
    },
  });
  await ready(page, { idle: true });
  const info = await page.evaluate(async () => {
    const fd = (window as any).__fd;
    await fd.renderer.loadSprites();
    return fd.renderer.spriteInfo();
  });
  expect(info.loaded).toBe(true);
  expect(info.clips).toBe(2);
  expect(info.frames).toBe(2);
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
  expect(r.bufferW).toBeLessThan(r.cssW);
  expect(r.rendering).toBe('pixelated');
  expect(Math.round(r.cssW / r.bufferW)).toBe(r.factor);
});

test('밸런스 불변: 스프라이트 반입이 히트박스·판정 수치를 바꾸지 않는다', async ({ page }) => {
  await ready(page, { idle: true });
  const r = await page.evaluate(async () => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const cfg = fd.config;

    /** 적 하나를 밴드 안 고정 위치에 두고, 중심에서 얼마나 떨어진 스와이프까지 맞는지 이분 탐색 */
    const measureHitReach = () => {
      let lo = 0, hi = 300;
      for (let iter = 0; iter < 24; iter++) {
        const mid = (lo + hi) / 2;
        sim.restart();
        const e = sim.enemies[0];
        e.active = true; e.type = 'a-1'; e.lifecycle = 'pass'; e.phase = 'ring';
        e.hp = 1; e.entryKind = 'down'; e.lastCountedHitMs = -1e9;
        e.x = sim.girlX; e.y = sim.girlY;
        const p = sim.field.toScreen(e.x, e.y);
        // 적 중심에서 세로로 mid px 떨어진 수평 스와이프
        const hits = sim.applySwipeSegment(0, p.y + mid, sim.field.width, p.y + mid, sim.time * 1000 + 1);
        if (hits > 0) lo = mid; else hi = mid;
      }
      return Number(lo.toFixed(2));
    };

    const before = measureHitReach();
    const loaded = await fd.renderer.loadSprites();
    const after = measureHitReach();
    sim.restart();
    return {
      before, after, loaded,
      hitRadiusFrac: 0.055,
      umbrellaWidth: cfg.umbrellaTrajWidthPt,
      ringRadius: cfg.ringRadiusFrac,
      bandHeight: cfg.bandHeightFrac,
    };
  });
  expect(r.loaded).toBe(true);
  // 아트만 교체 — 판정 도달 거리가 픽셀 단위로 동일해야 한다
  expect(r.after).toBeCloseTo(r.before, 2);
  // 기획서 수치도 그대로
  expect(r.umbrellaWidth).toBe(34);
  expect(r.ringRadius).toBeCloseTo(0.33, 4);
  expect(r.bandHeight).toBeCloseTo(0.66, 4);
});
