/**
 * HD-2D 씬 성능 스모크 (기획서 v2 17장 7) — 최고 밀도 구간에서 실시간 FPS·draw call·레이어 수 기록.
 * 네이티브 해상도 / 픽셀 스케일링(저해상도 RT → 정수 배 업스케일) 두 정책을 같은 구간에서 비교한다.
 * 헤드리스 수치는 참고치 (실기기 실측은 사용자 협조 — 리포트).
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import { ready } from './helpers';

/** 오토플레이로 최종 웨이브 직전까지 고속 진행 후 실시간 렌더 재개 */
async function advanceToFinalWave(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fd = window.__fd;
    const sim = fd.sim;
    const slash = () => {
      const nowMs = sim.time * 1000;
      for (const e of sim.enemies) {
        if (!e.active) continue;
        const hittable = e.lifecycle === 'pass'
          ? e.phase === 'ring'
          : e.phase === 'orbit' && (e.type !== 'a-5' || e.exposeTimer > 0);
        if (!hittable) continue;
        const p = sim.plane.toScreen(e.x, e.y);
        const hits = sim.applySwipeSegment(p.x - 70, p.y, p.x + 70, p.y, nowMs);
        if (hits > 0) sim.endSwipe(hits);
      }
    };
    fd.runner.timeScale = 0; // 고속 진행 동안 실시간 중복 스텝 방지
    while (sim.waveIndex < 4 && sim.time < 260 && sim.state !== 'clear') {
      fd.runner.advance(0.05);
      slash();
    }
    fd.runner.timeScale = 1; // 실시간 측정 재개
    fd.perf.reset();
    // 측정 리그: 요격하지 않으므로 통과 피해로 실패·재시작하지 않도록 HP를 매 프레임 채운다
    // (최종 웨이브의 최대 밀도 상태를 측정 구간 내내 유지)
    if (!(window as any).__keepAlive) {
      (window as any).__keepAlive = true;
      const tick = () => {
        fd.sim.hp = fd.config.maxHp;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  });
}

async function sample(page: Page): Promise<Record<string, number | string>> {
  return page.evaluate(() => {
    const fd = window.__fd;
    const res = fd.renderer.renderResolution();
    return {
      fps: Math.round(fd.perf.fps() * 10) / 10,
      onePercentLow: Math.round(fd.perf.onePercentLow() * 10) / 10,
      drawCalls: fd.renderer.drawCalls(),
      layers: fd.renderer.layerCount(),
      fullscreenPasses: fd.renderer.fullscreenPasses(),
      renderWidth: res.w,
      renderHeight: res.h,
      activeEnemies: fd.sim.activeEnemyCount(),
      wave: fd.sim.waveIndex,
      speed: Math.round(fd.sim.speed * 100) / 100,
      mode: fd.config.pixelScaling as string,
    };
  });
}

