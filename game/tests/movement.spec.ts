/**
 * 2D 동선·판정 자가 검증 (P1 전환의 핵심) — 기획서 v2 4장·7장·10.0장.
 * 하단 진입 → 상승 → 링 진입 → 통과 → 상단 프레임 아웃, 그리고 체류 시간 규칙의 정확성.
 */
import { test, expect } from '@playwright/test';
import { ready, freezeClock, installAutoplay } from './helpers';

test('통과형: 화면 하단에서 진입해 상방으로 이동한다', async ({ page }) => {
  await ready(page);
  await freezeClock(page);
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    sim.restart();
    fd.runner.advance(1.1); // W1 첫 스폰(t=1.0)
    const spawned = sim.enemies.filter((e: any) => e.active);
    const first = spawned[0];
    const spawnY = first.y;
    const belowScreen = spawnY < sim.field.bottomY;
    fd.runner.advance(1.0);
    return {
      count: spawned.length,
      spawnY,
      bottomY: sim.field.bottomY,
      belowScreen,
      movedUp: first.y > spawnY,
      dirY: first.dirY,
    };
  });
  expect(r.count).toBeGreaterThan(0);
  expect(r.belowScreen).toBe(true); // 화면 하단 밖에서 스폰
  expect(r.movedUp).toBe(true);     // 상방 이동
  expect(r.dirY).toBeGreaterThan(0);
});

test('진입 각도: down / left / right 가 서로 다른 방향 벡터를 만든다', async ({ page }) => {
  await ready(page);
  await freezeClock(page);
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    sim.restart();
    // W1 엔트리(down/down/left/right/down)를 스폰되는 순간마다 수집 (프레임 아웃 전에)
    const dirs: { x: number; y: number }[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      fd.runner.advance(0.02);
      sim.events.length = 0;
      for (const e of sim.enemies) {
        if (e.active && !seen.has(e.id)) {
          seen.add(e.id);
          dirs.push({ x: Number(e.dirX.toFixed(3)), y: Number(e.dirY.toFixed(3)) });
        }
      }
      if (dirs.length >= 5) break;
    }
    return { dirs };
  });
  const xs = r.dirs.map(d => d.x);
  expect(xs.some(x => Math.abs(x) < 1e-6)).toBe(true); // 정하방
  expect(xs.some(x => x > 0.1)).toBe(true);            // 좌측 하단 진입 → 우상향
  expect(xs.some(x => x < -0.1)).toBe(true);           // 우측 하단 진입 → 좌상향
  for (const d of r.dirs) expect(d.y).toBeGreaterThan(0);
});

test('링 체류 시간이 기획서 7장 표와 일치 (0.8s@1.0x / 0.3s@3.0x)', async ({ page }, testInfo) => {
  await ready(page);
  await freezeClock(page);
  const measure = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const cfg = fd.config;
    cfg.judgeArea = 'circle'; // 원형(폐기 예정) 경로의 회귀 확인 — 밴드는 judgearea.spec에서 별도 측정

    // 속도를 고정해 측정 (가감속 0으로 두고 speed 직접 설정)
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
        sim.speed = speed; // 클램프·리셋 방지
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
    cfg.judgeArea = 'band';
    const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
    return { at1, at3, avg1: avg(at1), avg3: avg(at3) };
  });

  await testInfo.attach('dwell.json', { body: JSON.stringify(measure, null, 2), contentType: 'application/json' });
  console.log('[P1] 링 체류 실측', JSON.stringify({ avg1: measure.avg1, avg3: measure.avg3 }));
  expect(measure.at1.length).toBeGreaterThan(0);
  expect(measure.at3.length).toBeGreaterThan(0);
  expect(measure.avg1).toBeGreaterThan(0.76);
  expect(measure.avg1).toBeLessThan(0.84);
  expect(measure.avg3).toBeGreaterThan(0.27);
  expect(measure.avg3).toBeLessThan(0.33);
});

test('미처치 통과형: 접촉 피해 후 화면 상단으로 프레임 아웃', async ({ page }) => {
  await ready(page);
  await freezeClock(page);
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    sim.restart();
    let passed = 0;
    let sawAboveTop = false;
    const hpStart = sim.hp;
    for (let i = 0; i < 600; i++) {
      fd.runner.advance(0.02);
      for (const ev of sim.events) if (ev.type === 'enemyPassed') passed++;
      sim.events.length = 0;
      for (const e of sim.enemies) {
        if (e.active && e.phase === 'passing' && e.y > sim.field.topY) sawAboveTop = true;
      }
      if (passed > 0 && sim.hp < hpStart && sawAboveTop) break;
    }
    return { passed, hp: sim.hp, hpStart, sawAboveTop };
  });
  expect(r.passed).toBeGreaterThan(0);
  expect(r.hp).toBeLessThan(r.hpStart); // 미처치 통과 = 접촉 1 피해
  expect(r.sawAboveTop).toBe(true);
});

