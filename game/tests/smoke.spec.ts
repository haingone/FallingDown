/**
 * 90초 시퀀스 스모크 + 코어 규칙 회귀 검증 (M1 이월 규칙이 2D 전환 후에도 성립하는지).
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { ready, freezeClock, installAutoplay } from './helpers';

test('90초 시퀀스: 오토플레이로 클리어 성립 + 게이지 커브 실측', async ({ page }, testInfo) => {
  await ready(page);
  await freezeClock(page);
  await installAutoplay(page);

  const metrics = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const auto = (window as any).__auto;
    sim.restart();
    const baseRestarts = sim.restartCount;
    let diveUsedAt: number | null = null;
    let diveEndSpeed: number | null = null;
    let toggleLockedAfterDive: boolean | null = null;
    const waveStartTimes: number[] = [];
    let lastWave = -1;

    while (sim.state !== 'clear' && sim.time < 240 && sim.restartCount === baseRestarts) {
      fd.runner.advance(0.05);
      auto.slash();
      sim.events.length = 0;
      if (sim.waveIndex !== lastWave) {
        lastWave = sim.waveIndex;
        waveStartTimes[lastWave] = sim.time;
      }
      if (sim.gauge >= 1 && !sim.diveActive && diveUsedAt === null) {
        sim.tryDive();
        diveUsedAt = sim.time;
        fd.runner.advance(2.55); // 도약 완주
        diveEndSpeed = sim.speed;
        toggleLockedAfterDive = !sim.toggleUmbrella(); // 1초 토글 잠금 → 거부돼야 함
      }
    }
    return {
      state: sim.state,
      clearTime: sim.time,
      gaugeFullAt: sim.gaugeFullAt,
      diveUsedAt,
      diveEndSpeed,
      toggleLockedAfterDive,
      diveCount: sim.diveCount,
      kills: sim.kills,
      passed: sim.passedCount,
      hitsTaken: sim.hitsTaken,
      hp: sim.hp,
      avgMultiplier: sim.avgMultiplier,
      score: sim.score,
      waveStartTimes,
    };
  });

  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/p1-smoke-metrics.json', JSON.stringify(metrics, null, 2));
  await testInfo.attach('p1-smoke-metrics.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  console.log('[P1] smoke metrics', JSON.stringify(metrics));

  expect(metrics.state).toBe('clear');
  expect(metrics.gaugeFullAt).not.toBeNull();
  expect(metrics.diveUsedAt).not.toBeNull();
  expect(metrics.diveEndSpeed).toBe(3);
  expect(metrics.toggleLockedAfterDive).toBe(true);
});

test('낙하 속도 다이얼: 접음 +0.25x/s, 펼침 -1.0x/s, 클램프', async ({ page }) => {
  await ready(page);
  await freezeClock(page);
  await installAutoplay(page);
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const auto = (window as any).__auto;
    sim.restart();
    const advanceTo = (t: number) => {
      while (sim.time < t - 1e-9) { fd.runner.advance(1 / 120); auto.slash(); sim.events.length = 0; }
    };
    const out: Record<string, number> = {};
    out.start = sim.speed;                 // 1.0 (접음 시작)
    advanceTo(4);
    out.after4sClosed = sim.speed;         // 1.0 + 0.25*4 = 2.0
    sim.toggleUmbrella();                  // 펼침
    advanceTo(4.5);
    out.afterHalfSecOpen = sim.speed;      // 2.0 - 0.5 = 1.5
    advanceTo(9.5);
    out.clampedMin = sim.speed;            // 1.0 클램프
    sim.toggleUmbrella();                  // 접음
    advanceTo(19);
    out.clampedMax = sim.speed;            // 3.0 클램프
    return out;
  });
  expect(r.start).toBeCloseTo(1.0, 3);
  expect(r.after4sClosed).toBeCloseTo(2.0, 1);
  expect(r.afterHalfSecOpen).toBeCloseTo(1.5, 1);
  expect(r.clampedMin).toBeCloseTo(1.0, 2);
  expect(r.clampedMax).toBeCloseTo(3.0, 2);
});

test('도약: 무적·자동 격파·종료 규칙 (2D)', async ({ page }) => {
  await ready(page);
  await freezeClock(page);
  await installAutoplay(page);
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    sim.restart();
    fd.runner.advance(8); // 적들 접근
    sim.events.length = 0;
    sim.gauge = 1;        // 테스트 치트: 게이지 강제 충전
    const homeY = sim.girlHomeY();
    const started = sim.tryDive();
    const killsBefore = sim.kills;
    const hpBefore = sim.hp;
    fd.runner.advance(2.0);
    const activeDuring = sim.diveActive;
    const movedDuringDive = Math.hypot(sim.girlX, sim.girlY - homeY) > 0.01;
    fd.runner.advance(1.2); // 종료 + 복귀 보간
    return {
      started,
      activeDuring,
      movedDuringDive,
      activeAfter: sim.diveActive,
      speedAfter: sim.speed,
      killsGained: sim.kills - killsBefore,
      hpDelta: sim.hp - hpBefore,
      gauge: sim.gauge,
      backHome: Math.hypot(sim.girlX, sim.girlY - homeY) < 0.02,
    };
  });
  expect(r.started).toBe(true);
  expect(r.activeDuring).toBe(true);
  expect(r.movedDuringDive).toBe(true);  // 화면 내를 가로지르는 비행
  expect(r.activeAfter).toBe(false);
  expect(r.speedAfter).toBe(3);
  expect(r.killsGained).toBeGreaterThan(0);
  expect(r.hpDelta).toBe(0);             // 무적
  expect(r.gauge).toBe(0);
  expect(r.backHome).toBe(true);         // 종료 후 정위치 복귀
});

test('생존: 방치 시 통과 피해 누적 → 실패 → 즉시 재시작', async ({ page }) => {
  await ready(page);
  await freezeClock(page);
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    sim.restart();
    const baseRestarts = sim.restartCount;
    let sawFail = false;
    let hpDropped = false;
    for (let i = 0; i < 1200; i++) {
      fd.runner.advance(0.1);
      sim.events.length = 0;
      if (sim.hp < 5) hpDropped = true;
      if (sim.state === 'fail') sawFail = true;
      if (sim.restartCount > baseRestarts && sim.state === 'playing') break;
    }
    return { sawFail, hpDropped, restarts: sim.restartCount - baseRestarts, state: sim.state, hp: sim.hp };
  });
  expect(r.hpDropped).toBe(true);
  expect(r.sawFail).toBe(true);
  expect(r.restarts).toBeGreaterThanOrEqual(1);
  expect(r.state).toBe('playing');
  expect(r.hp).toBe(5); // 재시작 시 전량 회복
});

test('최고속 콤보: 3.0x 유지 시 1초당 +1', async ({ page }) => {
  await ready(page);
  await freezeClock(page);
  await installAutoplay(page);
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const auto = (window as any).__auto;
    sim.restart();
    for (let i = 0; i < 240; i++) { fd.runner.advance(0.05); auto.slash(); sim.events.length = 0; } // 12초
    return { speed: sim.speed, combo: sim.combo, hitsTaken: sim.hitsTaken };
  });
  expect(r.speed).toBeCloseTo(3.0, 3);
  expect(r.combo).toBeGreaterThanOrEqual(2); // 8초에 3.0x 도달 → 이후 1초당 +1
});
