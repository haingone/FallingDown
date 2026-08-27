/**
 * HD-2D 렌더 성능 스모크 + 스크린샷 — 기획서 v2 17장 7.
 * 헤드리스 수치는 참고치 (실기기 실측은 사용자 협조로 별도 — 지시문).
 * 픽셀 스케일링 정책(네이티브 vs 저해상도→정수배)도 같은 장면에서 비교한다.
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import { ready, installAutoplay } from './helpers';

/**
 * 오토플레이로 최종 웨이브(최고 밀도) 직전까지 고속 진행한 뒤 실시간 렌더로 복귀.
 * 측정 구간 내내 밀도가 유지되도록 피해를 0으로 둔다 (실패·재시작으로 장면이 비는 것 방지 — 측정 목적 한정).
 */
async function fastForwardToFinalWave(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const auto = (window as any).__auto;
    fd.config.contactDamage = 0;
    fd.runner.timeScale = 0;
    sim.restart();
    while (sim.waveIndex < 4 && sim.time < 200 && sim.state !== 'clear') {
      fd.runner.advance(0.05);
      auto.slash();
      sim.events.length = 0;
    }
    fd.runner.timeScale = 1;
    fd.perf.reset();
  });
}

async function sample(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const fd = (window as any).__fd;
    return {
      fps: Number(fd.perf.fps().toFixed(1)),
      onePercentLow: Number(fd.perf.onePercentLow().toFixed(1)),
      drawCalls: fd.renderer.drawCalls(),
      overdraw: fd.renderer.overdrawEstimate(),
      activeEnemies: fd.sim.activeEnemyCount(),
      wave: fd.sim.waveIndex,
      speed: Number(fd.sim.speed.toFixed(2)),
    };
  });
}

test('HD-2D 최종 웨이브 실시간 FPS 실측 + 픽셀 스케일링 비교', async ({ page }, testInfo) => {
  await ready(page);
  await installAutoplay(page);
  fs.mkdirSync('test-results/screens', { recursive: true });

  await page.screenshot({ path: 'test-results/screens/01-start.png' });

  // 궤적 스크린샷: 실패 배너 없는 깨끗한 장면에서, 스크린샷 왕복 지연(수백 ms) 동안
  // 궤적이 사라지지 않도록 잔광을 길게 둔 상태로 찍는다
  await page.evaluate(() => {
    const fd = (window as any).__fd;
    fd.config.slashLifeSec = 4;
    fd.sim.restart();
    fd.sim.events.length = 0;
  });

  // 베기 궤적 이펙트가 보이는 순간 캡처 (실제 포인터 드래그)
  await page.mouse.move(60, 560);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(60 + i * 34, 560 - i * 26);
    await page.waitForTimeout(10);
  }
  await page.screenshot({ path: 'test-results/screens/02-slash-umbrella.png' });
  await page.mouse.up();

  // 검 스탠스(펼침)로 토글 후 궤적 비교
  await page.mouse.move(195, 640);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(120);
  await page.mouse.move(330, 560);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await page.mouse.move(330 - i * 34, 560 - i * 26);
    await page.waitForTimeout(10);
  }
  await page.screenshot({ path: 'test-results/screens/03-slash-sword.png' });
  await page.mouse.up();
  await page.evaluate(() => { (window as any).__fd.config.slashLifeSec = 0.3; }); // 기본값 복귀

  // 최종 웨이브 = 최고 밀도 구간에서 8초 실시간 측정 (네이티브)
  await fastForwardToFinalWave(page);
  await page.waitForTimeout(8000);
  await page.screenshot({ path: 'test-results/screens/04-final-wave-native.png' });
  const native = await sample(page);

  // 픽셀 스케일링 모드로 전환해 **같은 밀도의 장면**을 재측정
  await page.evaluate(() => {
    const fd = (window as any).__fd;
    fd.config.pixelScaleMode = 'pixel';
    fd.relayout();
  });
  await fastForwardToFinalWave(page);
  await page.waitForTimeout(8000);
  await page.screenshot({ path: 'test-results/screens/05-final-wave-pixel.png' });
  const pixel = await sample(page);
  const pixelBuffer = await page.evaluate(() => {
    const c = document.getElementById('game-canvas') as HTMLCanvasElement;
    return { bufferW: c.width, bufferH: c.height, cssW: c.clientWidth, cssH: c.clientHeight };
  });

  await page.evaluate(() => {
    const fd = (window as any).__fd;
    fd.config.pixelScaleMode = 'native';
    fd.relayout();
  });

  // 판정 영역 B안(화면 밴드) 장면 캡처 — A/B 시각 비교용
  await page.evaluate(() => { (window as any).__fd.config.judgeArea = 'band'; });
  await fastForwardToFinalWave(page);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'test-results/screens/06-final-wave-band.png' });
  const band = await sample(page);
  await page.evaluate(() => {
    const fd = (window as any).__fd;
    fd.config.judgeArea = 'circle';
    fd.config.contactDamage = 1;
  });

  const out = { native, pixel, band, pixelBuffer };
  fs.writeFileSync('test-results/p1-perf-metrics.json', JSON.stringify(out, null, 2));
  await testInfo.attach('p1-perf-metrics.json', { body: JSON.stringify(out, null, 2), contentType: 'application/json' });
  console.log('[P1] perf metrics', JSON.stringify(out));

  expect(native.wave).toBeGreaterThanOrEqual(4);
  expect(native.fps).toBeGreaterThan(20); // 헤드리스 하한 (참고치)
  // 저해상도 렌더타깃이 실제로 축소 렌더되는지
  expect(pixelBuffer.bufferW).toBeLessThan(pixelBuffer.cssW);
});
