/**
 * 엔트리 — 입력(Pointer Events) → 분류기 → 시뮬레이션, rAF 루프에서 러너/렌더러/HUD 결선.
 * 데스크톱 마우스 드래그는 Pointer Events로 터치와 동일 취급.
 */
import { Sim, WavePlan } from './core/sim';
import { CIRCLE_AREA, BAND_AREA } from './core/judgeArea';
import { Runner } from './core/runner';
import { GestureClassifier } from './core/classifier';
import { config } from './core/balance';
import { Renderer2D } from './render/renderer2d';
import { Hud } from './render/hud';
import { Panel } from './render/panel';
import { Beeper } from './render/audio';
import { PerfTracker } from './render/perf';
import wavesJson from './data/waves.json';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 20260821);

const stage = document.getElementById('stage')!;
const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

const plan = wavesJson as unknown as WavePlan;
const sim = new Sim(plan, seed);
const runner = new Runner(sim);
const classifier = new GestureClassifier();
const renderer = new Renderer2D(canvas);
const beeper = new Beeper();
const perf = new PerfTracker();
const hud = new Hud(stage, () => sim.tryDive());
const panel = new Panel(
  stage,
  () => sim,
  classifier,
  perf,
  beeper,
  () => ({ drawCalls: renderer.drawCalls(), overdraw: renderer.overdrawEstimate() }),
  () => sim.restart(),
  () => layout(),
);

// ── 세로 고정 스테이지 (9:16 기준, 노치·비율 변형은 레터박스로 대응) ──
function layout(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let w = vw;
  const h = vh;
  if (vw / vh > 9 / 16) w = Math.round(vh * (9 / 16));
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  sim.field.setViewport(w, h);
  sim.girlY = sim.girlHomeY();
  renderer.setSize(w, h, window.devicePixelRatio || 1);
}
window.addEventListener('resize', layout);
layout();

// ── 입력 ──
interface SwipeState {
  pointerId: number;
  startX: number; startY: number;
  lastX: number; lastY: number;
  strokeX: number; strokeY: number; // 마지막 베기 궤적 이펙트의 시작점
  swiping: boolean;
  hits: number;
  path: { x: number; y: number }[];
}
let touch: SwipeState | null = null;

/** 긴 스와이프는 이 거리(필드 단위)마다 궤적 이펙트를 한 번 더 낸다 */
const RESTROKE_DIST = 0.35;

