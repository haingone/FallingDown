/**
 * 판정 영역 A/B 비교 실측 — 지시문 P1 r2 개정 / HQ 검수 3장 보완 라운드.
 *
 *  A. 원형 링  (소녀 중심 원, 반경 0.33 = 지름 66%)
 *  B. 화면 밴드 (소녀 높이의 가로 밴드, 높이 0.66 = 원 지름 등가)
 *
 * 측정 설계 주의:
 *  - 본 시퀀스는 진입 각도가 랜덤이라 런마다 표본이 불균형하다 → **각도별 균등 프로브 웨이브**로 통제한다.
 *  - 무조준 스와이프 정책 하나로는 두 방식을 공정히 비교할 수 없다 (원형은 소녀 근처, 밴드는 세로로 넓은 창).
 *    → **입력 정책 3종**을 모두 돌려 정책별로 비교한다.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { ready, freezeClock } from './helpers';

/** 각도별 12기씩, 통과형만 36기 — 통제된 비교용 프로브 웨이브 */
const PROBE_WAVE = {
  waves: [{
    name: 'A/B 프로브',
    restAfterSec: 0,
    entries: Array.from({ length: 36 }, (_, i) => ({
      t: 0.5 + i * 1.1,
      type: 'a-1' as const,
      entry: (['down', 'left', 'right'] as const)[i % 3],
    })),
  }],
};

test('판정 영역 A/B: 입력 정책별 히트 성공률과 진입 각도별 대응', async ({ page }, testInfo) => {
  await ready(page);
  await freezeClock(page);

  const table = await page.evaluate((probeWave) => {
    const fd = (window as any).__fd;
    const cfg = fd.config;
    const DT = 1 / 120;

    const isLit = (e: any) => e.active && (e.lifecycle === 'pass'
      ? e.phase === 'ring'
      : e.phase === 'orbit' && (e.type !== 'a-5' || e.exposeTimer > 0));

    /**
     * 입력 정책
     *  targeted   : 판정 영역 안의 적을 개별 조준 (성공률 상한)
     *  girlRow    : 소녀 높이에서 화면을 가로지르는 수평 스와이프를 일정 간격 반복 (무조준 반사)
     *  litRow     : 불이 들어온 적의 높이에서 화면을 가로지르는 수평 스와이프 (하이라이트만 보고 반응)
     */
    const CADENCE = 0.4;
    const run = (area: 'circle' | 'band', policy: 'targeted' | 'girlRow' | 'litRow') => {
      cfg.judgeArea = area;
      cfg.contactDamage = 0; // 측정 목적: 실패·재시작으로 표본이 끊기지 않도록
      const sim = fd.makeSim(probeWave, 424242);
      let nextSwipe = 0;

      while (sim.state !== 'clear' && sim.time < 200) {
        sim.step(DT);
        const nowMs = sim.time * 1000;

        if (policy === 'targeted') {
          for (const e of sim.enemies) {
            if (!isLit(e)) continue;
            const p = sim.field.toScreen(e.x, e.y);
            const hits = sim.applySwipeSegment(p.x - 70, p.y, p.x + 70, p.y, nowMs);
            if (hits > 0) sim.endSwipe(hits);
          }
        } else if (sim.time >= nextSwipe) {
          nextSwipe = sim.time + CADENCE;
          let rowY: number | null = null;
          if (policy === 'girlRow') {
            rowY = sim.field.toScreen(0, sim.girlY).y;
          } else {
            const lit = sim.enemies.filter(isLit);
            if (lit.length > 0) {
              // 화면상 가장 위(=가장 곧 사라질) 적의 높이를 노린다
              const target = lit.reduce((a: any, b: any) => (a.y > b.y ? a : b));
              rowY = sim.field.toScreen(target.x, target.y).y;
            }
          }
          if (rowY !== null) {
            const hits = sim.applySwipeSegment(0, rowY, sim.field.width, rowY, nowMs);
            sim.endSwipe(hits);
          }
        }
        sim.events.length = 0;
      }

      const be = sim.statsByEntry;
      const tot = (k: 'spawned' | 'killed' | 'missed') => be.down[k] + be.left[k] + be.right[k];
      const pct = (n: number, d: number) => (d > 0 ? Number(((n / d) * 100).toFixed(1)) : null);
      return {
        area,
        policy,
        state: sim.state,
        spawned: tot('spawned'),
        killed: tot('killed'),
        hitRatePct: pct(tot('killed'), tot('spawned')),
        missedAreaPct: pct(tot('missed'), tot('spawned')),
        byEntry: {
          down: pct(be.down.killed, be.down.spawned),
          left: pct(be.left.killed, be.left.spawned),
          right: pct(be.right.killed, be.right.spawned),
        },
      };
    };

    const rows: any[] = [];
    for (const policy of ['targeted', 'girlRow', 'litRow'] as const) {
      for (const area of ['circle', 'band'] as const) rows.push(run(area, policy));
    }
    cfg.judgeArea = 'circle';
    cfg.contactDamage = 1;
    return rows;
  }, PROBE_WAVE);

  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/p1-judgearea-hitrate.json', JSON.stringify(table, null, 2));
  await testInfo.attach('p1-judgearea-hitrate.json', {
    body: JSON.stringify(table, null, 2),
    contentType: 'application/json',
  });
  for (const row of table) console.log('[P1] judgeArea 히트율', JSON.stringify(row));

  for (const row of table) {
    expect(row.state).toBe('clear');
    expect(row.spawned).toBe(36);
  }
  // 조준 정책에서는 두 방식 모두 상한(전멸)에 도달해야 한다 — 판정 자체의 결함이 없음을 확인
  for (const row of table.filter(r => r.policy === 'targeted')) {
    expect(row.hitRatePct).toBe(100);
  }
});

