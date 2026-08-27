/** 튜닝 패널·HUD 자가 검증 */
import { test, expect } from '@playwright/test';
import { ready } from './helpers';

test('튜닝 패널: 슬라이더 조정이 새로고침 없이 config에 반영', async ({ page }) => {
  await ready(page);

  await page.locator('#panel-toggle').dispatchEvent('pointerdown');
  await expect(page.locator('#panel-body')).toBeVisible();

  // 첫 슬라이더 = 탭/스와이프 거리 임계 (24pt 기본)
  const before = await page.evaluate(() => window.__fd.config.tapMaxDistancePt);
  expect(before).toBe(24);
  const slider = page.locator('#panel-body input[type=range]').first();
  await slider.fill('40');
  const after = await page.evaluate(() => window.__fd.config.tapMaxDistancePt);
  expect(after).toBe(40);

  // 기본값 복원 버튼
  await page.locator('#panel-body button', { hasText: '기본값 복원' }).dispatchEvent('pointerdown');
  const restored = await page.evaluate(() => window.__fd.config.tapMaxDistancePt);
  expect(restored).toBe(24);

  // 세션 통계 표기 존재 (P1 확장 항목 포함)
  await expect(page.locator('#panel-stats')).toContainText('FPS');
  await expect(page.locator('#panel-stats')).toContainText('오분류 의심');
  await expect(page.locator('#panel-stats')).toContainText('레이어');
  await expect(page.locator('#panel-stats')).toContainText('게이지 배율');
});

test('튜닝 패널 P1 확장: 링 반경(화면 폭 %)·게이지 A/B·픽셀 스케일링 토글', async ({ page }) => {
  await ready(page);
  await page.locator('#panel-toggle').dispatchEvent('pointerdown');

  // 링 반경 슬라이더 (화면 폭 % ↔ wu 변환)
  const ringSlider = page.locator('#panel-body label', { hasText: '판정 링 반경' }).locator('input[type=range]');
  const beforeWu = await page.evaluate(() => window.__fd.config.ringRadiusWu);
  await ringSlider.fill('50');
  const afterWu = await page.evaluate(() => window.__fd.config.ringRadiusWu);
  expect(afterWu).toBeGreaterThan(beforeWu);
  // 50% 지정 → 화면 폭 대비 반경이 실제로 50%인지 역산 확인
  const pct = await page.evaluate(() => {
    const fd = window.__fd;
    const base = fd.sim.plane.viewport.height / fd.config.worldHeightWu;
    return (fd.config.ringRadiusWu * base) / fd.sim.plane.viewport.width * 100;
  });
  expect(pct).toBeGreaterThan(49);
  expect(pct).toBeLessThan(51);

  // 게이지 배율 A/B 토글 (기본 OFF)
  const gaugeCheck = page.locator('#panel-body label', { hasText: '게이지 배율 적용' }).locator('input[type=checkbox]');
  expect(await page.evaluate(() => window.__fd.config.gaugeMultiplierEnabled)).toBe(false);
  await gaugeCheck.check();
  expect(await page.evaluate(() => window.__fd.config.gaugeMultiplierEnabled)).toBe(true);
  await gaugeCheck.uncheck();
  expect(await page.evaluate(() => window.__fd.config.gaugeMultiplierEnabled)).toBe(false);

  // 픽셀 스케일링 토글 → 렌더 해상도 감소
  const nativeRes = await page.evaluate(() => window.__fd.renderer.renderResolution());
  const pixCheck = page.locator('#panel-body label', { hasText: '픽셀 스케일링' }).locator('input[type=checkbox]');
  await pixCheck.check();
  await page.waitForTimeout(200);
  const pixelRes = await page.evaluate(() => window.__fd.renderer.renderResolution());
  expect(pixelRes.w).toBeLessThan(nativeRes.w);
  await pixCheck.uncheck();

  // 3D 오브젝트 밀도 슬라이더
  const densSlider = page.locator('#panel-body label', { hasText: '3D 오브젝트 밀도' }).locator('input[type=range]');
  await densSlider.fill('0');
  await page.waitForTimeout(120);
  expect(await page.evaluate(() => window.__fd.renderer.objects3d.activeCount())).toBe(0);
  await densSlider.fill('12');
});

test('?debug=0 으로 패널 숨김', async ({ page }) => {
  await ready(page, { url: '/?debug=0' });
  await expect(page.locator('#panel')).toBeHidden();
});

test('HUD 골격: HP 5칸 / 배율 / 게이지 버튼 존재, 도약 버튼 탭 동작', async ({ page }) => {
  await ready(page);
  await expect(page.locator('#hud-hp .hp')).toHaveCount(5);
  await expect(page.locator('#hud-mult')).toContainText('x');
  await expect(page.locator('#hud-gauge')).toBeVisible();

  // 게이지 강제 충전 후 버튼 탭 → 도약 발동
  await page.evaluate(() => { window.__fd.sim.gauge = 1; });
  await page.locator('#hud-gauge').dispatchEvent('pointerdown');
  const diving = await page.evaluate(() => window.__fd.sim.diveActive);
  expect(diving).toBe(true);
});