test('체류형: 동시 상한 4기 포화 + 배치각 분산으로 겹치지 않는다', async ({ page }, testInfo) => {
  await ready(page);
  await freezeClock(page);
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const cfg = fd.config;
    // 체류형 6기를 몰아 넣는 전용 웨이브로 포화 상황을 직접 만든다
    // (본 시퀀스는 체류형이 처치되기 전에는 웨이브가 넘어가지 않아 4기 동시 상황에 도달하지 못한다).
    // 피해 0 = 실패·재시작으로 장면이 리셋되는 것을 막기 위한 측정 목적 한정 설정.
    const savedDamage = cfg.contactDamage;
    cfg.contactDamage = 0;
    const sim = fd.makeSim({
      waves: [{
        name: '혼잡도 테스트',
        restAfterSec: 0,
        entries: [
          { t: 0.0, type: 'a-4' }, { t: 0.4, type: 'a-5' },
          { t: 0.8, type: 'a-4' }, { t: 1.2, type: 'a-5' },
          { t: 1.6, type: 'a-4' }, { t: 2.0, type: 'a-5' },
          { t: 2.4, type: 'a-1' }, { t: 3.0, type: 'a-2' },
          { t: 3.6, type: 'a-3', formationCount: 6 },
        ],
      }],
    });
    const fd2 = { runner: { advance: (s: number) => { const n = Math.round(s / (1 / 120)); for (let i = 0; i < n; i++) sim.step(1 / 120); } } };

    let maxStay = 0;
    let minPairDist = Infinity;
    let framesAtCap = 0;
    let maxHittableWithPass = 0;
    for (let i = 0; i < 3000; i++) {
      fd2.runner.advance(0.02);
      sim.events.length = 0;
      const stay = sim.enemies.filter((e: any) => e.active && e.lifecycle === 'stay' && e.phase === 'orbit');
      maxStay = Math.max(maxStay, stay.length);
      if (stay.length >= cfg.stayCap) framesAtCap++;
      if (stay.length >= 2) {
        for (let a = 0; a < stay.length; a++) {
          for (let b = a + 1; b < stay.length; b++) {
            minPairDist = Math.min(minPairDist, Math.hypot(stay[a].x - stay[b].x, stay[a].y - stay[b].y));
          }
        }
      }
      // 체류형 포화 + 통과형 동시 상황의 링 내 동시 판정 대상 수 (기획서 v2 17장 5)
      if (stay.length >= cfg.stayCap) maxHittableWithPass = Math.max(maxHittableWithPass, sim.hittableCount());
    }
    cfg.contactDamage = savedDamage;
    return {
      maxStay,
      minPairDist: minPairDist === Infinity ? null : Number(minPairDist.toFixed(4)),
      framesAtCap,
      maxHittableWithPass,
      cap: cfg.stayCap,
      hitRadius: 0.066,
      orbitSpreadDeg: cfg.orbitSpreadDeg,
      orbitRadius: Number((cfg.ringRadiusFrac * cfg.orbitRadiusFactor).toFixed(3)),
    };
  });
  await testInfo.attach('congestion.json', { body: JSON.stringify(r, null, 2), contentType: 'application/json' });
  console.log('[P1] 혼잡도', JSON.stringify(r));
  expect(r.maxStay).toBe(r.cap);          // 상한 4기까지 실제로 포화된다
  expect(r.framesAtCap).toBeGreaterThan(0);
  expect(r.minPairDist).not.toBeNull();
  // 스프라이트 반경(0.066)의 2배 = 접촉. 배치각 분산이 이보다 넉넉해야 겹쳐 보이지 않는다
  expect(r.minPairDist!).toBeGreaterThan(r.hitRadius * 2);
});

test('헛스윙 판정: 빈 화면 스와이프는 콤보를 리셋하지 않는다 (M1 검수 질문 3)', async ({ page }) => {
  await ready(page);
  await freezeClock(page);
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    sim.restart();
    sim.combo = 7;

    // (1) 링 안에 적이 없는 상태에서 스와이프 → 무벌점
    for (const e of sim.enemies) e.active = false;
    sim.applySwipeSegment(20, 300, 360, 320, 1000);
    sim.endSwipe(0);
    const comboAfterEmpty = sim.combo;

    // (2) 링 안에 적을 두고 빗나가는 스와이프 → 콤보 리셋
    const e = sim.enemies[0];
    e.active = true;
    e.type = 'a-1';
    e.lifecycle = 'pass';
    e.phase = 'ring';
    e.hp = 1;
    e.lastCountedHitMs = -1e9;
    e.x = sim.girlX;
    e.y = sim.girlY;
    const p = sim.field.toScreen(e.x, e.y);
    // 적에서 멀리 떨어진 화면 구석을 긋는다
    sim.applySwipeSegment(p.x + 260, p.y + 320, p.x + 300, p.y + 360, 2000);
    sim.endSwipe(0);
    const comboAfterWhiff = sim.combo;

    return { comboAfterEmpty, comboAfterWhiff };
  });
  expect(r.comboAfterEmpty).toBe(7); // 빈 화면 = 무벌점
  expect(r.comboAfterWhiff).toBe(0); // 링 내 대상 있는데 못 맞힘 = 미스
});