test('판정 영역 A/B: 구조적 빗나감 기하 커버리지 (HQ 질문 4 연계)', async ({ page }, testInfo) => {
  await ready(page);
  const probe = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const cfg = fd.config;
    const sim = fd.sim;
    const gx = 0, gy = sim.girlHomeY();
    const bottomY = sim.field.bottomY - cfg.spawnMargin;
    const topY = sim.field.topY + cfg.spawnMargin;

    const DIRS: Record<string, { x: number; y: number }> = {
      down: { x: 0, y: 1 },
      left: { x: Math.sin(32 * Math.PI / 180), y: Math.cos(32 * Math.PI / 180) },
      right: { x: -Math.sin(32 * Math.PI / 180), y: Math.cos(32 * Math.PI / 180) },
    };

    /**
     * **소녀 높이를 화면 폭 안에서 가로지르는** 궤적 중 판정 영역에 진입하는 비율.
     * (시작 x로 표본을 잡으면 사선 궤적은 화면 밖에서 출발해야 소녀 근처를 지나므로
     *  표본 범위가 왜곡된다 — 교차점 기준으로 파라미터화해야 두 방식을 공정히 비교할 수 있다.)
     */
    const coverage = (areaKey: 'circle' | 'band', dirKey: string) => {
      const area = fd.judge[areaKey];
      const d = DIRS[dirKey];
      const SAMPLES = 201;
      let entered = 0;
      for (let i = 0; i < SAMPLES; i++) {
        const crossX = -0.5 + i / (SAMPLES - 1); // 소녀 높이에서의 교차점 (화면 좌단 ~ 우단)
        // 교차점에서 진행 방향의 반대로 화면 아래까지 역산한 지점이 출발점
        const back = (gy - bottomY) / d.y;
        let x = crossX - d.x * back;
        let y = bottomY;
        let hit = false;
        while (y < topY) {
          if (area.contains(x, y, gx, gy)) { hit = true; break; }
          x += d.x * 0.004;
          y += d.y * 0.004;
        }
        if (hit) entered++;
      }
      return Number(((entered / SAMPLES) * 100).toFixed(1));
    };

    const out: any = { ringRadiusFrac: cfg.ringRadiusFrac, bandHeightFrac: cfg.bandHeightFrac, circle: {}, band: {} };
    for (const dirKey of Object.keys(DIRS)) {
      out.circle[dirKey] = coverage('circle', dirKey);
      out.band[dirKey] = coverage('band', dirKey);
    }
    return out;
  });

  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/p1-judgearea-coverage.json', JSON.stringify(probe, null, 2));
  await testInfo.attach('p1-judgearea-coverage.json', {
    body: JSON.stringify(probe, null, 2),
    contentType: 'application/json',
  });
  console.log('[P1] judgeArea 커버리지', JSON.stringify(probe));

  // 밴드는 상방 이동 궤적을 100% 포착 — 빗나감이 구조적으로 불가능
  for (const dir of ['down', 'left', 'right']) {
    expect(probe.band[dir]).toBe(100);
    expect(probe.circle[dir]).toBeLessThan(100); // 원형은 화면 좌우로 치우친 궤적을 놓친다
    expect(probe.circle[dir]).toBeGreaterThan(0);
  }
});

