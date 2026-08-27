/**
 * 손맛 주스 자가 검증 (r3-2) — 격파 피드백 7항목이 실제로 발동하고,
 * 항목별로 끌 수 있으며, 다중 격파에서 과부하 방지 장치가 동작하는지.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { ready } from './helpers';

interface JuiceSample {
  particles: number;
  punch: number;
  band: number;
  multTransform: string;
  kills: number;
}

/**
 * 판정 영역 안에 적을 강제 배치하고 실제 판정 API로 그어 격파시킨 뒤,
 * **바로 다음 렌더 프레임에서** 연출 상태를 표본한다.
 */
async function killAndSample(page: import('@playwright/test').Page, count: number): Promise<JuiceSample> {
  return page.evaluate(async (n) => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const pool = sim.enemies.filter((e: any) => !e.active).slice(0, n);
    let i = 0;
    for (const e of pool) {
      e.active = true;
      e.type = 'a-1';
      e.lifecycle = 'pass';
      e.phase = 'ring';
      e.hp = 1;
      e.entryKind = 'down';
      e.lastCountedHitMs = -1e9;
      e.x = sim.girlX + (i - (n - 1) / 2) * 0.06;
      e.y = sim.girlY;
      e.prevX = e.x; e.prevY = e.y;
      i++;
    }
    // 적들을 관통하는 수평 스와이프 (실제 판정 경로)
    const p = sim.field.toScreen(sim.girlX, sim.girlY);
    const hits = sim.applySwipeSegment(0, p.y, sim.field.width, p.y, sim.time * 1000 + 1);
    sim.endSwipe(hits);

    // 메인 루프의 rAF 콜백은 이미 등록돼 있으므로, 여기서 등록한 콜백은 그 다음에 실행된다
    // → 한 프레임만 기다리면 drainEvents → render → hud.update 가 한 번씩 돈 상태가 된다.
    await new Promise<void>(r => requestAnimationFrame(() => r()));

    return {
      particles: fd.renderer.activeParticles(),
      punch: fd.renderer.punchAmount(),
      band: fd.renderer.bandFlashAmount(),
      multTransform: (document.getElementById('hud-mult') as HTMLElement).style.transform,
      kills: sim.kills,
    };
  }, count);
}

test('r3 주스 기본값이 지시문 규격대로다', async ({ page }) => {
  await ready(page, { idle: true });
  const c = await page.evaluate(() => {
    const cfg = (window as any).__fd.config;
    return {
      cameraPunch: cfg.cameraPunch, cameraPunchMs: cfg.cameraPunchMs,
      hitstopMs: cfg.hitstopMs, hitstopMultiMaxMs: cfg.hitstopMultiMaxMs,
      bandFlashMs: cfg.bandFlashMs, deathPopMs: cfg.deathPopMs,
    };
  });
  expect(c.cameraPunch).toBeGreaterThanOrEqual(0.015); // 지시문: 1.5~2% 줌킥
  expect(c.cameraPunch).toBeLessThanOrEqual(0.02);
  expect(c.cameraPunchMs).toBeGreaterThanOrEqual(60);  // 지시문: 60~80ms 복귀
  expect(c.cameraPunchMs).toBeLessThanOrEqual(80);
  expect(c.hitstopMs).toBe(40);                        // 지시문: 40ms 기본 유지
  expect(c.hitstopMultiMaxMs).toBe(60);                // 지시문: 다중 격파 60ms 상한
});

