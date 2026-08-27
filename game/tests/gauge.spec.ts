/**
 * 게이지 배율 A/B 자동 실측 — 기획서 v2 7장 미결 항목 / 17장 검증 4 (지시문 P1 §4).
 *
 * A안(기본·HQ 권장) = 게이지에 배율 미적용 (하급 1기 = 고정 5%)
 * B안               = 게이지에 배율 곱 적용 (M1 현행)
 *
 * 저속(1.0x 고정)·고속(접음 유지) 두 플레이 스타일 × A/B = 4조합을 같은 시드로 돌려
 * "게이지 100% 도달 시각"과 "판당 도약 횟수"를 비교한다.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { ready, freezeClock, installAutoplay } from './helpers';

test('게이지 배율 A/B: 100% 도달 시각과 판당 도약 횟수 실측', async ({ page }, testInfo) => {
  await ready(page);
  await freezeClock(page);
  await installAutoplay(page);

  const table = await page.evaluate(() => {
    const fd = (window as any).__fd;
    const sim = fd.sim;
    const cfg = fd.config;
    const auto = (window as any).__auto;

    /** 한 판을 끝까지 돌리며 게이지가 찰 때마다 도약을 쓴다 */
    const run = (multiplierOn: boolean, slow: boolean) => {
      cfg.gaugeMultiplierEnabled = multiplierOn;
      sim.restart();
      const baseRestarts = sim.restartCount;
      if (slow) sim.toggleUmbrella(); // 펼침 유지 → 1.0x 클램프
      const diveTimes: number[] = [];
      const waveAtDive: number[] = [];
      while (sim.state !== 'clear' && sim.time < 300 && sim.restartCount === baseRestarts) {
        fd.runner.advance(0.05);
        auto.slash();
        sim.events.length = 0;
        if (sim.gauge >= 1 && !sim.diveActive) {
          diveTimes.push(Number(sim.time.toFixed(2)));
          waveAtDive.push(sim.waveIndex + 1);
          sim.tryDive();
          if (slow) {
            // 도약 종료 후 3.0x 강제 → 저속 시나리오 유지를 위해 즉시 다시 펼침.
            // clear/fail 상태에서는 step()이 조기 반환하므로 반드시 반복 상한을 둔다.
            for (let g = 0; g < 200 && (sim.diveActive || sim.toggleLockTimer > 0); g++) {
              fd.runner.advance(0.05);
              auto.slash();
              sim.events.length = 0;
            }
            if (!sim.umbrellaOpen) sim.toggleUmbrella();
          }
        }
      }
      return {
        gaugeMultiplier: multiplierOn ? 'ON (B안)' : 'OFF (A안)',
        style: slow ? '저속 1.0x' : '고속(접음 유지)',
        state: sim.state,
        clearTime: Number(sim.time.toFixed(1)),
        firstGaugeFullAt: sim.gaugeFullAt !== null ? Number(sim.gaugeFullAt.toFixed(1)) : null,
        diveCount: sim.diveCount,
        diveTimes,
        waveAtDive,
        waveCount: sim.waveCount,
        avgMultiplier: Number(sim.avgMultiplier.toFixed(2)),
        kills: sim.kills,
      };
    };

    const rows = [
      run(false, true),
      run(false, false),
      run(true, true),
      run(true, false),
    ];
    cfg.gaugeMultiplierEnabled = false; // 기본값 복귀
    return rows;
  });

  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/p1-gauge-ab.json', JSON.stringify(table, null, 2));
  await testInfo.attach('p1-gauge-ab.json', {
    body: JSON.stringify(table, null, 2),
    contentType: 'application/json',
  });
  for (const row of table) console.log('[P1] gauge A/B', JSON.stringify(row));

  // 4조합 모두 클리어까지 진행되어야 실측치로 쓸 수 있다
  for (const row of table) {
    expect(row.state).toBe('clear');
    expect(row.firstGaugeFullAt).not.toBeNull();
  }
  const offFast = table.find(r => r.gaugeMultiplier.startsWith('OFF') && r.style.startsWith('고속'))!;
  const onFast = table.find(r => r.gaugeMultiplier.startsWith('ON') && r.style.startsWith('고속'))!;
  // B안(배율 곱)은 고속 플레이에서 게이지가 더 빨리 찬다 — A/B가 실제로 갈리는지 확인
  expect(onFast.firstGaugeFullAt!).toBeLessThan(offFast.firstGaugeFullAt!);
  expect(onFast.diveCount).toBeGreaterThanOrEqual(offFast.diveCount);
});