test('판정 영역 A/B: 시각 혼잡도 (본 90초 시퀀스)', async ({ page }, testInfo) => {
  await ready(page);
  await freezeClock(page);
  const rows = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const cfg = fd.config;
    const isLit = (e: any) => e.active && (e.lifecycle === 'pass'
      ? e.phase === 'ring'
      : e.phase === 'orbit' && (e.type !== 'a-5' || e.exposeTimer > 0));

    const run = (area: 'circle' | 'band') => {
      cfg.judgeArea = area;
      cfg.contactDamage = 0;
      sim.restart();
      let sum = 0, samples = 0, max = 0;
      let ySpreadSum = 0, xSpreadSum = 0, spreadSamples = 0;
      let maxYSpread = 0, maxXSpread = 0, maxAbsX = 0;
      while (sim.state !== 'clear' && sim.time < 200) {
        fd.runner.advance(0.05);
        // 혼잡도는 "화면에 동시에 불이 들어오는 적 수"라는 장면의 성질이므로 통과형은 베지 않는다.
        // (조준 오토플레이는 불이 켜지는 즉시 처치해 표본을 비워 버린다.)
        // 웨이브 진행을 위해 체류형만 처치한다.
        const nowMs = sim.time * 1000;
        for (const e of sim.enemies) {
          if (!isLit(e) || e.lifecycle !== 'stay') continue;
          const p = sim.field.toScreen(e.x, e.y);
          const hits = sim.applySwipeSegment(p.x - 70, p.y, p.x + 70, p.y, nowMs);
          if (hits > 0) sim.endSwipe(hits);
        }
        sim.events.length = 0;
        const lit = sim.enemies.filter(isLit);
        sum += lit.length; samples++; max = Math.max(max, lit.length);
        for (const e of lit) maxAbsX = Math.max(maxAbsX, Math.abs(e.x - sim.girlX));
        if (lit.length >= 2) {
          const sd = (vals: number[]) => {
            const m = vals.reduce((s, v) => s + v, 0) / vals.length;
            return Math.sqrt(vals.reduce((s, v) => s + (v - m) ** 2, 0) / vals.length);
          };
          const ys = sd(lit.map((e: any) => e.y));
          const xs = sd(lit.map((e: any) => e.x));
          ySpreadSum += ys; xSpreadSum += xs; spreadSamples++;
          maxYSpread = Math.max(maxYSpread, ys);
          maxXSpread = Math.max(maxXSpread, xs);
        }
      }
      const avg = (v: number) => (spreadSamples > 0 ? Number((v / spreadSamples).toFixed(3)) : null);
      return {
        area,
        clearTime: Number(sim.time.toFixed(1)),
        meanLit: Number((sum / Math.max(1, samples)).toFixed(3)),
        maxLit: max,
        spreadSamples,
        /** 동시 점등 적들의 세로/가로 분산 — 판정 영역 형태가 "어디에 불이 켜지는가"를 바꾼다 */
        meanYSpread: avg(ySpreadSum),
        maxYSpread: Number(maxYSpread.toFixed(3)),
        meanXSpread: avg(xSpreadSum),
        maxXSpread: Number(maxXSpread.toFixed(3)),
        /** 점등 적이 소녀로부터 가로로 얼마나 멀어질 수 있는가 (밴드는 화면 끝까지 가능) */
        maxAbsXFromGirl: Number(maxAbsX.toFixed(3)),
      };
    };
    const out = [run('circle'), run('band')];
    cfg.judgeArea = 'circle';
    cfg.contactDamage = 1;
    return out;
  });

  fs.writeFileSync('test-results/p1-judgearea-congestion.json', JSON.stringify(rows, null, 2));
  await testInfo.attach('p1-judgearea-congestion.json', {
    body: JSON.stringify(rows, null, 2),
    contentType: 'application/json',
  });
  for (const r of rows) console.log('[P1] judgeArea 혼잡도', JSON.stringify(r));
  for (const r of rows) expect(r.maxLit).toBeGreaterThan(0);
});

