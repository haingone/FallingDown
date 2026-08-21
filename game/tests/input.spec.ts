/**
 * 입력 분류 자가 검증 — 실제 포인터 이벤트 경로 + 합성 제스처 대량 주입 오분류율 실측.
 */
import { test, expect, Page } from '@playwright/test';

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__fd !== undefined);
  // 첫 렌더/셰이더 컴파일로 메인 스레드가 바쁘면 이벤트 지연으로 탭 시간이 왜곡됨 — 안정화 대기
  await page.waitForTimeout(800);
}

test('실제 포인터: 짧은 탭 → 우산 토글', async ({ page }) => {
  await ready(page);
  const before = await page.evaluate(() => (window as any).__fd.sim.umbrellaOpen);
  const cx = 195, cy = 500;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(50);
  const rec = await page.evaluate(() => {
    const c = (window as any).__fd.classifier;
    return c.records[c.records.length - 1];
  });
  expect(rec.kind).toBe('tap');
  const after = await page.evaluate(() => (window as any).__fd.sim.umbrellaOpen);
  expect(after).toBe(!before);
});

test('실제 포인터: 긴 드래그 → 스와이프 분류', async ({ page }) => {
  await ready(page);
  await page.mouse.move(80, 500);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(80 + i * 20, 500 - i * 5);
    await page.waitForTimeout(12);
  }
  await page.mouse.up();
  await page.waitForTimeout(50);
  const rec = await page.evaluate(() => {
    const c = (window as any).__fd.classifier;
    return c.records[c.records.length - 1];
  });
  expect(rec.kind).toBe('swipe');
  expect(rec.distancePt).toBeGreaterThanOrEqual(24);
});

test('실제 포인터: 미세 이동 장시간 홀드 → 무효(none) 분류', async ({ page }) => {
  await ready(page);
  await page.mouse.move(195, 500);
  await page.mouse.down();
  await page.waitForTimeout(320);
  await page.mouse.up();
  await page.waitForTimeout(50);
  const rec = await page.evaluate(() => {
    const c = (window as any).__fd.classifier;
    return c.records[c.records.length - 1];
  });
  expect(rec.kind).toBe('none');
});

test('합성 제스처 400건 오분류율 실측 (목표 3% 이하)', async ({ page }, testInfo) => {
  await ready(page);
  const result = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const c = fd.makeClassifier();
    // 시드 고정 RNG (재현성)
    let s = 12345;
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };

    // 인간형 탭 모델: 접촉 40~180ms, 미세 떨림 0~12pt 드리프트, 이벤트 주기 ~16ms
    const makeTap = () => {
      const dur = 40 + rnd() * 140;
      const drift = rnd() * 12;
      const ang = rnd() * Math.PI * 2;
      const steps = Math.max(1, Math.floor(dur / 16));
      const pts = [{ x: 200, y: 400, t: 0 }];
      for (let i = 1; i <= steps; i++) {
        const p = i / steps;
        pts.push({
          x: 200 + Math.cos(ang) * drift * p + (rnd() - 0.5) * 2,
          y: 400 + Math.sin(ang) * drift * p + (rnd() - 0.5) * 2,
          t: p * dur,
        });
      }
      return pts;
    };
    // 인간형 스와이프 모델: 길이 40~240pt, 시간 70~280ms, 완만한 곡률
    const makeSwipe = () => {
      const len = 40 + rnd() * 200;
      const dur = 70 + rnd() * 210;
      const ang = rnd() * Math.PI * 2;
      const curve = (rnd() - 0.5) * 0.6;
      const steps = Math.max(2, Math.floor(dur / 16));
      const pts: { x: number; y: number; t: number }[] = [];
      for (let i = 0; i <= steps; i++) {
        const p = i / steps;
        const a = ang + curve * p;
        pts.push({ x: 200 + Math.cos(a) * len * p, y: 400 + Math.sin(a) * len * p, t: p * dur });
      }
      return pts;
    };

    const run = (pts: { x: number; y: number; t: number }[]) => {
      c.begin(pts[0].x, pts[0].y, pts[0].t);
      for (let i = 1; i < pts.length - 1; i++) c.move(pts[i].x, pts[i].y, pts[i].t);
      const last = pts[pts.length - 1];
      return c.end(last.x, last.y, last.t);
    };

    let tapAsSwipe = 0, tapAsNone = 0, swipeAsTap = 0, swipeAsNone = 0;
    const N = 200;
    for (let i = 0; i < N; i++) {
      const r = run(makeTap());
      if (r.kind === 'swipe') tapAsSwipe++;
      else if (r.kind === 'none') tapAsNone++;
    }
    for (let i = 0; i < N; i++) {
      const r = run(makeSwipe());
      if (r.kind === 'tap') swipeAsTap++;
      else if (r.kind === 'none') swipeAsNone++;
    }
    return { N, tapAsSwipe, tapAsNone, swipeAsTap, swipeAsNone };
  });

  const total = result.N * 2;
  const errors = result.tapAsSwipe + result.tapAsNone + result.swipeAsTap + result.swipeAsNone;
  const rate = (errors / total) * 100;
  await testInfo.attach('misclassification.json', {
    body: JSON.stringify({ ...result, total, errors, ratePct: rate }, null, 2),
    contentType: 'application/json',
  });
  console.log(`[M1] 오분류율: ${rate.toFixed(2)}% (${errors}/${total})`, JSON.stringify(result));
  expect(rate).toBeLessThanOrEqual(3);
});
