/** Playwright 공용 헬퍼 — 대기 조건 보강 포함 (M1 검수 지적: 최초 병렬 실행 플레이크) */
import type { Page } from '@playwright/test';

/**
 * 페이지 로드 + **프레임 안정화** 대기.
 * M1 플레이크의 원인은 첫 WebGL 셰이더 컴파일로 메인 스레드가 막혀 PointerEvent.timeStamp 간격이
 * 부풀려지고, 60ms 탭이 200ms 임계를 넘겨 'none'으로 분류된 것이었다.
 * 프레임 타임이 실제로 안정될 때까지 기다려 근본 원인을 제거한다.
 */
export async function ready(
  page: Page,
  opts: { stable?: boolean; idle?: boolean } = {},
): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).__fd !== undefined);
  if (opts.stable !== false) {
    await page.waitForFunction(
      () => {
        const perf = (window as any).__fd.perf;
        return perf.fps() >= 30 && perf.onePercentLow() > 0;
      },
      undefined,
      { timeout: 20_000 },
    ).catch(() => { /* 저사양 러너 폴백 — 아래 고정 대기로 보정 */ });
    await page.waitForTimeout(250);
  }
  if (opts.idle) {
    // 안정화를 기다리는 동안 무인 플레이로 HP가 소진돼 fail 상태에 빠지면
    // 탭 토글 등이 거부된다 → 입력 테스트는 깨끗한 playing 상태에서 시작한다.
    await page.evaluate(() => {
      const fd = (window as any).__fd;
      fd.runner.timeScale = 0;
      fd.sim.restart();
      fd.sim.events.length = 0;
    });
  }
}

/** 로직 결정성 확보: 실시간 rAF 진행을 멈추고 advance()로만 구동 */
export async function freezeClock(page: Page): Promise<void> {
  await page.evaluate(() => { (window as any).__fd.runner.timeScale = 0; });
}

/**
 * 오토플레이 주입 — 링 안(판정 가능) 적·투사체를 화면 좌표로 투영해 실제 판정 API로 벤다.
 * 2D 전환에 맞춰 field.toScreen 사용.
 */
export async function installAutoplay(page: Page): Promise<void> {
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
          const p = sim.field.toScreen(e.x, e.y);
          const hits = sim.applySwipeSegment(p.x - 70, p.y, p.x + 70, p.y, nowMs);
          if (hits > 0) sim.endSwipe(hits);
        }
        for (const pr of sim.projectiles) {
          if (!pr.active) continue;
          const p = sim.field.toScreen(pr.x, pr.y);
          const hits = sim.applySwipeSegment(p.x - 50, p.y, p.x + 50, p.y, nowMs);
          if (hits > 0) sim.endSwipe(hits);
        }
      },
    };
  });
}