test('밴드 방식에서도 링 체류 시간 규칙이 유지된다 (0.8s@1.0x / 0.3s@3.0x)', async ({ page }, testInfo) => {
  await ready(page);
  await freezeClock(page);
  const measure = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const cfg = fd.config;
    cfg.judgeArea = 'band';

    const measureAt = (speed: number) => {
      cfg.accelPerSec = 0;
      cfg.decelPerSec = 0;
      sim.restart();
      sim.speed = speed;
      const dt = 1 / 240;
      const dwells: number[] = [];
      const enter = new Map<number, number>();
      let t = 0;
      while (t < 60 && dwells.length < 6) {
        sim.step(dt);
        sim.speed = speed;
        t += dt;
        for (const ev of sim.events) {
          if (ev.type === 'ringEnter') enter.set(ev.enemyId, t);
          if (ev.type === 'enemyPassed') {
            const t0 = enter.get(ev.enemyId);
            if (t0 !== undefined) dwells.push(t - t0);
          }
        }
        sim.events.length = 0;
      }
      return dwells;
    };

    const at1 = measureAt(1.0);
    const at3 = measureAt(3.0);
    cfg.accelPerSec = 0.25;
    cfg.decelPerSec = 1.0;
    cfg.judgeArea = 'circle';
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
    return { avg1: avg(at1), avg3: avg(at3), n1: at1.length, n3: at3.length };
  });

  await testInfo.attach('band-dwell.json', { body: JSON.stringify(measure, null, 2), contentType: 'application/json' });
  console.log('[P1] 밴드 링 체류 실측', JSON.stringify(measure));
  expect(measure.n1).toBeGreaterThan(0);
  expect(measure.avg1).toBeGreaterThan(0.76);
  expect(measure.avg1).toBeLessThan(0.84);
  expect(measure.avg3).toBeGreaterThan(0.27);
  expect(measure.avg3).toBeLessThan(0.33);
});

test('판정 영역 전환이 패널에서 즉시 반영된다', async ({ page }) => {
  await ready(page, { idle: true });
  await page.locator('#panel-toggle').dispatchEvent('pointerdown');

  expect(await page.evaluate(() => (window as any).__fd.config.judgeArea)).toBe('circle');
  await page.locator('.panel-row', { hasText: '판정 영역' }).locator('select').selectOption('band');
  expect(await page.evaluate(() => (window as any).__fd.config.judgeArea)).toBe('band');
  await expect(page.locator('#panel-stats')).toContainText('B 밴드');

  await page.locator('.panel-row', { hasText: '밴드 높이' }).locator('input[type=range]').fill('0.9');
  expect(await page.evaluate(() => (window as any).__fd.config.bandHeightFrac)).toBeCloseTo(0.9, 3);
});