test('격파 시 파편·플래시·카메라 펀치·밴드 플래시·UI 펄스가 발동한다', async ({ page }) => {
  await ready(page, { idle: true });
  // 펀치 70ms·밴드 플래시 120ms는 헤드리스 프레임(~30fps) 한두 번이면 사라진다.
  // 여기서 검증하려는 것은 "격파가 각 연출을 발동시키는가"이지 감쇠 타이밍이 아니므로
  // 지속만 늘려 관측한다 (기본값 자체는 위 테스트에서 별도 검증).
  await page.evaluate(() => {
    const cfg = (window as any).__fd.config;
    cfg.cameraPunchMs = 600;
    cfg.bandFlashMs = 600;
  });
  const before = await page.evaluate(() => ({
    particles: (window as any).__fd.renderer.activeParticles(),
    punch: (window as any).__fd.renderer.punchAmount(),
    band: (window as any).__fd.renderer.bandFlashAmount(),
  }));
  expect(before.particles).toBe(0);

  const after = await killAndSample(page, 3);

  expect(after.kills).toBe(3);
  expect(after.particles).toBeGreaterThan(0);   // ① 파편 버스트
  expect(after.punch).toBeGreaterThan(0);       // ③ 카메라 펀치
  expect(after.band).toBeGreaterThan(0);        // ⑤ 밴드 히트 플래시
  expect(after.multTransform).toMatch(/scale\(1\.[0-9]/); // ⑥ 배율 UI 펄스
});

test('주스 항목별로 끌 수 있다 (0 = 완전 비활성)', async ({ page }) => {
  await ready(page, { idle: true });
  await page.evaluate(() => {
    const c = (window as any).__fd.config;
    c.burstDebrisCount = 0;
    c.burstSparkCount = 0;
    c.cameraPunch = 0;
    c.bandFlashStrength = 0;
    c.uiPulseStrength = 0;
  });
  const after = await killAndSample(page, 3);
  expect(after.kills).toBe(3);   // 격파 자체는 정상
  expect(after.particles).toBe(0);
  expect(after.punch).toBe(0);
  expect(after.band).toBe(0);
  expect(after.multTransform).toBe('scale(1)');
});

test('다중 격파 과부하 방지: 파편 총량이 상한을 넘지 않는다', async ({ page }, testInfo) => {
  await ready(page, { idle: true });
  await page.evaluate(() => {
    const c = (window as any).__fd.config;
    c.particleBudget = 80;      // 상한을 낮춰 검증
    c.burstDebrisCount = 30;    // 상한보다 훨씬 많이 뿜도록
    c.burstSparkCount = 15;
    c.burstLifeSec = 1.2;       // 오래 살려 누적시킨다
  });

  // 편대 규모 격파를 연속 3회
  let last = await killAndSample(page, 8);
  for (let i = 0; i < 2; i++) last = await killAndSample(page, 8);

  const r = {
    particles: last.particles,
    budget: await page.evaluate(() => (window as any).__fd.config.particleBudget),
    kills: last.kills,
  };
  await testInfo.attach('particle-budget.json', { body: JSON.stringify(r, null, 2), contentType: 'application/json' });
  console.log('[P1] 파편 총량 상한', JSON.stringify(r));
  expect(r.kills).toBe(24);
  // 파편·스파크 두 버퍼 합계가 총량 상한 안에서 묶여야 한다 (오래된 것부터 링 버퍼로 덮어씀)
  expect(r.particles).toBeLessThanOrEqual(r.budget);
});

test('⑦ 다중 격파 히트스톱 연장이 규칙대로 동작한다', async ({ page }, testInfo) => {
  await ready(page, { idle: true });
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const cfg = fd.config;
    fd.runner.timeScale = 0;

    /** n기를 한 번에 격파한 뒤, 0.3초를 흘려보내며 실제로 멈춘 시간을 잰다 */
    const measure = (n: number, multiEnabled: boolean) => {
      cfg.hitstopMultiEnabled = multiEnabled;
      sim.restart();
      const pool = sim.enemies.filter((e: any) => !e.active).slice(0, n);
      let i = 0;
      for (const e of pool) {
        e.active = true; e.type = 'a-1'; e.lifecycle = 'pass'; e.phase = 'ring';
        e.hp = 1; e.entryKind = 'down'; e.lastCountedHitMs = -1e9;
        e.x = sim.girlX + (i - (n - 1) / 2) * 0.06;
        e.y = sim.girlY;
        i++;
      }
      const p = sim.field.toScreen(sim.girlX, sim.girlY);
      const hits = sim.applySwipeSegment(0, p.y, sim.field.width, p.y, sim.time * 1000 + 1);
      sim.endSwipe(hits);
      sim.events.length = 0;

      const t0 = sim.time;
      const WALL = 0.3;
      fd.runner.advance(WALL);
      // 히트스톱 동안 sim.time이 멈추므로, 흐르지 않은 만큼이 히트스톱
      return Number((((WALL - (sim.time - t0))) * 1000).toFixed(1));
    };

    const single = measure(1, true);
    const multiOn = measure(6, true);
    const multiOff = measure(6, false);
    cfg.hitstopMultiEnabled = true;
    return { single, multiOn, multiOff, base: cfg.hitstopMs, cap: cfg.hitstopMultiMaxMs };
  });

  await testInfo.attach('hitstop.json', { body: JSON.stringify(r, null, 2), contentType: 'application/json' });
  console.log('[P1] 히트스톱', JSON.stringify(r));
  // 단일 격파 = 기본값 40ms
  expect(r.single).toBeGreaterThanOrEqual(r.base - 10);
  expect(r.single).toBeLessThanOrEqual(r.base + 10);
  // 다중 격파는 연장되지만 상한을 넘지 않는다
  expect(r.multiOn).toBeGreaterThan(r.single);
  expect(r.multiOn).toBeLessThanOrEqual(r.cap + 10);
  // 옵션을 끄면 다중 격파도 기본값
  expect(r.multiOff).toBeLessThanOrEqual(r.base + 10);
});

test('격파음: 동시발음 제한과 피치 스택이 설정된다', async ({ page }) => {
  await ready(page, { idle: true });
  const cfg = await page.evaluate(() => {
    const c = (window as any).__fd.config;
    return { gain: c.killSoundGain, stack: c.killPitchStackMax, voices: c.soundVoiceLimit };
  });
  expect(cfg.gain).toBeGreaterThan(0);
  expect(cfg.stack).toBeGreaterThan(0);
  expect(cfg.voices).toBeGreaterThanOrEqual(1);
  // 헤드리스에서는 AudioContext가 suspended라 실제 발음은 검증 불가 — 다중 격파가 예외 없이 처리되는지만 확인
  const s = await killAndSample(page, 8);
  expect(s.kills).toBe(8);
});

test('?stats=1 미니 오버레이가 표시된다', async ({ page }) => {
  await page.goto('/?stats=1');
  await page.waitForFunction(() => (window as any).__fd !== undefined);
  await page.waitForTimeout(600);
  const overlay = page.locator('#stats-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText('fps');
  await expect(overlay).toContainText('draw');

  // 기본(파라미터 없음)에서는 표시되지 않는다
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__fd !== undefined);
  await expect(page.locator('#stats-overlay')).toHaveCount(0);
});

test('판정 영역 기본값이 밴드로 확정되었다 (기획서 v2.2)', async ({ page }) => {
  await ready(page, { idle: true });
  expect(await page.evaluate(() => (window as any).__fd.config.judgeArea)).toBe('band');
  await page.locator('#panel-toggle').dispatchEvent('pointerdown');
  const options = await page.locator('.panel-row', { hasText: '판정 영역' }).locator('option').allTextContents();
  expect(options[0]).toContain('밴드');
  expect(options.join(' ')).toContain('폐기 예정'); // 원형은 폐기 예정 표기
});

test.afterAll(async () => {
  fs.mkdirSync('test-results', { recursive: true });
});
