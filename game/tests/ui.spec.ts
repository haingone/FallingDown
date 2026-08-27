/** 튜닝 패널·HUD 자가 검증 */
import { test, expect } from '@playwright/test';

test('튜닝 패널: 슬라이더 조정이 새로고침 없이 config에 반영', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__fd !== undefined);

  await page.locator('#panel-toggle').dispatchEvent('pointerdown');
  await expect(page.locator('#panel-body')).toBeVisible();

  // 첫 슬라이더 = 탭/스와이프 거리 임계 (24pt 기본)
  const before = await page.evaluate(() => (window as any).__fd.config.tapMaxDistancePt);
  expect(before).toBe(24);
  const slider = page.locator('#panel-body input[type=range]').first();
  await slider.fill('40');
  const after = await page.evaluate(() => (window as any).__fd.config.tapMaxDistancePt);
  expect(after).toBe(40);

  // 기본값 복원 버튼
  await page.locator('#panel-body button', { hasText: '기본값 복원' }).dispatchEvent('pointerdown');
  const restored = await page.evaluate(() => (window as any).__fd.config.tapMaxDistancePt);
  expect(restored).toBe(24);

  // 세션 통계 표기 존재
  await expect(page.locator('#panel-stats')).toContainText('FPS');
  await expect(page.locator('#panel-stats')).toContainText('오분류 의심');
});

test('?debug=0 으로 패널 숨김', async ({ page }) => {
  await page.goto('/?debug=0');
  await page.waitForFunction(() => (window as any).__fd !== undefined);
  await expect(page.locator('#panel')).toBeHidden();
});

test('HUD 골격: HP 5칸 / 배율 / 게이지 버튼 존재, 도약 버튼 탭 동작', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__fd !== undefined);
  await expect(page.locator('#hud-hp .hp')).toHaveCount(5);
  await expect(page.locator('#hud-mult')).toContainText('x');
  await expect(page.locator('#hud-gauge')).toBeVisible();

  // 게이지 강제 충전 후 버튼 탭 → 도약 발동
  await page.evaluate(() => { (window as any).__fd.sim.gauge = 1; });
  await page.locator('#hud-gauge').dispatchEvent('pointerdown');
  const diving = await page.evaluate(() => (window as any).__fd.sim.diveActive);
  expect(diving).toBe(true);
});
