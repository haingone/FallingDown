/**
 * 게이지 배율 A/B 자동 실측 (기획서 v2 7장 미결 항목 / 17장 검증 항목 4).
 *
 * A = 게이지 충전에 배율 곱 적용 (M1 현행), B = 미적용 (HQ 권장안, 기본값).
 * 각 모드 × 고속(접음 유지) / 저속(펼침 유지) 플레이로 게이지 100% 도달 시각과
 * 판당 도약 횟수를 자동 측정해 리포트 표의 원자료를 남긴다.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import { ready, installAutoplay } from './helpers';

interface RunResult {
  mode: 'A(배율 적용)' | 'B(배율 미적용)';
  play: '고속(접음 유지)' | '저속(펼침 유지)';
  clearTime: number;
  state: string;
  gaugeFullAt: number | null;
  gaugeFullWave: number | null;
  diveCount: number;
  killsAtGaugeFull: number | null;
  kills: number;
  avgMultiplier: number;
  gaugeAtEnd: number;
  score: number;
}

test('게이지 배율 A/B 자동 실측 (A=적용 / B=미적용 × 고속/저속)', async ({ page }, testInfo) => {
  await ready(page, { freeze: true });
  await installAutoplay(page);

  const results = await page.evaluate(() => {
    const fd = window.__fd;
    const sim = fd.sim;
    const auto = window.__auto;

    function run(multiplierOn: boolean, lowSpeed: boolean) {
      fd.config.gaugeMultiplierEnabled = multiplierOn;
      sim.restart();
      const baseRestarts = sim.restartCount;
      if (lowSpeed) sim.toggleUmbrella(); // 펼침 유지 → 1.0x
      let gaugeFullWave: number | null = null;
      let killsAtGaugeFull: number | null = null;
      // 게이지가 찰 때마다 즉시 도약 (판당 도약 횟수 = 설계상 "감정 정점" 횟수)
      while (sim.state !== 'clear' && sim.time < 400 && sim.restartCount === baseRestarts) {
        fd.runner.advance(0.05);
        auto.slash();
        if (sim.gaugeFullAt !== null && gaugeFullWave === null) {
          gaugeFullWave = sim.waveIndex + 1;
          killsAtGaugeFull = sim.kills;
        }
        if (sim.gauge >= 1 && !sim.diveActive) {
          sim.tryDive();
          fd.runner.advance(2.55);
          if (lowSpeed) {
            // 도약 종료 후 3.0x 강제 → 저속 플레이 조건 복원
            sim.toggleUmbrella();
            sim.toggleUmbrella();
          }
        }
      }
      return {
        mode: multiplierOn ? 'A(배율 적용)' : 'B(배율 미적용)',
        play: lowSpeed ? '저속(펼침 유지)' : '고속(접음 유지)',
        clearTime: Math.round(sim.time * 10) / 10,
        state: sim.state,
        gaugeFullAt: sim.gaugeFullAt === null ? null : Math.round(sim.gaugeFullAt * 10) / 10,
        gaugeFullWave,
        diveCount: sim.diveCount,
        killsAtGaugeFull,
        kills: sim.kills,
        avgMultiplier: Math.round(sim.avgMultiplier * 100) / 100,
        gaugeAtEnd: Math.round(sim.gauge * 100) / 100,
        score: sim.score,
      };
    }

    const out = [
      run(true, false),
      run(true, true),
      run(false, false),
      run(false, true),
    ];
    fd.config.gaugeMultiplierEnabled = false; // 기본값(권장안) 복원
    return out;
  }) as RunResult[];

  fs.mkdirSync('test-results', { recursive: true });
  fs.writeFileSync('test-results/p1-gauge-ab.json', JSON.stringify(results, null, 2));
  await testInfo.attach('p1-gauge-ab.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
  console.log('[P1] gauge A/B');
  for (const r of results) console.log('  ', JSON.stringify(r));

  // 4개 조건 모두 시퀀스가 성립해야 한다
  for (const r of results) expect(r.state).toBe('clear');

  const aFast = results.find(r => r.mode === 'A(배율 적용)' && r.play === '고속(접음 유지)')!;
  const bFast = results.find(r => r.mode === 'B(배율 미적용)' && r.play === '고속(접음 유지)')!;
  expect(aFast.gaugeFullAt).not.toBeNull();
  expect(bFast.gaugeFullAt).not.toBeNull();
  // A는 배율 곱 때문에 반드시 더 빨리 찬다 (규칙이 실제로 갈라지는지 확인)
  expect(aFast.gaugeFullAt!).toBeLessThan(bFast.gaugeFullAt!);
  // 기본값은 권장안 B
  const dflt = await page.evaluate(() => window.__fd.config.gaugeMultiplierEnabled);
  expect(dflt).toBe(false);
});

test('게이지 규칙: 도약 중 격파는 깃털 미지급 (A/B 공통)', async ({ page }) => {
  await ready(page, { freeze: true });
  const r = await page.evaluate(() => {
    const fd = window.__fd;
    const sim = fd.sim;
    const out: { mode: string; gaugeGainDuringDive: number }[] = [];
    for (const on of [true, false]) {
      fd.config.gaugeMultiplierEnabled = on;
      sim.restart();
      fd.runner.advance(8);
      sim.gauge = 1;
      sim.tryDive();
      const before = sim.gauge; // tryDive가 0으로 리셋
      const killsBefore = sim.kills;
      fd.runner.advance(2.4);
      out.push({ mode: on ? 'A' : 'B', gaugeGainDuringDive: sim.gauge - before });
      if (sim.kills === killsBefore) out[out.length - 1].gaugeGainDuringDive = -1; // 격파가 없었으면 무효
    }
    fd.config.gaugeMultiplierEnabled = false;
    return out;
  });
  for (const x of r) expect(x.gaugeGainDuringDive).toBe(0);
});