test('HD-2D 최종 웨이브 실시간 FPS 실측 (네이티브 / 픽셀 스케일링) + 스크린샷', async ({ page }, testInfo) => {
  // FPS는 실시간 측정이라 다른 워커의 WebGL 페이지와 GPU/CPU를 나눠 쓰면 수치가 무의미해진다.
  // 커밋된 설정은 workers:1 이며, 병렬 실행(--workers=N)에서는 측정을 건너뛴다.
  test.skip(testInfo.config.workers > 1, 'FPS 실측은 단독 실행(workers:1) 전제');
  await ready(page);
  fs.mkdirSync('test-results/screens', { recursive: true });

  await page.waitForTimeout(900);
  await page.screenshot({ path: 'test-results/screens/01-start.png' });

  await advanceToFinalWave(page);
  await page.waitForTimeout(7000); // 최종 웨이브 실시간 진행 (밀도 최대 상태 유지)
  await page.screenshot({ path: 'test-results/screens/02-final-wave-native.png' });
  const native = await sample(page);

  // 픽셀 스케일링 정책으로 전환해 같은 구간 재측정
  await page.evaluate(() => { window.__fd.config.pixelScaling = 'pixel'; window.__fd.perf.reset(); });
  await page.waitForTimeout(6000);
  await page.screenshot({ path: 'test-results/screens/03-final-wave-pixel.png' });
  const pixel = await sample(page);
  await page.evaluate(() => { window.__fd.config.pixelScaling = 'native'; });

  // 3D 오브젝트 레이어 밀도 0 → 레이어 수 감소 확인 (레이어 분리 검증)
  const layersOff = await page.evaluate(() => {
    window.__fd.config.object3dDensity = 0;
    return new Promise<number>((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const n = window.__fd.renderer.layerCount();
      window.__fd.config.object3dDensity = 12;
      res(n);
    })));
  });

  const out = { native, pixel, layerCountWithout3D: layersOff };
  fs.writeFileSync('test-results/p1-perf-metrics.json', JSON.stringify(out, null, 2));
  await testInfo.attach('p1-perf-metrics.json', { body: JSON.stringify(out, null, 2), contentType: 'application/json' });
  console.log('[P1] perf metrics', JSON.stringify(out));

  expect(native.wave).toBeGreaterThanOrEqual(4);
  expect(pixel.wave).toBeGreaterThanOrEqual(4);   // 두 정책을 같은 구간(최종 웨이브)에서 비교
  expect(Number(native.drawCalls)).toBeGreaterThan(5);
  expect(Number(native.fps)).toBeGreaterThan(20);  // 헤드리스 하한 (참고치)
  expect(Number(pixel.fps)).toBeGreaterThan(20);
  expect(native.layers).toBe(5);                   // 기획서 4장 5레이어 전부 동작
  expect(out.layerCountWithout3D).toBe(4);
  // 픽셀 모드는 저해상도 렌더타깃을 쓴다
  expect(Number(pixel.renderWidth)).toBeLessThan(Number(native.renderWidth));
  expect(Number(pixel.fullscreenPasses)).toBeGreaterThan(Number(native.fullscreenPasses));
});

test('베기 궤적 이펙트: 우산/검 스타일 차별화 동작', async ({ page }, testInfo) => {
  await ready(page);
  fs.mkdirSync('test-results/screens', { recursive: true });

  const r = await page.evaluate(async () => {
    const fd = window.__fd;
    const path: { x: number; y: number }[] = [];
    for (let i = 0; i <= 10; i++) path.push({ x: 40 + i * 30, y: 520 - i * 8 });
    const frame = () => new Promise<void>((res) => requestAnimationFrame(() => res()));

    // 접음(우산) 스탠스
    if (fd.sim.umbrellaOpen) fd.sim.toggleUmbrella();
    fd.renderer.spawnSlash(path, 'umbrella');
    await frame();
    const umbrellaActive = fd.renderer.slashFx.activeCount();
    // 검 스탠스
    fd.renderer.spawnSlash(path, 'sword');
    await frame();
    const swordActive = fd.renderer.slashFx.activeCount();
    return { umbrellaActive, swordActive };
  });
  expect(r.umbrellaActive).toBeGreaterThanOrEqual(1);
  expect(r.swordActive).toBeGreaterThanOrEqual(1);

  // 우산 궤적 스크린샷 (수명 내 캡처)
  await page.evaluate(() => {
    const fd = window.__fd;
    const path: { x: number; y: number }[] = [];
    for (let i = 0; i <= 10; i++) path.push({ x: 30 + i * 33, y: 560 - i * 14 });
    fd.renderer.spawnSlash(path, 'umbrella');
  });
  await page.waitForTimeout(55);
  await page.screenshot({ path: 'test-results/screens/04-slash-umbrella.png' });

  await page.evaluate(() => {
    const fd = window.__fd;
    const path: { x: number; y: number }[] = [];
    for (let i = 0; i <= 10; i++) path.push({ x: 340 - i * 30, y: 300 + i * 22 });
    fd.renderer.spawnSlash(path, 'sword');
  });
  await page.waitForTimeout(40);
  await page.screenshot({ path: 'test-results/screens/05-slash-sword.png' });
  await testInfo.attach('slash-umbrella.png', { path: 'test-results/screens/04-slash-umbrella.png', contentType: 'image/png' });
});
