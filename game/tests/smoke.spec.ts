/**
 * 90초 시퀀스 스모크 + 코어 규칙 검증 — 실제 입력 파이프라인(applySwipeSegment)을 통해
 * 링 진입 적을 자동 요격하는 오토플레이로 진행한다.
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';

async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__fd !== undefined);
  // 로직 테스트 결정성: 실시간 rAF 진행을 멈추고 advance()로만 구동
  await page.evaluate(() => { (window as any).__fd.runner.timeScale = 0; });
}

/** 페이지 컨텍스트에 오토플레이 헬퍼 주입 */
async function installAutoplay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fd = (window as any).__fd;
    (window as any).__auto = {
      slash() {
        const sim = fd.sim;
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
        for (const pr of sim.projectiles) {
          if (!pr.active) continue;
          const p = sim.projector.project(pr.x - sim.girlX, pr.y - sim.girlY, pr.z - sim.girlZ);
          if (!p) continue;
          const hits = sim.applySwipeSegment(p.x - 50, p.y, p.x + 50, p.y, nowMs);
          if (hits > 0) sim.endSwipe(hits);
        }
      },
    };
  });
}

test('90초 시퀀스: 오토플레이로 클리어 성립 + 게이지 커브 실측', async ({ page }, testInfo) => {
  await ready(page);
  await installAutoplay(page);

  const metrics = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const auto = (window as any).__auto;
    let diveUsedAt: number | null = null;
    let diveEndSpeed: number | null = null;
    let toggleLockedAfterDive: boolean | null = null;
    const waveStartTimes: number[] = [];
    let lastWave = -1;

    while (sim.state !== 'clear' && sim.time < 200) {
      fd.runner.advance(0.05);
      auto.slash();
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
      kills: sim.kills,
      passed: sim.passedCount,
      hitsTaken: sim.hitsTaken,
      hp: sim.hp,
      avgMultiplier: sim.avgMultiplier,
      score: sim.score,
      restarts: sim.restartCount,
      waveStartTimes,
    };
  });

  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/m1-smoke-metrics.json', JSON.stringify(metrics, null, 2));
  await testInfo.attach('m1-smoke-metrics.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  console.log('[M1] smoke metrics', JSON.stringify(metrics));

  expect(metrics.state).toBe('clear');
  expect(metrics.restarts).toBe(0);            // 오토플레이 기준 노데스 클리어
  expect(metrics.gaugeFullAt).not.toBeNull();  // 게이지 100% 도달 성립
  expect(metrics.diveUsedAt).not.toBeNull();   // 도약 발동 성립
  expect(metrics.diveEndSpeed).toBe(3);        // 종료 후 3.0x 강제 복귀
  expect(metrics.toggleLockedAfterDive).toBe(true); // 1초 토글 잠금
});

test('90초 시퀀스(저속 1.0x 고정): 게이지 커브 보수적 하한 실측', async ({ page }, testInfo) => {
  await ready(page);
  await installAutoplay(page);
  const metrics = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const auto = (window as any).__auto;
    sim.restart();
    const baseRestarts = sim.restartCount; // restart() 자체가 카운트를 올리므로 기준값으로 비교
    sim.toggleUmbrella(); // 펼침 유지 → 1.0x 클램프 (배율 최소 = 게이지 수급 최소)
    while (sim.state !== 'clear' && sim.time < 300 && sim.restartCount === baseRestarts) {
      fd.runner.advance(0.05);
      auto.slash();
    }
    return {
      state: sim.state,
      clearTime: sim.time,
      gaugeFullAt: sim.gaugeFullAt,
      gaugeAtEnd: sim.gauge,
      kills: sim.kills,
      avgMultiplier: sim.avgMultiplier,
      restarts: sim.restartCount,
    };
  });
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/m1-smoke-lowspeed-metrics.json', JSON.stringify(metrics, null, 2));
  await testInfo.attach('m1-smoke-lowspeed-metrics.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  console.log('[M1] lowspeed metrics', JSON.stringify(metrics));
  expect(metrics.state).toBe('clear');
});

test('낙하 속도 다이얼: 접음 +0.25x/s, 펼침 -1.0x/s, 클램프', async ({ page }) => {
  await ready(page);
  await installAutoplay(page);
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const auto = (window as any).__auto;
    sim.restart(); // 페이지 로드~timeScale=0 사이 실시간 진행분 제거
    // 오토 요격으로 피격(HP 소진→재시작)에 의한 속도 리셋 배제. 히트스톱은 시간을 흡수하므로
    // 시뮬레이션 시간(sim.time) 기준으로 구간을 측정한다.
    const advanceTo = (t: number) => {
      while (sim.time < t - 1e-9) { fd.runner.advance(1 / 120); auto.slash(); }
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

test('도약: 무적·자동 격파·종료 규칙', async ({ page }) => {
  await ready(page);
  await installAutoplay(page);
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    fd.runner.advance(6); // 적들 접근
    sim.gauge = 1;        // 테스트 치트: 게이지 강제 충전
    const started = sim.tryDive();
    const killsBefore = sim.kills;
    const hpBefore = sim.hp;
    fd.runner.advance(2.0);
    const activeDuring = sim.diveActive;
    fd.runner.advance(0.6);
    return {
      started,
      activeDuring,
      activeAfter: sim.diveActive,
      speedAfter: sim.speed,
      killsGained: sim.kills - killsBefore,
      hpDelta: sim.hp - hpBefore,
      gauge: sim.gauge,
    };
  });
  expect(r.started).toBe(true);
  expect(r.activeDuring).toBe(true);
  expect(r.activeAfter).toBe(false);
  expect(r.speedAfter).toBe(3);
  expect(r.killsGained).toBeGreaterThan(0); // 밀집 방향 비행 자동 격파
  expect(r.hpDelta).toBe(0);                // 무적
  expect(r.gauge).toBe(0);
});

test('생존: 방치 시 통과 피해 누적 → 실패 → 즉시 재시작', async ({ page }) => {
  await ready(page);
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    let sawFail = false;
    let hpDropped = false;
    for (let i = 0; i < 1200; i++) {
      fd.runner.advance(0.1);
      if (sim.hp < 5) hpDropped = true;
      if (sim.state === 'fail') sawFail = true;
      if (sim.restartCount > 0 && sim.state === 'playing') break;
    }
    return { sawFail, hpDropped, restarts: sim.restartCount, state: sim.state, hp: sim.hp };
  });
  expect(r.hpDropped).toBe(true);
  expect(r.sawFail).toBe(true);
  expect(r.restarts).toBeGreaterThanOrEqual(1);
  expect(r.state).toBe('playing');
  expect(r.hp).toBe(5); // 재시작 시 전량 회복
});

test('최고속 콤보: 3.0x 유지 시 1초당 +1', async ({ page }) => {
  await ready(page);
  await installAutoplay(page);
  const r = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const auto = (window as any).__auto;
    // 접음 유지 + 오토 요격으로 피격 없이 3.0x 도달 후 유지
    for (let i = 0; i < 240; i++) { fd.runner.advance(0.05); auto.slash(); } // 12초
    return { speed: sim.speed, combo: sim.combo, hitsTaken: sim.hitsTaken };
  });
  expect(r.speed).toBeCloseTo(3.0, 3);
  expect(r.combo).toBeGreaterThanOrEqual(2); // 8초에 3.0x 도달 → 이후 1초당 +1
});