function stagePos(ev: PointerEvent): { x: number; y: number } {
  const r = stage.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

/** 화면 좌표 두 점을 필드 좌표로 바꿔 베기 궤적 이펙트를 발사 */
function fireSlash(sx: number, sy: number, ex: number, ey: number): void {
  const a = sim.field.toField(sx, sy);
  const b = sim.field.toField(ex, ey);
  renderer.spawnSlash(a.x, a.y, b.x, b.y, sim.stance);
  beeper.slash();
}

stage.addEventListener('pointerdown', (ev) => {
  beeper.unlock();
  if (touch) return; // 멀티터치는 첫 포인터만
  const p = stagePos(ev);
  touch = {
    pointerId: ev.pointerId,
    startX: p.x, startY: p.y,
    lastX: p.x, lastY: p.y,
    strokeX: p.x, strokeY: p.y,
    swiping: false, hits: 0,
    path: [{ x: p.x, y: p.y }],
  };
  classifier.begin(p.x, p.y, ev.timeStamp);
  stage.setPointerCapture?.(ev.pointerId);
});

stage.addEventListener('pointermove', (ev) => {
  if (!touch || ev.pointerId !== touch.pointerId) return;
  const p = stagePos(ev);
  const becameSwipe = classifier.move(p.x, p.y, ev.timeStamp);

  if (becameSwipe && !touch.swiping) {
    touch.swiping = true;
    // 확정 이전 궤적도 소급 판정 (임계 도달 전 초입 구간)
    for (let i = 1; i < touch.path.length; i++) {
      touch.hits += sim.applySwipeSegment(
        touch.path[i - 1].x, touch.path[i - 1].y,
        touch.path[i].x, touch.path[i].y, ev.timeStamp,
      );
    }
    // 확정 즉시 베기 궤적 발사 (판정 타이밍과 시각 피드백 일치)
    fireSlash(touch.startX, touch.startY, p.x, p.y);
    touch.strokeX = p.x; touch.strokeY = p.y;
  }

  if (touch.swiping) {
    touch.hits += sim.applySwipeSegment(touch.lastX, touch.lastY, p.x, p.y, ev.timeStamp);
    // 길게 쓸어내리는 스와이프는 궤적을 이어서 한 번 더
    const advanced = sim.field.toScreenLength(RESTROKE_DIST);
    if (Math.hypot(p.x - touch.strokeX, p.y - touch.strokeY) >= advanced) {
      fireSlash(touch.strokeX, touch.strokeY, p.x, p.y);
      touch.strokeX = p.x; touch.strokeY = p.y;
    }
  }

  touch.path.push({ x: p.x, y: p.y });
  touch.lastX = p.x;
  touch.lastY = p.y;
});

function endPointer(ev: PointerEvent): void {
  if (!touch || ev.pointerId !== touch.pointerId) return;
  const p = stagePos(ev);
  const rec = classifier.end(p.x, p.y, ev.timeStamp);
  if (rec.kind === 'tap') {
    sim.toggleUmbrella();
  } else if (rec.kind === 'swipe') {
    if (touch.swiping) {
      touch.hits += sim.applySwipeSegment(touch.lastX, touch.lastY, p.x, p.y, ev.timeStamp);
    } else {
      // move 없이 up에서 스와이프로 확정된 경우 (빠른 플릭)
      touch.hits += sim.applySwipeSegment(touch.startX, touch.startY, p.x, p.y, ev.timeStamp);
      fireSlash(touch.startX, touch.startY, p.x, p.y);
    }
    sim.endSwipe(touch.hits);
    panel.swipeHits.push(touch.hits > 0);
  }
  touch = null;
}
stage.addEventListener('pointerup', endPointer);
stage.addEventListener('pointercancel', (ev) => {
  if (touch && ev.pointerId === touch.pointerId) {
    classifier.cancel();
    touch = null;
  }
});

// ── 이벤트 → 연출/사운드 ──
function drainEvents(): void {
  for (const e of sim.events) {
    switch (e.type) {
      case 'ringEnter': beeper.ringEnter(); break;
      case 'slashHit':
        if (e.killed) { beeper.kill(); renderer.spawnBurst(e.x, e.y); }
        break;
      case 'playerHit': beeper.playerHit(); hud.playerHitFlash(); break;
      case 'toggle': beeper.toggle(e.open); break;
      case 'gaugeFull': beeper.gaugeFull(); break;
      case 'diveStart': beeper.diveStart(); break;
      case 'diveEnd': beeper.diveEnd(); break;
      case 'fail': beeper.fail(); break;
      case 'clear': beeper.clear(); break;
      default: break;
    }
  }
  sim.events.length = 0;
}

// ── 메인 루프 ──
let last = performance.now();
let statTick = 0;
function loop(now: number): void {
  const dtMs = now - last;
  last = now;
  perf.frame(dtMs);
  runner.tick(dtMs / 1000);
  drainEvents();
  renderer.render(sim, runner.alpha, Math.min(dtMs / 1000, 0.1));
  hud.update(sim, dtMs / 1000);
  statTick += dtMs;
  if (statTick > 250) {
    statTick = 0;
    panel.updateStats();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ── 자가 검증 훅 (Playwright) ──
declare global {
  interface Window {
    __fd: {
      sim: Sim;
      runner: Runner;
      classifier: GestureClassifier;
      config: typeof config;
      renderer: Renderer2D;
      perf: PerfTracker;
      makeClassifier: () => GestureClassifier;
      relayout: () => void;
      /** 테스트 전용: 임의 웨이브 플랜으로 격리된 시뮬레이션을 만든다 */
      makeSim: (plan: WavePlan, seed?: number) => Sim;
      /** 테스트 전용: 판정 영역 전략 직접 접근 (기하 커버리지 프로브) */
      judge: { circle: typeof CIRCLE_AREA; band: typeof BAND_AREA };
    };
  }
}
window.__fd = {
  sim, runner, classifier, config, renderer, perf,
  makeClassifier: () => new GestureClassifier(),
  relayout: layout,
  makeSim: (p, s) => {
    const isolated = new Sim(p, s ?? seed);
    isolated.field.setViewport(sim.field.width, sim.field.height);
    isolated.girlY = isolated.girlHomeY();
    return isolated;
  },
  judge: { circle: CIRCLE_AREA, band: BAND_AREA },
};
