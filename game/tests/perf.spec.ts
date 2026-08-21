/**
 * 성능 스모크 — 최고 밀도(최종 웨이브) 구간에서 실시간 렌더링 FPS·draw call 기록.
 * 헤드리스 수치는 참고치 (실기기 실측은 사용자 협조로 별도 — 지시문).
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__fd !== undefined);
}

test('최종 웨이브 실시간 FPS 실측 + 스크린샷', async ({ page }, testInfo) => {
  await ready(page);
  fs.mkdirSync('test-results/screens', { recursive: true });

  // 초기 화면 스크린샷
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/screens/01-start.png' });

  // 오토플레이로 최종 웨이브(index 4) 직전까지 고속 진행
  await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const slash = () => {
      const nowMs = sim.time * 1000;
      for (const e of sim.enemies) {
        if (!e.active) continue;
        const hittable = e.lifecycle === 'pass'
          ? e.phase === 'ring'
          : e.phase === 'orbit' && (e.type !== 'a-5' || e.exposeTimer > 0);
        if (!hittable) continue;
        const p = sim.projector.project(e.x - sim.girlX, e.y - sim.girlY, e.z - sim.girlZ);
        if (!p) continue;
        const hits = sim.applySwipeSegment(p.x - 70, p.y, p.x + 70, p.y, nowMs);
        if (hits > 0) sim.endSwipe(hits);
      }
    };
    fd.runner.timeScale = 0; // 고속 진행 동안 실시간 중복 스텝 방지
    while (sim.waveIndex < 4 && sim.time < 150 && sim.state !== 'clear') {
      fd.runner.advance(0.05);
      slash();
    }
    fd.runner.timeScale = 1; // 실시간 측정 재개
    fd.perf.reset();
  });

  // 최종 웨이브 실시간 진행 (요격 없이 밀도 최대 상태 유지) — 8초 측정
  await page.waitForTimeout(8000);
  await page.screenshot({ path: 'test-results/screens/02-final-wave.png' });

  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    return {
      fps: fd.perf.fps(),
      onePercentLow: fd.perf.onePercentLow(),
      drawCalls: fd.renderer.drawCalls(),
      activeEnemies: fd.sim.activeEnemyCount(),
      wave: fd.sim.waveIndex,
      speed: fd.sim.speed,
    };
  });

  fs.writeFileSync('test-results/m1-perf-metrics.json', JSON.stringify(r, null, 2));
  await testInfo.attach('m1-perf-metrics.json', { body: JSON.stringify(r, null, 2), contentType: 'application/json' });
  console.log('[M1] perf metrics', JSON.stringify(r));

  expect(r.wave).toBeGreaterThanOrEqual(4);
  expect(r.fps).toBeGreaterThan(20); // 헤드리스 하한 (참고치)
});
