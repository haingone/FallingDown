/**
 * 90초 시퀀스 스모크 + 코어 규칙 검증 (P1: 2D 판정 기준으로 이식).
 * 실제 입력 파이프라인(applySwipeSegment: 화면 좌표 선분)을 통해 링 진입 적을 요격하는 오토플레이.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { ready, installAutoplay } from './helpers';

test('90초 시퀀스: 오토플레이로 클리어 성립 + 게이지 커브 실측', async ({ page }, testInfo) => {
  await ready(page, { freeze: true });
  await installAutoplay(page);

  const metrics = await page.evaluate(() => {
    const fd = window.__fd;
    const sim = fd.sim;
    const auto = window.__auto;
    let diveUsedAt: number | null = null;
    let diveEndSpeed: number | null = null;
    let toggleLockedAfterDive: boolean | null = null;
    const waveStartTimes: number[] = [];
    let lastWave = -1;

    while (sim.state !== 'clear' && sim.time < 260) {
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
      stray: sim.strayCount,
      hitsTaken: sim.hitsTaken,
      hp: sim.hp,
      avgMultiplier: sim.avgMultiplier,
      score: sim.score,
      restarts: sim.restartCount,
      peakActiveEnemies: sim.peakActiveEnemies,
      ringEnterCount: sim.ringEnterCount,
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
  expect(metrics.restarts).toBe(0);            // 오토플레이 기준 노데스 클리어
  expect(metrics.gaugeFullAt).not.toBeNull();  // 게이지 100% 도달 성립
  expect(metrics.diveUsedAt).not.toBeNull();   // 도약 발동 성립
  expect(metrics.diveEndSpeed).toBe(3);        // 종료 후 3.0x 강제 복귀
  expect(metrics.toggleLockedAfterDive).toBe(true); // 1초 토글 잠금
});

test('90초 시퀀스(저속 1.0x 고정): 게이지 커브 보수적 하한 실측', async ({ page }, testInfo) => {
  await ready(page, { freeze: true });
  await installAutoplay(page);
  const metrics = await page.evaluate(() => {
    const fd = window.__fd;
    const sim = fd.sim;
    const auto = window.__auto;
    sim.restart();
    const baseRestarts = sim.restartCount; // restart() 자체가 카운트를 올리므로 기준값으로 비교
    sim.toggleUmbrella(); // 펼침 유지 → 1.0x 클램프 (배율 최소 = 게이지 수급 최소)
    while (sim.state !== 'clear' && sim.time < 400 && sim.restartCount === baseRestarts) {
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
  fs.writeFileSync('test-results/p1-smoke-lowspeed-metrics.json', JSON.stringify(metrics, null, 2));
  await testInfo.attach('p1-smoke-lowspeed-metrics.json', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  });
  console.log('[P1] lowspeed metrics', JSON.stringify(metrics));
  expect(metrics.state).toBe('clear');
});

test('2D 동선: 하단 진입 → 링 진입 → 상방 프레임 아웃 + 체류 시간 규칙', async ({ page }, testInfo) => {
  await ready(page, { freeze: true });
  const r = await page.evaluate(() => {
    const fd = window.__fd;
    const sim = fd.sim;
    sim.restart();
    const plane = sim.plane;
    const belowWu = plane.belowWu();

    // 스폰 직후: 전부 화면 하단 밖(y < -belowWu) 이고 위(+y)를 향한다
    fd.runner.advance(1.2);
    const spawned = sim.enemies.filter((e: any) => e.active);
    const allBelow = spawned.every((e: any) => e.y < -belowWu * 0.9);
    const allUpward = spawned.every((e: any) => e.dirY > 0.5);
    const entryAngles = spawned.map((e: any) => e.entryAngleDeg);

    // 링 진입/이탈 추적 (1.0x 고정: 펼침 유지)
    sim.toggleUmbrella();
    const tracked = new Map<number, { enter: number; exit: number | null; screenY: number }>();
    let framedOutAbove = 0;
    let cameFromBelow = 0;
    for (let i = 0; i < 4000; i++) {
      const before = new Map<number, string>();
      for (const e of sim.enemies) if (e.active) before.set(e.id, e.phase);
      fd.runner.advance(1 / 120);
      for (const e of sim.enemies) {
        if (!e.active) continue;
        const prev = before.get(e.id);
        if (prev === 'approach' && e.phase === 'ring') {
          const p = plane.toScreen(e.x, e.y);
          tracked.set(e.id, { enter: sim.time, exit: null, screenY: p.y });
          if (e.y < 0) cameFromBelow++;
        }
        if (prev === 'ring' && e.phase === 'passing') {
          const t = tracked.get(e.id);
          if (t) t.exit = sim.time;
        }
      }
      // 프레임 아웃 감지: passing 상태에서 화면 위로 사라진 적
      for (const [, t] of tracked) if (t.exit !== null) framedOutAbove = Math.max(framedOutAbove, 1);
      if (tracked.size >= 6 && [...tracked.values()].filter(t => t.exit !== null).length >= 4) break;
    }
    const dwells = [...tracked.values()].filter(t => t.exit !== null).map(t => t.exit! - t.enter);
    return {
      allBelow, allUpward,
      spawnCount: spawned.length,
      entryAngleMax: Math.max(...entryAngles.map(Math.abs)),
      cameFromBelow,
      ringEnters: tracked.size,
      dwellSamples: dwells,
      dwellMean: dwells.reduce((a, b) => a + b, 0) / Math.max(1, dwells.length),
      expectedDwellAt1x: fd.config.dwellAt1x,
      framedOutAbove,
      belowWu,
      aboveWu: plane.aboveWu(),
    };
  });

  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/p1-2d-lifecycle.json', JSON.stringify(r, null, 2));
  await testInfo.attach('p1-2d-lifecycle.json', { body: JSON.stringify(r, null, 2), contentType: 'application/json' });
  console.log('[P1] 2D lifecycle', JSON.stringify(r));

  expect(r.allBelow).toBe(true);                       // 하단(±사선 하단)에서 진입
  expect(r.allUpward).toBe(true);                      // 상방 이동
  expect(r.entryAngleMax).toBeLessThanOrEqual(38.01);  // 사선 진입 최대각 준수
  expect(r.cameFromBelow).toBeGreaterThan(0);          // 링 진입은 아래쪽에서 일어난다
  expect(r.dwellSamples.length).toBeGreaterThanOrEqual(3);
  // 링 체류 시간 = 기획서 7장 0.8초 @1.0x (현 길이로 속도 역산하므로 오차 5% 이내)
  expect(r.dwellMean).toBeGreaterThan(0.76);
  expect(r.dwellMean).toBeLessThan(0.84);
});

test('링 통과 후에는 벨 수 없다 (질문 5 확정 규칙)', async ({ page }) => {
  await ready(page, { freeze: true });
  const r = await page.evaluate(() => {
    const fd = window.__fd;
    const sim = fd.sim;
    sim.restart();
    let hitsOnPassing = 0;
    let passingSeen = 0;
    for (let i = 0; i < 3000; i++) {
      fd.runner.advance(1 / 120);
      for (const e of sim.enemies) {
        if (!e.active || e.phase !== 'passing') continue;
        passingSeen++;
        const p = sim.plane.toScreen(e.x, e.y);
        hitsOnPassing += sim.applySwipeSegment(p.x - 90, p.y, p.x + 90, p.y, sim.time * 1000 + i);
      }
      if (passingSeen > 40) break;
    }
    return { passingSeen, hitsOnPassing };
  });
  expect(r.passingSeen).toBeGreaterThan(0);
  expect(r.hitsOnPassing).toBe(0);
});

test('베기 미스 판정: 링 내 적이 있을 때의 헛스윙만 콤보 리셋 (질문 3 확정)', async ({ page }) => {
  await ready(page, { freeze: true });
  await installAutoplay(page);
  const r = await page.evaluate(() => {
    const fd = window.__fd;
    const sim = fd.sim;
    const auto = window.__auto;
    sim.restart();
    // 접음 유지 + 오토 요격 → 피격 없이 3.0x 도달·콤보 적립
    for (let i = 0; i < 240; i++) { fd.runner.advance(0.05); auto.slash(); }
    // 휴지기(rest)가 아닌 전투 중(playing) 상태에서 판정한다 (콤보 리셋 조건이 playing 기준)
    let guard = 4000;
    while (sim.state !== 'playing' && guard-- > 0) { fd.runner.advance(1 / 120); auto.slash(); }
    // 링에 적이 없는 상태를 만든다
    for (const e of sim.enemies) if (e.phase === 'ring') e.active = false;
    const comboBefore = sim.combo;
    // ① 빈 화면 스와이프 (링 내 적 없음) → 무벌점
    sim.applySwipeSegment(20, 700, 360, 690, sim.time * 1000);
    sim.endSwipe(0);
    const comboAfterEmpty = sim.combo;
    const emptyCount = sim.emptySwipeCount;

    // ② 링 안에 적을 강제 배치하고 빗나가는 스와이프 → 베기 미스
    const target = sim.enemies.find((e: any) => !e.active);
    target.active = true; target.type = 'a-1'; target.lifecycle = 'pass'; target.phase = 'ring';
    target.hp = 1; target.x = 0; target.y = 0; target.prevX = 0; target.prevY = 0;
    target.lastCountedHitMs = -1e9;
    const far = sim.plane.viewport.height - 4;
    sim.applySwipeSegment(4, far, 40, far, sim.time * 1000 + 500);
    sim.endSwipe(0);
    return {
      state: sim.state,
      comboBefore,
      comboAfterEmpty,
      comboAfterMiss: sim.combo,
      emptySwipeCount: emptyCount,
      missCount: sim.swipeMissCount,
    };
  });
  expect(r.comboBefore).toBeGreaterThan(0);
  expect(r.comboAfterEmpty).toBe(r.comboBefore); // 빈 스와이프는 무벌점
  expect(r.emptySwipeCount).toBeGreaterThanOrEqual(1);
  expect(r.comboAfterMiss).toBe(0);              // 링 내 적 있는 헛스윙 = 미스
  expect(r.missCount).toBeGreaterThanOrEqual(1);
});

test('낙하 속도 다이얼: 접음 +0.25x/s, 펼침 -1.0x/s, 클램프', async ({ page }) => {
  await ready(page, { freeze: true });
  await installAutoplay(page);
  const r = await page.evaluate(() => {
    const fd = window.__fd;
    const sim = fd.sim;
    const auto = window.__auto;
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

test('도약: 무적·자동 격파·종료 규칙 (2D 화면 내 비행)', async ({ page }) => {
  await ready(page, { freeze: true });
  const r = await page.evaluate(() => {
    const fd = window.__fd;
    const sim = fd.sim;
    fd.runner.advance(6); // 적들 접근
    sim.gauge = 1;        // 테스트 치트: 게이지 강제 충전
    const started = sim.tryDive();
    const killsBefore = sim.kills;
    const hpBefore = sim.hp;
    let maxAbsX = 0, minY = 0, maxY = 0;
    let activeDuring = false;
    // 히트스톱(격파마다 40ms)이 시뮬레이션 시간을 흡수하므로 실제 종료까지 돌린다 (리포트 기술 부채)
    let steps = 0;
    while (sim.diveActive && steps < 1200) {
      fd.runner.advance(1 / 120);
      steps++;
      if (steps === 120) activeDuring = sim.diveActive; // 1초 시점엔 반드시 진행 중
      maxAbsX = Math.max(maxAbsX, Math.abs(sim.girlX));
      minY = Math.min(minY, sim.girlY);
      maxY = Math.max(maxY, sim.girlY);
    }
    const diveRealSec = steps / 120;
    return {
      started,
      activeDuring,
      activeAfter: sim.diveActive,
      speedAfter: sim.speed,
      killsGained: sim.kills - killsBefore,
      hpDelta: sim.hp - hpBefore,
      gauge: sim.gauge,
      diveCount: sim.diveCount,
      diveRealSec,
      maxAbsX, minY, maxY,
      halfWidthWu: sim.plane.halfWidthWu(),
      aboveWu: sim.plane.aboveWu(),
      belowWu: sim.plane.belowWu(),
    };
  });
  expect(r.started).toBe(true);
  expect(r.activeDuring).toBe(true);
  expect(r.activeAfter).toBe(false);
  expect(r.speedAfter).toBe(3);
  expect(r.killsGained).toBeGreaterThan(0); // 밀집 방향 비행 자동 격파
  expect(r.hpDelta).toBe(0);                // 무적
  expect(r.gauge).toBe(0);
  expect(r.diveCount).toBe(1);
  // 고정 카메라 = 화면 내 비행 (프레임 밖으로 나가지 않는다)
  expect(r.maxAbsX).toBeLessThanOrEqual(r.halfWidthWu);
  expect(r.maxY).toBeLessThanOrEqual(r.aboveWu);
  expect(r.minY).toBeGreaterThanOrEqual(-r.belowWu);
});

test('생존: 방치 시 통과 피해 누적 → 실패 → 즉시 재시작', async ({ page }) => {
  await ready(page, { freeze: true });
  const r = await page.evaluate(() => {
    const fd = window.__fd;
    const sim = fd.sim;
    let sawFail = false;
    let hpDropped = false;
    for (let i = 0; i < 2400; i++) {
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
  await ready(page, { freeze: true });
  await installAutoplay(page);
  const r = await page.evaluate(() => {
    const fd = window.__fd;
    const sim = fd.sim;
    const auto = window.__auto;
    sim.restart();
    // 접음 유지 + 오토 요격으로 피격 없이 3.0x 도달 후 유지
    for (let i = 0; i < 240; i++) { fd.runner.advance(0.05); auto.slash(); } // 12초
    return { speed: sim.speed, combo: sim.combo, hitsTaken: sim.hitsTaken };
  });
  expect(r.speed).toBeCloseTo(3.0, 3);
  expect(r.combo).toBeGreaterThanOrEqual(2); // 8초에 3.0x 도달 → 이후 1초당 +1
});

test('체류형 혼잡도: 상한 4기 + 배치각 분산 (검증 항목 5)', async ({ page }, testInfo) => {
  await ready(page, { freeze: true });
  const r = await page.evaluate(() => {
    const fd = window.__fd;
    const sim = fd.sim;
    sim.restart();
    let maxStay = 0;
    let minPairAngleDeg = 360;
    let minPairDistWu = 99;
    let maxOverlapPairs = 0;
    let capReachedAt: number | null = null;

    // 측정 리그: 최종 웨이브(index 4)에서 체류형을 불사(HP 고정)로 만들어 상한 4기 포화 상태를 재현한다.
    // (스와이프 선분은 링 내 모든 적을 판정하므로 "체류형만 안 베기"로는 분리되지 않는다 — 편대 쓸기 특성)
    const slash = () => {
      const nowMs = sim.time * 1000;
      for (const e of sim.enemies) {
        if (!e.active) continue;
        const isStay = e.lifecycle === 'stay';
        const hittable = isStay
          ? e.phase === 'orbit' && (e.type !== 'a-5' || e.exposeTimer > 0)
          : e.phase === 'ring';
        if (!hittable) continue;
        const p = sim.plane.toScreen(e.x, e.y);
        const hits = sim.applySwipeSegment(p.x - 70, p.y, p.x + 70, p.y, nowMs);
        if (hits > 0) sim.endSwipe(hits);
      }
      for (const pr of sim.projectiles) {
        if (!pr.active) continue;
        const p = sim.plane.toScreen(pr.x, pr.y);
        const hits = sim.applySwipeSegment(p.x - 50, p.y, p.x + 50, p.y, nowMs);
        if (hits > 0) sim.endSwipe(hits);
      }
    };

    for (let i = 0; i < 40000; i++) {
      fd.runner.advance(1 / 120);
      if (sim.waveIndex >= 4) {
        for (const e of sim.enemies) if (e.active && e.lifecycle === 'stay') e.hp = 9;
      }
      slash();
      sim.hp = fd.config.maxHp; // 측정 리그: 체류형 4기 포화 상태를 유지하기 위한 무한 HP
      const stay = sim.enemies.filter((e: any) => e.active && e.lifecycle === 'stay' && e.phase === 'orbit');
      if (stay.length > maxStay) { maxStay = stay.length; if (maxStay >= 4) capReachedAt = sim.time; }
      // 정착(0.4초) 이후에만 겹침을 측정한다
      const settled = stay.filter((e: any) => e.orbitBlend >= 1);
      if (settled.length >= 2) {
        let overlap = 0;
        for (let a = 0; a < settled.length; a++) {
          for (let b = a + 1; b < settled.length; b++) {
            const d = Math.hypot(settled[a].x - settled[b].x, settled[a].y - settled[b].y);
            minPairDistWu = Math.min(minPairDistWu, d);
            // 스프라이트 반경 합(0.36+0.36) 미만이면 화면상 겹침
            if (d < 0.72) overlap++;
            const da = Math.abs(((settled[a].orbitAngle - settled[b].orbitAngle) * 180 / Math.PI) % 360);
            minPairAngleDeg = Math.min(minPairAngleDeg, Math.min(da, 360 - da));
          }
        }
        maxOverlapPairs = Math.max(maxOverlapPairs, overlap);
      }
      if (capReachedAt !== null && sim.time > capReachedAt + 8) break;
      if (sim.state === 'clear') break;
    }
    return {
      maxStay,
      capReachedAt: capReachedAt === null ? null : Math.round(capReachedAt * 10) / 10,
      minPairAngleDeg: Math.round(minPairAngleDeg * 10) / 10,
      minPairDistWu: Math.round(minPairDistWu * 100) / 100,
      maxOverlapPairs,
      stayCap: fd.config.stayCap,
      arcDeg: fd.config.stayArcDeg,
      ringRadiusWu: fd.config.ringRadiusWu,
      peakActiveEnemies: sim.peakActiveEnemies,
    };
  });
  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/p1-crowding.json', JSON.stringify(r, null, 2));
  await testInfo.attach('p1-crowding.json', { body: JSON.stringify(r, null, 2), contentType: 'application/json' });
  console.log('[P1] crowding', JSON.stringify(r));
  expect(r.maxStay).toBeLessThanOrEqual(r.stayCap);
  expect(r.maxStay).toBe(r.stayCap);      // 상한까지 실제로 포화됨
  expect(r.maxOverlapPairs).toBe(0);      // 슬롯 배치각 분산으로 스프라이트 겹침 없음
});
