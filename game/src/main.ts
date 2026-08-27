/**
 * 엔트리 — 입력(Pointer Events) → 분류기 → 시뮬레이션, rAF 루프에서 러너/렌더러/HUD 결선.
 * 데스크톱 마우스 드래그는 Pointer Events로 터치와 동일 취급.
 */
import { Sim, WavePlan } from './core/sim';
import { Runner } from './core/runner';
import { GestureClassifier } from './core/classifier';
import { config } from './core/balance';
import { Renderer } from './render/renderer';
import { Hud } from './render/hud';
import { Panel } from './render/panel';
import { Beeper } from './render/audio';
import { PerfTracker } from './render/perf';
import wavesJson from './data/waves.json';

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? 20260821);

const stage = document.getElementById('stage')!;
const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const trailCanvas = document.getElementById('trail-canvas') as HTMLCanvasElement;
const trailCtx = trailCanvas.getContext('2d')!;

const plan = wavesJson as unknown as WavePlan;
const sim = new Sim(plan, seed);
const runner = new Runner(sim);
const classifier = new GestureClassifier();
const renderer = new Renderer(canvas);
const beeper = new Beeper();
const perf = new PerfTracker();
const hud = new Hud(stage, () => sim.tryDive());
const panel = new Panel(stage, () => sim, classifier, perf, beeper, renderer, () => sim.restart());

// ── 세로 고정 스테이지 (9:16 기준 레터박스) ──
function layout(): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let w = vw;
  const h = vh;
  if (vw / vh > 9 / 16) w = Math.round(vh * (9 / 16)); // 가로가 넓으면 좌우 레터박스
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  const dpr = window.devicePixelRatio || 1;
  renderer.setSize(w, h, dpr);
  trailCanvas.width = Math.round(w * dpr);
  trailCanvas.height = Math.round(h * dpr);
  trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sim.plane.viewport = { width: w, height: h };
}
window.addEventListener('resize', layout);
layout();

// ── 입력 ──
interface SwipeState {
  pointerId: number;
  lastX: number;
  lastY: number;
  swiping: boolean;
  hits: number;
  slashFired: boolean;
  path: { x: number; y: number }[];
}
let touch: SwipeState | null = null;

function stagePos(ev: PointerEvent): { x: number; y: number } {
  const r = stage.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

/** 베기 궤적 이펙트 발사 (첫 히트 시점 = 히트스톱과 동기, 없으면 스와이프 종료 시) */
function fireSlash(t: SwipeState): void {
  if (t.slashFired || t.path.length < 2) return;
  t.slashFired = true;
  renderer.spawnSlash(t.path, sim.stance);
}

stage.addEventListener('pointerdown', (ev) => {
  beeper.unlock();
  if (touch) return; // 멀티터치는 첫 포인터만
  const p = stagePos(ev);
  touch = { pointerId: ev.pointerId, lastX: p.x, lastY: p.y, swiping: false, hits: 0, slashFired: false, path: [{ x: p.x, y: p.y }] };
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
      touch.hits += sim.applySwipeSegment(touch.path[i - 1].x, touch.path[i - 1].y, touch.path[i].x, touch.path[i].y, ev.timeStamp);
    }
  }
  if (touch.swiping) {
    touch.hits += sim.applySwipeSegment(touch.lastX, touch.lastY, p.x, p.y, ev.timeStamp);
  }
  touch.path.push({ x: p.x, y: p.y });
  touch.lastX = p.x;
  touch.lastY = p.y;
  if (touch.swiping && touch.hits > 0) fireSlash(touch);
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
      touch.path.push({ x: p.x, y: p.y });
    }
    fireSlash(touch); // 헛스윙도 궤적은 나간다 (액션 피드백)
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
      case 'ringEnter': beeper.ringEnter(); renderer.pulseRing(); break;
      case 'slashHit':
        if (e.killed) { beeper.kill(); renderer.spawnBurst(e.x, e.y); }
        else beeper.slash();
        break;
      case 'projectileDown': renderer.spawnBurst(e.x, e.y); break;
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

// ── 손가락 궤적 라이브 표시 (베기 이펙트와 별개의 즉시 피드백) ──
function drawTrail(): void {
  const w = sim.plane.viewport.width;
  const h = sim.plane.viewport.height;
  trailCtx.clearRect(0, 0, w, h);
  if (touch && touch.swiping && touch.path.length > 1) {
    trailCtx.strokeStyle = sim.stance === 'umbrella' ? '#ffe9c8' : '#cfeeff';
    trailCtx.lineWidth = 2;
    trailCtx.lineCap = 'round';
    trailCtx.lineJoin = 'round';
    trailCtx.globalAlpha = 0.55;
    trailCtx.beginPath();
    const start = Math.max(0, touch.path.length - 12);
    trailCtx.moveTo(touch.path[start].x, touch.path[start].y);
    for (let i = start + 1; i < touch.path.length; i++) trailCtx.lineTo(touch.path[i].x, touch.path[i].y);
    trailCtx.stroke();
    trailCtx.globalAlpha = 1;
  }
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
  drawTrail();
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
      renderer: Renderer;
      perf: PerfTracker;
      makeClassifier: () => GestureClassifier;
      /** 첫 렌더 완료 플래그 — 테스트 대기 조건 (M1 검수 플레이크 보강) */
      ready: boolean;
      frames: number;
    };
  }
}
window.__fd = {
  sim, runner, classifier, config, renderer, perf,
  makeClassifier: () => new GestureClassifier(),
  ready: false,
  frames: 0,
};

// 첫 프레임이 실제로 그려지고 셰이더 컴파일이 끝난 뒤에 ready를 세운다.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    window.__fd.ready = true;
  });
});
const countFrames = (): void => {
  window.__fd.frames++;
  requestAnimationFrame(countFrames);
};
requestAnimationFrame(countFrames);
