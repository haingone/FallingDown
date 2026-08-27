/**
 * 테스트 공용 헬퍼.
 * M1 검수 지적(최초 병렬 실행 플레이크)에 대응해 대기 조건을 3단으로 보강했다:
 *  ① load 완료 → ② __fd 훅 노출 → ③ 첫 렌더 2프레임 완료(__fd.ready, 셰이더 컴파일 포함)
 *  → ④ rAF가 실제로 돌고 있는지(frames 증가) 확인.
 */
import type { Page } from '@playwright/test';

declare global {
  interface Window { __fd: any; __auto: any }
}

export interface ReadyOptions {
  /** 로직 결정성 확보: rAF 실시간 진행을 멈추고 runner.advance()로만 구동 */
  freeze?: boolean;
  url?: string;
}

export async function ready(page: Page, opts: ReadyOptions = {}): Promise<void> {
  await page.goto(opts.url ?? '/', { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.__fd !== 'undefined', null, { timeout: 30_000 });
  await page.waitForFunction(() => window.__fd.ready === true, null, { timeout: 30_000 });
  // rAF 루프가 실제로 돌고 있는지 (첫 프레임 이후 최소 2프레임 더)
  const base = await page.evaluate(() => window.__fd.frames as number);
  await page.waitForFunction((b) => window.__fd.frames > b + 2, base, { timeout: 30_000 });
  if (opts.freeze) {
    await page.evaluate(() => { window.__fd.runner.timeScale = 0; });
  }
}

/**
 * 페이지 컨텍스트에 오토플레이 헬퍼 주입.
 * 실제 입력 파이프라인(applySwipeSegment: 화면 좌표 선분)을 통해 링 안의 적을 요격한다.
 */
export async function installAutoplay(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fd = window.__fd;
    window.__auto = {
      slash() {
        const sim = fd.sim;
        const nowMs = sim.time * 1000;
        for (const e of sim.enemies) {
          if (!e.active) continue;
          const hittable = e.lifecycle === 'pass'
            ? e.phase === 'ring'
            : e.phase === 'orbit' && (e.type !== 'a-5' || e.exposeTimer > 0);
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
      },
    };
  });
}
