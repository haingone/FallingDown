/** 튜닝 패널·HUD·베기 궤적 자가 검증 */
import { test, expect } from '@playwright/test';
import { ready } from './helpers';

test('튜닝 패널: 슬라이더 조정이 새로고침 없이 config에 반영', async ({ page }) => {
  await ready(page, { idle: true });
  await page.locator('#panel-toggle').dispatchEvent('pointerdown');
  await expect(page.locator('#panel-body')).toBeVisible();

  const before = await page.evaluate(() => (window as any).__fd.config.tapMaxDistancePt);
  expect(before).toBe(24);
  await page.locator('#panel-body input[type=range]').first().fill('40');
  expect(await page.evaluate(() => (window as any).__fd.config.tapMaxDistancePt)).toBe(40);

  await page.locator('#panel-body button', { hasText: '기본값 복원' }).dispatchEvent('pointerdown');
  expect(await page.evaluate(() => (window as any).__fd.config.tapMaxDistancePt)).toBe(24);

  await expect(page.locator('#panel-stats')).toContainText('FPS');
  await expect(page.locator('#panel-stats')).toContainText('오분류 의심');
  await expect(page.locator('#panel-stats')).toContainText('게이지 배율');
});

test('튜닝 패널: HD-2D 신규 항목(링 반경·선회·게이지 A/B·픽셀 스케일)이 동작', async ({ page }) => {
  await ready(page, { idle: true });
  await page.locator('#panel-toggle').dispatchEvent('pointerdown');

  // 링 반경 — 화면 폭 비율 (판정 영역 A안)
  const ringSlider = page.locator('.panel-row', { hasText: 'A: 링 반경' }).locator('input[type=range]');
  await ringSlider.fill('0.45');
  expect(await page.evaluate(() => (window as any).__fd.config.ringRadiusFrac)).toBeCloseTo(0.45, 3);

  // 체류형 배치각 — 혼잡도 손잡이
  const spreadSlider = page.locator('.panel-row', { hasText: '배치각 분산' }).locator('input[type=range]');
  await spreadSlider.fill('180');
  expect(await page.evaluate(() => (window as any).__fd.config.orbitSpreadDeg)).toBe(180);

  // 게이지 배율 A/B 토글 (기본 OFF)
  expect(await page.evaluate(() => (window as any).__fd.config.gaugeMultiplierEnabled)).toBe(false);
  await page.locator('.panel-row', { hasText: '게이지에 배율 적용' }).locator('input.panel-check').check();
  expect(await page.evaluate(() => (window as any).__fd.config.gaugeMultiplierEnabled)).toBe(true);

  // 픽셀 스케일링 정책 전환 → 렌더 버퍼가 실제로 축소된다
  await page.locator('.panel-row', { hasText: '픽셀 스케일링' }).locator('select').selectOption('pixel');
  await page.waitForTimeout(200);
  const buf = await page.evaluate(() => {
    const c = document.getElementById('game-canvas') as HTMLCanvasElement;
    return { w: c.width, cssW: c.clientWidth, rendering: getComputedStyle(c).imageRendering };
  });
  expect(buf.w).toBeLessThan(buf.cssW);
  expect(buf.rendering).toBe('pixelated');
});

test('HUD 골격: HP 5칸 / 배율 / 게이지 버튼, 도약 버튼 탭 동작', async ({ page }) => {
  await ready(page, { idle: true });
  await expect(page.locator('#hud-hp .hp')).toHaveCount(5);
  await expect(page.locator('#hud-mult')).toContainText('x');
  await expect(page.locator('#hud-gauge')).toBeVisible();

  await page.evaluate(() => { (window as any).__fd.sim.gauge = 1; });
  await page.locator('#hud-gauge').dispatchEvent('pointerdown');
  expect(await page.evaluate(() => (window as any).__fd.sim.diveActive)).toBe(true);
});

test('베기 궤적: 스와이프 시 궤적 이펙트가 생성되고 스탠스별로 구분된다', async ({ page }) => {
  await ready(page, { idle: true });

  const swipe = async (fromX: number, dir: number) => {
    await page.mouse.move(fromX, 560);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) {
      await page.mouse.move(fromX + dir * i * 30, 560 - i * 24);
      await page.waitForTimeout(10);
    }
    await page.mouse.up();
  };

  // 잔광을 길게 두어 스와이프 직후 궤적이 살아있는지 확실히 관측한다
  await page.evaluate(() => { (window as any).__fd.config.slashLifeSec = 3; });

  // 접음(우산) 스탠스
  expect(await page.evaluate(() => (window as any).__fd.sim.umbrellaOpen)).toBe(false);
  await swipe(70, 1);
  const umbrellaTrails = await page.evaluate(() => (window as any).__fd.renderer.slashActiveCount());
  expect(umbrellaTrails).toBeGreaterThan(0); // 궤적 이펙트가 실제로 생성됨

  // 탭으로 펼침(검) 전환 후 스와이프
  await page.mouse.move(195, 640);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(80);
  expect(await page.evaluate(() => (window as any).__fd.sim.umbrellaOpen)).toBe(true);
  expect(await page.evaluate(() => (window as any).__fd.sim.stance)).toBe('sword');
  await swipe(320, -1);
  expect(await page.evaluate(() => (window as any).__fd.renderer.slashActiveCount())).toBeGreaterThan(0);

  // 궤적 판정 폭이 스탠스에 따라 실제로 다른지 (기획서 v2 5장 2스탠스)
  const widths = await page.evaluate(() => ({
    umbrella: (window as any).__fd.config.umbrellaTrajWidthPt,
    sword: (window as any).__fd.config.swordTrajWidthPt,
  }));
  expect(widths.umbrella).toBeGreaterThan(widths.sword);
});

test('?debug=0 으로 패널 숨김', async ({ page }) => {
  await page.goto('/?debug=0');
  await page.waitForFunction(() => (window as any).__fd !== undefined);
  await expect(page.locator('#panel')).toBeHidden();
});
