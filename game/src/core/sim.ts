/**
 * FallingDown P1 시뮬레이션 (HD-2D 다운 스크롤) — 순수 TS, three.js/DOM 미의존
 * (로직-렌더링 분리, 검수 대상). 고정 타임스텝으로 구동되며(runner.ts) 렌더러는 이 상태를 구독해 그린다.
 *
 * M1(3D)에서 이월: 속도 다이얼, 게이지, 도약 규칙, 생애주기 규칙, 웨이브 러너, HP/콤보, 입력 API 형태.
 * P1에서 교체: 좌표계(원근 3D → 2D 평면, projection.ts) + 적 동선(소실점 접근 → 하단 진입·상방 통과).
 *
 * 좌표계는 projection.ts 참조 (+y = 화면 위, 카메라 고정, 소녀 홈 = 원점).
 */
import { config, dwellTime, attackPeriod, zoomForSpeed } from './balance';
import { Plane2D, segmentIntersectsCircle } from './projection';
import { Rng } from './rng';

export type EnemyType = 'a-1' | 'a-2' | 'a-3' | 'a-4' | 'a-5';
export type Lifecycle = 'pass' | 'stay';
export type Stance = 'umbrella' | 'sword'; // 접음=우산, 펼침=검 (기획서 5장)

const ENEMY_DEF: Record<EnemyType, { lifecycle: Lifecycle; hp: number; low: boolean; radius: number }> = {
  'a-1': { lifecycle: 'pass', hp: 1, low: true, radius: 0.30 },
  'a-2': { lifecycle: 'pass', hp: 1, low: true, radius: 0.30 },
  'a-3': { lifecycle: 'pass', hp: 1, low: true, radius: 0.26 },
  'a-4': { lifecycle: 'stay', hp: 2, low: false, radius: 0.36 },
  'a-5': { lifecycle: 'stay', hp: 1, low: false, radius: 0.36 },
};

export function enemyRadius(type: EnemyType): number { return ENEMY_DEF[type].radius; }

export interface Enemy {
  id: number;
  active: boolean;
  type: EnemyType;
  lifecycle: Lifecycle;
  phase: 'approach' | 'ring' | 'orbit' | 'passing';
  hp: number;
  x: number; y: number;
  prevX: number; prevY: number;
  dirX: number; dirY: number;   // 통과형 진행 방향 (단위벡터, 하단→상방)
  originX: number; originY: number; // 경로 기준점 (스폰 위치)
  pathS: number;                // 경로상 진행 거리 (wu)
  pathTotal: number;            // 스폰 → 겨냥점까지의 경로 길이 (지그재그 감쇠 기준)
  entryAngleDeg: number;        // 진입각 (수직 기준, 리포트/디버그용)
  ringChordWu: number;          // 링 진입 시 계산한 현(chord) 길이 — 체류 시간 규칙의 분자
  lateralPhase: number;         // a-2 지그재그 위상
  waveIndex: number;
  // 체류형
  slot: number;                 // 배치 슬롯 (0..stayCap-1) — 배치각 분산의 기준
  slotAngle: number;            // 슬롯 기준 각 (rad) — 공통 선회에 얹히는 고정 위상
  orbitAngle: number;           // 현재 선회각 (rad)
  orbitDir: number;
  entryOffset: number;          // 도착각 → 슬롯각 정착용 오프셋 (선회 진입 보간)
  orbitBlend: number;           // 0..1 정착 진행률
  attackProgress: number;       // 0..1, 주기 정규화 (주기가 속도에 따라 변해도 연속)
  telegraphing: boolean;
  exposeTimer: number;          // a-5: >0 이면 링 안 노출(피격 가능)
  armorBroken: boolean;         // a-4: 1타 후 장갑 파괴
  // 판정
  lastCountedHitMs: number;
}

export interface Projectile {
  id: number;
  active: boolean;
  x: number; y: number;
  prevX: number; prevY: number;
  vx: number; vy: number;
}

export type SimEvent =
  | { type: 'ringEnter'; enemyId: number }
  | { type: 'slashHit'; enemyId: number; killed: boolean; x: number; y: number }
  | { type: 'armorBreak'; enemyId: number }
  | { type: 'projectileDown'; x: number; y: number }
  | { type: 'playerHit'; hp: number }
  | { type: 'enemyPassed'; enemyId: number }
  | { type: 'attackTelegraph'; enemyId: number }
  | { type: 'diveStart' } | { type: 'diveEnd' }
  | { type: 'waveStart'; index: number; name: string }
  | { type: 'gaugeFull' }
  | { type: 'toggle'; open: boolean }
  | { type: 'clear' } | { type: 'fail' };

export interface WaveEntry { t: number; type: EnemyType; formationCount?: number }
export interface Wave { name: string; restAfterSec: number; entries: WaveEntry[] }
export interface WavePlan { waves: Wave[] }

export type GameState = 'playing' | 'rest' | 'clear' | 'fail';

const FORMATION_SPACING = 0.52; // a-3 편대 간격 (wu) — 긴 스와이프 1회로 관통 가능해야 함
const A5_EDGE_R = 1.18;         // a-5 대기 위치 (링 가장자리 바깥 — 노출 시에만 피격 가능)
const A5_EXPOSE_R = 0.78;
const A4_ORBIT_R = 0.80;        // a-4 선회 반경 (×링 반경)
const FAIL_RESTART_DELAY = 1.2; // 실패 연출 후 재시작 (기획서 "즉시 재시작" — 가독성용 지연, 리포트 기록)
const ZIGZAG_AMP_WU = 0.75;     // a-2 지그재그 진폭 (연출 상수)
const ZIGZAG_FREQ = 1.35;       // a-2 지그재그 파수 (rad/wu — 진행 거리 기준)
const ZIGZAG_DAMP_WU = 2.2;     // 겨냥점 앞 이 거리부터 진폭 감쇠 (링 내 직선화)
const STAY_SETTLE_SEC = 0.4;    // 체류형이 도착 지점에서 슬롯 각으로 정착하는 시간

/** 각도를 -π..π로 정규화 */
function shortestAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export class Sim {
  readonly plane = new Plane2D();
  readonly events: SimEvent[] = [];
  private rng: Rng;
  private plan: WavePlan;
  private seed: number;

  // 플레이어
  time = 0;
  state: GameState = 'playing';
  speed = 1.0;
  umbrellaOpen = false; // 시작: 접음(가속)
  hp = config.maxHp;
  invulnTimer = 0;
  toggleLockTimer = 0;
  gauge = 0;
  gaugeFullAt: number | null = null;
  combo = 0;
  private comboHoldAccum = 0;
  score = 0;
  girlX = 0; girlY = 0;
  girlPrevX = 0; girlPrevY = 0;
  private freezeTimer = 0; // 히트스톱
  private failTimer = 0;
  /** 배경 스크롤 누적 거리 (wu) — 렌더러의 레이어 스크롤 기준 */
  scrollDistance = 0;
  /** 셰이크 트리거 (렌더 전용 충격량) */
  shakeImpulse = 0;

  // 도약
  diveActive = false;
  private diveTimer = 0;
  private diveKillCooldown = 0;
  private diveTargetX = 0; private diveTargetY = 0;
  private returnTimer = 0;
  diveCount = 0;

  // 적
  private enemyPool: Enemy[] = [];
  private projectilePool: Projectile[] = [];
  private nextId = 1;
  private pendingStay: { type: EnemyType; waveIndex: number }[] = [];
  private stayRotation = 0;

  // 웨이브
  waveIndex = -1;
  private waveTime = 0;
  private spawnCursor = 0;
  private restTimer = 0;

  // 통계
  kills = 0;
  passedCount = 0;
  hitsTaken = 0;
  ringEnterCount = 0;
  peakActiveEnemies = 0;
  strayCount = 0;       // 링을 스치지 못하고 프레임 아웃한 통과형 (도약 중 소녀 이동 등)
  swipeMissCount = 0;   // 링 내 적이 있는데 0히트 = 베기 미스 (콤보 리셋 — M1 검수 확정)
  emptySwipeCount = 0;  // 링 내 적 없음 = 견제성 스와이프 (무벌점)
  multIntegral = 0;
  private multTimeAccum = 0;
  private swipeSawRingTarget = false;
  swipeHitFlags: boolean[] = [];
  restartCount = 0;

  constructor(plan: WavePlan, seed = 20260821) {
    this.plan = plan;
    this.seed = seed;
    this.rng = new Rng(seed);
    for (let i = 0; i < 64; i++) this.enemyPool.push(this.makeEnemy());
    for (let i = 0; i < 16; i++) {
      this.projectilePool.push({ id: 0, active: false, x: 0, y: 0, prevX: 0, prevY: 0, vx: 0, vy: 0 });
    }
    this.startWave(0);
  }

  private makeEnemy(): Enemy {
    return {
      id: 0, active: false, type: 'a-1', lifecycle: 'pass', phase: 'approach', hp: 1,
      x: 0, y: 0, prevX: 0, prevY: 0, dirX: 0, dirY: 1, originX: 0, originY: 0, pathS: 0, pathTotal: 1,
      entryAngleDeg: 0, ringChordWu: 0,
      lateralPhase: 0, waveIndex: 0, slot: 0, slotAngle: 0, orbitAngle: 0, orbitDir: 1,
      entryOffset: 0, orbitBlend: 0,
      attackProgress: 0, telegraphing: false, exposeTimer: 0, armorBroken: false, lastCountedHitMs: -1e9,
    };
  }

  get enemies(): readonly Enemy[] { return this.enemyPool; }
  get projectiles(): readonly Projectile[] { return this.projectilePool; }
  get multiplier(): number {
    return this.speed + (this.combo >= config.comboBonusAt ? config.comboBonusMultiplier : 0);
  }
  get avgMultiplier(): number { return this.multTimeAccum > 0 ? this.multIntegral / this.multTimeAccum : 0; }
  get stance(): Stance { return this.umbrellaOpen ? 'sword' : 'umbrella'; }
  /** 카메라 줌아웃 (기획서 v2 4장). 판정 투영과 렌더러가 같은 값을 쓴다. */
  get zoomOut(): number { return this.diveActive ? config.zoomMax : zoomForSpeed(this.speed); }
  get currentWaveName(): string { return this.plan.waves[this.waveIndex]?.name ?? ''; }
  get waveCount(): number { return this.plan.waves.length; }
  activeEnemyCount(): number { return this.enemyPool.filter(e => e.active).length; }
  activeStayCount(): number {
    return this.enemyPool.filter(e => e.active && e.lifecycle === 'stay' && e.phase === 'orbit').length;
  }
  /** 현재 링 안에서 벨 수 있는 적 수 (베기 미스 판정·혼잡도 통계) */
  hittableInRingCount(): number {
    let n = 0;
    for (const e of this.enemyPool) if (e.active && this.isHittable(e)) n++;
    return n;
  }

  /** 전판 재시작 (실패 시 자동 호출, 자원 100% 소실 = 게이지·점수 리셋) */
  restart(): void {
    this.time = 0; this.state = 'playing';
    this.speed = config.speedMin; this.umbrellaOpen = false;
    this.hp = config.maxHp; this.invulnTimer = 0; this.toggleLockTimer = 0;
    this.gauge = 0; this.gaugeFullAt = null;
    this.combo = 0; this.comboHoldAccum = 0; this.score = 0;
    this.girlX = 0; this.girlY = 0; this.girlPrevX = 0; this.girlPrevY = 0;
    this.freezeTimer = 0; this.failTimer = 0;
    this.diveActive = false; this.diveTimer = 0; this.returnTimer = 0; this.diveCount = 0;
    this.scrollDistance = 0; this.shakeImpulse = 0; this.stayRotation = 0;
    for (const e of this.enemyPool) e.active = false;
    for (const p of this.projectilePool) p.active = false;
    this.pendingStay.length = 0;
    this.kills = 0; this.passedCount = 0; this.hitsTaken = 0;
    this.ringEnterCount = 0; this.peakActiveEnemies = 0; this.strayCount = 0;
    this.swipeMissCount = 0; this.emptySwipeCount = 0;
    this.multIntegral = 0; this.multTimeAccum = 0;
    this.swipeSawRingTarget = false;
    this.rng = new Rng(this.seed + this.restartCount * 7919);
    this.restartCount++;
    this.startWave(0);
  }

  // ─────────────────────────── 입력 API (main.ts의 분류기가 호출) ───────────────────────────

  /** 탭 = 우산 펼치기/접기 토글 */
  toggleUmbrella(): boolean {
    if (this.state !== 'playing' && this.state !== 'rest') return false;
    if (this.diveActive || this.toggleLockTimer > 0) return false;
    this.umbrellaOpen = !this.umbrellaOpen;
    this.events.push({ type: 'toggle', open: this.umbrellaOpen });
    return true;
  }

  /**
   * 스와이프 궤적 선분 1개 판정 (move 이벤트마다 증분 호출 — 손을 떼기 전에 벤다).
   * 화면 좌표는 CSS px. 반환값 = 이번 선분의 히트 수.
   * 기획서 v2 5장: 화면 좌표 선분 vs 링 내 적 스프라이트 원형 히트박스 교차.
   */
  applySwipeSegment(ax: number, ay: number, bx: number, by: number, nowMs: number): number {
    if (this.state !== 'playing' && this.state !== 'rest') return 0;
    if (this.diveActive) return 0; // 도약 중 자동 진행 (조작 불요)
    const stance = this.stance;
    const width = stance === 'umbrella' ? config.umbrellaTrajWidthPt : config.swordTrajWidthPt;
    const rejudge = stance === 'umbrella' ? config.umbrellaRejudgeMs : config.swordRejudgeMs;
    let hits = 0;

    for (const e of this.enemyPool) {
      if (!e.active || !this.isHittable(e)) continue;
      this.swipeSawRingTarget = true; // 링 안에 벨 대상이 있었다 → 0히트면 "헛스윙"
      if (nowMs - e.lastCountedHitMs < rejudge) continue;
      const p = this.plane.toScreen(e.x, e.y);
      const r = this.plane.radiusToPx(ENEMY_DEF[e.type].radius) + width;
      if (segmentIntersectsCircle(ax, ay, bx, by, p.x, p.y, r)) {
        e.lastCountedHitMs = nowMs;
        this.damageEnemy(e);
        hits++;
      }
    }
    for (const pr of this.projectilePool) {
      if (!pr.active) continue;
      const p = this.plane.toScreen(pr.x, pr.y);
      const r = this.plane.radiusToPx(0.18) + width;
      if (segmentIntersectsCircle(ax, ay, bx, by, p.x, p.y, r)) {
        pr.active = false;
        this.score += Math.round(config.scoreProjectile * this.multiplier);
        this.events.push({ type: 'projectileDown', x: pr.x, y: pr.y });
        hits++;
      }
    }
    return hits;
  }

  /**
   * 스와이프 종료.
   * 베기 미스 = **링 내에 적이 있을 때의 헛스윙만** (M1 검수 질문 3 확정 — 기획서 7장 주석).
   * 빈 화면 스와이프(견제성)는 무벌점.
   */
  endSwipe(totalHits: number): void {
    const sawTarget = this.swipeSawRingTarget;
    this.swipeSawRingTarget = false;
    this.swipeHitFlags.push(totalHits > 0);
    if (totalHits > 0) return;
    if (sawTarget) {
      this.swipeMissCount++;
      if (!this.diveActive && this.state === 'playing') this.combo = 0;
    } else {
      this.emptySwipeCount++;
    }
  }

  /** 도약 버튼 — 게이지 100% 시 발동 */
  tryDive(): boolean {
    if (this.state !== 'playing' && this.state !== 'rest') return false;
    if (this.diveActive || this.gauge < 1) return false;
    this.gauge = 0;
    this.diveActive = true;
    this.diveCount++;
    this.diveTimer = config.diveDurationSec;
    this.diveKillCooldown = 0;
    this.retargetDive();
    this.shakeImpulse = 1;
    this.events.push({ type: 'diveStart' });
    return true;
  }

  private isHittable(e: Enemy): boolean {
    if (e.lifecycle === 'pass') return e.phase === 'ring';
    if (e.phase !== 'orbit') return false;
    if (e.type === 'a-5') return e.exposeTimer > 0; // 링 가장자리 대기 중엔 판정 밖
    return true;
  }

  private damageEnemy(e: Enemy): void {
    // 체류형: 공격 예고 중 베면 공격 저지 (기획서 10.0)
    if (e.lifecycle === 'stay' && e.telegraphing) {
      e.attackProgress = 0;
      e.telegraphing = false;
    }
    e.hp--;
    const killed = e.hp <= 0;
    if (!killed && e.type === 'a-4' && !e.armorBroken) {
      e.armorBroken = true;
      this.events.push({ type: 'armorBreak', enemyId: e.id });
    }
    this.events.push({ type: 'slashHit', enemyId: e.id, killed, x: e.x, y: e.y });
    if (killed) this.killEnemy(e, false);
  }

  private killEnemy(e: Enemy, inDive: boolean): void {
    e.active = false;
    this.kills++;
    const def = ENEMY_DEF[e.type];
    const mult = this.multiplier;
    // 깃털: 하급만, 도약 중 미지급 (기획서 8장).
    // 배율 곱 적용 여부는 A/B 토글 (기획서 v2 7장 미결 항목 — 기본 OFF = HQ 권장안 (b)).
    if (def.low && !inDive) {
      const gaugeMult = config.gaugeMultiplierEnabled ? mult : 1;
      this.gauge = Math.min(1, this.gauge + config.gaugePerLowKill * gaugeMult);
      if (this.gauge >= 1 && this.gaugeFullAt === null) {
        this.gaugeFullAt = this.time;
        this.events.push({ type: 'gaugeFull' });
      }
    }
    this.score += Math.round((def.low ? config.scoreLow : config.scoreMid) * mult);
    this.freezeTimer = Math.max(this.freezeTimer, config.hitstopMs / 1000); // 히트스톱 (기획서 16장 1)
    this.shakeImpulse = Math.max(this.shakeImpulse, 0.45);
  }

  private damagePlayer(dmg: number): void {
    if (this.invulnTimer > 0 || this.diveActive) return;
    if (this.state !== 'playing' && this.state !== 'rest') return;
    this.hp -= dmg;
    this.invulnTimer = config.invulnSec;
    this.combo = 0;
    this.comboHoldAccum = 0;
    this.hitsTaken++;
    this.shakeImpulse = 1;
    this.events.push({ type: 'playerHit', hp: this.hp });
    if (this.hp <= 0) {
      this.state = 'fail';
      this.failTimer = FAIL_RESTART_DELAY;
      this.events.push({ type: 'fail' });
    }
  }

  // ─────────────────────────── 시뮬레이션 스텝 ───────────────────────────

  step(dt: number): void {
    // 히트스톱: 시뮬레이션 정지 (렌더는 계속)
    if (this.freezeTimer > 0) {
      this.freezeTimer -= dt;
      return;
    }
    if (this.state === 'fail') {
      this.failTimer -= dt;
      if (this.failTimer <= 0) this.restart(); // 즉시 재시작 (기획서 9장)
      return;
    }
    if (this.state === 'clear') return;

    // 렌더 보간용 이전 위치 스냅샷
    this.girlPrevX = this.girlX; this.girlPrevY = this.girlY;
    for (const e of this.enemyPool) if (e.active) { e.prevX = e.x; e.prevY = e.y; }
    for (const p of this.projectilePool) if (p.active) { p.prevX = p.x; p.prevY = p.y; }

    this.time += dt;
    this.plane.worldHeightWu = config.worldHeightWu;
    this.plane.girlScreenYPct = config.girlScreenYPct;
    this.plane.zoomOut = this.zoomOut;

    // 타이머
    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.toggleLockTimer > 0) this.toggleLockTimer -= dt;
    if (this.shakeImpulse > 0) this.shakeImpulse = Math.max(0, this.shakeImpulse - dt * 3.5);

    // 낙하 속도 다이얼 (기획서 7장) — 도약 중에는 속도계 정지
    if (!this.diveActive) {
      if (this.umbrellaOpen) this.speed -= config.decelPerSec * dt;
      else this.speed += config.accelPerSec * dt;
      this.speed = Math.max(config.speedMin, Math.min(config.speedMax, this.speed));
    }

    // 배경 스크롤 누적 (기획서 v2 4장: 낙하 = 배경의 상방 스크롤)
    this.scrollDistance += config.approachBaseWu * config.scrollSpeedCoef * this.speed * (this.diveActive ? 2.2 : 1) * dt;

    // 최고속 콤보: 3.0x 유지 1초당 +1 (리셋은 피격/베기 미스 시 — 기획서 7장 문언 그대로)
    if (!this.diveActive && this.speed >= config.speedMax - 1e-9) {
      this.comboHoldAccum += dt;
      while (this.comboHoldAccum >= 1) {
        this.comboHoldAccum -= 1;
        this.combo++;
      }
    }

    // 배율 시간가중 평균 (리포트용)
    this.multIntegral += this.multiplier * dt;
    this.multTimeAccum += dt;

    this.stayRotation += config.stayOrbitSpeed * dt;

    this.updateWaves(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    if (this.diveActive) this.updateDive(dt);
    else if (this.returnTimer > 0) {
      // 도약 종료 후 홈 위치 복귀 보간
      this.returnTimer -= dt;
      const k = Math.max(0, this.returnTimer / 0.4);
      this.girlX *= k; this.girlY *= k;
    }

    const active = this.activeEnemyCount();
    if (active > this.peakActiveEnemies) this.peakActiveEnemies = active;
  }

  // ─────────────────────────── 웨이브 ───────────────────────────

  private startWave(i: number): void {
    this.waveIndex = i;
    this.waveTime = 0;
    this.spawnCursor = 0;
    if (this.state !== 'fail') this.state = 'playing';
    this.events.push({ type: 'waveStart', index: i, name: this.plan.waves[i].name });
  }

  private updateWaves(dt: number): void {
    if (this.state === 'rest') {
      this.restTimer -= dt;
      if (this.restTimer <= 0) this.startWave(this.waveIndex + 1);
      return;
    }
    const wave = this.plan.waves[this.waveIndex];
    if (!wave) return;
    this.waveTime += dt;

    // 스폰 (spawnDensityScale: 튜닝 패널 — 엔트리 시각 배수)
    while (this.spawnCursor < wave.entries.length &&
           wave.entries[this.spawnCursor].t * config.spawnDensityScale <= this.waveTime) {
      const entry = wave.entries[this.spawnCursor++];
      this.spawnEntry(entry);
    }

    // 체류형 대기열 방출 (상한 4기 — 기획서 10.0)
    while (this.pendingStay.length > 0 && this.activeStayCount() < config.stayCap) {
      const p = this.pendingStay.shift()!;
      this.spawnEnemy(p.type, undefined, p.waveIndex);
    }

    // 웨이브 종료: 전 엔트리 스폰 완료 + 활성 적 0 + 대기열 0
    if (this.spawnCursor >= wave.entries.length && this.activeEnemyCount() === 0 && this.pendingStay.length === 0) {
      if (this.waveIndex >= this.plan.waves.length - 1) {
        this.state = 'clear'; // 최종 웨이브 격퇴 = 클리어 (P1: 중간 보스 범위 외)
        this.events.push({ type: 'clear' });
      } else {
        this.state = 'rest'; // 휴지기 2~3초 (기획서 11.3)
        this.restTimer = wave.restAfterSec;
      }
    }
  }

  private spawnEntry(entry: WaveEntry): void {
    if (entry.type === 'a-3') {
      // 밀집 편대: 진행 방향에 수직인 가로 열 — 긴 스와이프 1회로 다수 격파 (기획서 10.1)
      const n = entry.formationCount ?? this.rng.int(5, 8);
      const angle = this.rng.range(-1, 1) * config.entryAngleMaxDeg * Math.PI / 180;
      const aimX = this.rng.range(-0.4, 0.4) * config.ringRadiusWu;
      const aimY = this.rng.range(-0.3, 0.3) * config.ringRadiusWu;
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * FORMATION_SPACING;
        this.spawnEnemy('a-3', { angle, aimX, aimY, lateralOffset: off }, this.waveIndex);
      }
      return;
    }
    const def = ENEMY_DEF[entry.type];
    if (def.lifecycle === 'stay' && this.activeStayCount() >= config.stayCap) {
      this.pendingStay.push({ type: entry.type, waveIndex: this.waveIndex });
      return;
    }
    this.spawnEnemy(entry.type, undefined, this.waveIndex);
  }

  /** 비어 있는 체류형 슬롯 (배치각 분산 — 검증 항목 5) */
  private takeStaySlot(): number {
    const used = new Set<number>();
    for (const e of this.enemyPool) {
      if (e.active && e.lifecycle === 'stay' && e.phase !== 'passing') used.add(e.slot);
    }
    for (let i = 0; i < config.stayCap; i++) if (!used.has(i)) return i;
    return 0;
  }

  /** 슬롯 → 기준 배치각. 화면 상방(+90°)을 중심으로 배치각(부채각)만큼 벌린다 (하단 진입 레인 확보) */
  private slotBaseAngle(slot: number): number {
    const n = Math.max(1, config.stayCap);
    const arc = (config.stayArcDeg * Math.PI) / 180;
    const t = n === 1 ? 0 : slot / (n - 1) - 0.5;
    return Math.PI / 2 + t * arc;
  }

  private spawnEnemy(
    type: EnemyType,
    formation: { angle: number; aimX: number; aimY: number; lateralOffset: number } | undefined,
    waveIndex: number,
  ): void {
    const e = this.enemyPool.find(en => !en.active) ?? this.enemyPool[this.enemyPool.length - 1];
    const def = ENEMY_DEF[type];
    e.id = this.nextId++;
    e.active = true;
    e.type = type;
    e.lifecycle = def.lifecycle;
    e.phase = 'approach';
    e.hp = def.hp;

    // 진입각: 정하방(0°) ~ 사선 하단(±entryAngleMaxDeg) — 기획서 v2 4장 "화면 하단(±측면 하단)"
    const maxRad = (config.entryAngleMaxDeg * Math.PI) / 180;
    const angle = formation ? formation.angle : this.rng.range(-1, 1) * maxRad;
    e.entryAngleDeg = (angle * 180) / Math.PI;
    e.dirX = Math.sin(angle);
    e.dirY = Math.cos(angle);

    // 겨냥점: 링 안쪽 (통과형은 링을 스치고, 체류형은 링 주변에 도달)
    const aimSpread = config.ringRadiusWu * 0.55;
    const aimX = formation ? formation.aimX : this.rng.range(-aimSpread, aimSpread);
    const aimY = formation ? formation.aimY : this.rng.range(-aimSpread, aimSpread) * 0.6;

    // 스폰점 = 겨냥점에서 진행 방향 반대로 역추적해 화면 하단 밖(y = -spawnDepth)에 놓는다
    const L = (aimY + config.spawnDepthWu) / Math.max(0.2, e.dirY);
    e.originX = aimX - e.dirX * L;
    e.originY = aimY - e.dirY * L;
    if (formation) {
      // 편대는 진행 방향에 수직으로 오프셋 (평행 궤적)
      e.originX += -e.dirY * formation.lateralOffset;
      e.originY += e.dirX * formation.lateralOffset;
    }
    e.pathS = 0;
    e.pathTotal = L;
    e.lateralPhase = this.rng.range(0, Math.PI * 2);
    e.ringChordWu = 0;
    this.applyPath(e);
    e.prevX = e.x; e.prevY = e.y;
    e.waveIndex = waveIndex;
    e.slot = def.lifecycle === 'stay' ? this.takeStaySlot() : 0;
    e.slotAngle = this.slotBaseAngle(e.slot);
    e.orbitAngle = e.slotAngle;
    e.orbitDir = 1;
    e.entryOffset = 0;
    e.orbitBlend = 0;
    e.attackProgress = 0;
    e.telegraphing = false;
    e.exposeTimer = 0;
    e.armorBroken = false;
    e.lastCountedHitMs = -1e9;
  }

  // ─────────────────────────── 적 갱신 ───────────────────────────

  private updateEnemies(dt: number): void {
    const R = config.ringRadiusWu;
    const frameOutY = this.plane.aboveWu() + 1.2;
    for (const e of this.enemyPool) {
      if (!e.active) continue;

      if (e.phase === 'approach') {
        const step = config.approachBaseWu * this.speed * dt;
        if (e.lifecycle === 'stay') {
          // 체류형은 링 주변에 "도달"해야 하므로 소녀를 향해 유도한다 (도약으로 소녀가 이동해도 성립)
          const tx = this.girlX - e.x, ty = this.girlY - e.y;
          const td = Math.hypot(tx, ty) || 1;
          e.x += (tx / td) * step;
          e.y += (ty / td) * step;
        } else {
          this.advanceAlongPath(e, step);
        }
        const d = Math.hypot(e.x - this.girlX, e.y - this.girlY);
        if (e.lifecycle === 'pass') {
          if (e.y > frameOutY) {
            // 링을 스치지 못하고 화면 밖으로 (도약 중 소녀 이동 등) — 피해 없이 소멸
            e.active = false;
            this.strayCount++;
            continue;
          }
          if (d <= R) {
            e.phase = 'ring';
            e.ringChordWu = this.chordLength(e, R);
            this.ringEnterCount++;
            this.events.push({ type: 'ringEnter', enemyId: e.id });
          }
        } else {
          const orbitR = this.stayOrbitRadius(e);
          if (d <= orbitR + 0.05) {
            e.phase = 'orbit';
            e.attackProgress = 0;
            // 도착 각에서 슬롯 각으로 0.4초에 걸쳐 정착 (선회 진입). 슬롯 간 각 간격은 항상 유지된다.
            const arrival = Math.atan2(e.y - this.girlY, e.x - this.girlX);
            e.slotAngle = this.slotBaseAngle(e.slot);
            e.entryOffset = shortestAngle(arrival - (e.slotAngle + this.stayRotation));
            e.orbitBlend = 0;
            e.orbitAngle = arrival;
            this.ringEnterCount++;
            this.events.push({ type: 'ringEnter', enemyId: e.id });
          }
        }
      } else if (e.phase === 'ring') {
        // 링 통과: 실제 체류 시간이 dwellTime(v)와 같아지도록 현(chord) 길이로 속도를 역산
        // (기획서 7장 "통과형 적의 링 체류 시간" 선형 규칙 + 12.1 링 반경-체류시간 등가)
        const v = e.ringChordWu / Math.max(0.05, dwellTime(this.speed));
        this.advanceAlongPath(e, v * dt);
        if (Math.hypot(e.x - this.girlX, e.y - this.girlY) > R) {
          e.phase = 'passing';
          this.passedCount++;
          this.damagePlayer(config.contactDamage); // 미처치 통과 = 접촉 1 (기획서 10.0)
          this.events.push({ type: 'enemyPassed', enemyId: e.id });
        }
      } else if (e.phase === 'passing') {
        // 링 통과 후에는 벨 수 없다 (M1 검수 질문 5 확정) — 상단으로 프레임 아웃
        this.advanceAlongPath(e, config.approachBaseWu * this.speed * 1.35 * dt);
        if (e.y > frameOutY) e.active = false;
      } else if (e.phase === 'orbit') {
        this.updateStayEnemy(e, dt);
      }
    }
  }

  /** 경로 진행 (진행 거리 pathS 갱신 후 위치 재계산) */
  private advanceAlongPath(e: Enemy, dist: number): void {
    e.pathS += dist;
    this.applyPath(e);
  }

  /**
   * 경로 기준점 + 진행 거리 → 위치. a-2는 진행 방향에 수직인 사인 진동(지그재그)을 얹는다.
   * 진동을 시간이 아닌 "진행 거리"의 함수로 두어 낙하 속도가 변해도 궤적 모양이 유지된다.
   */
  private applyPath(e: Enemy): void {
    // 겨냥점(링)에 가까워질수록 진폭을 죽인다 — 링 안에서는 직선 = 체류 시간 규칙이 정확히 성립
    const remain = Math.max(0, e.pathTotal - e.pathS);
    const damp = Math.max(0, Math.min(1, (remain - ZIGZAG_DAMP_WU) / ZIGZAG_DAMP_WU));
    const lateral = e.type === 'a-2'
      ? Math.sin(e.pathS * ZIGZAG_FREQ + e.lateralPhase) * ZIGZAG_AMP_WU * damp
      : 0;
    e.x = e.originX + e.dirX * e.pathS - e.dirY * lateral;
    e.y = e.originY + e.dirY * e.pathS + e.dirX * lateral;
  }

  /** 링(반경 R, 중심 = 소녀)을 직선 경로가 지나는 현의 길이 */
  private chordLength(e: Enemy, R: number): number {
    const rx = this.girlX - e.x, ry = this.girlY - e.y;
    const perp = Math.abs(rx * e.dirY - ry * e.dirX); // |cross(r, dir)| = 중심까지의 수직 거리
    return 2 * Math.sqrt(Math.max(0.01, R * R - perp * perp));
  }

  private stayOrbitRadius(e: Enemy): number {
    const base = e.type === 'a-4' ? A4_ORBIT_R : (e.exposeTimer > 0 ? A5_EXPOSE_R : A5_EDGE_R);
    return config.ringRadiusWu * base * config.stayOrbitRadiusScale;
  }

  private updateStayEnemy(e: Enemy, dt: number): void {
    // 슬롯 각 + 공통 선회 (같은 방향·같은 각속도로 돌아 슬롯 간 배치각이 유지된다 — 검증 항목 5)
    if (e.orbitBlend < 1) e.orbitBlend = Math.min(1, e.orbitBlend + dt / STAY_SETTLE_SEC);
    const settle = 1 - Math.pow(1 - e.orbitBlend, 2); // ease-out
    e.orbitAngle = e.slotAngle + this.stayRotation * e.orbitDir + e.entryOffset * (1 - settle);
    const r = this.stayOrbitRadius(e);
    if (e.type === 'a-5' && e.exposeTimer > 0) e.exposeTimer -= dt;
    e.x = this.girlX + Math.cos(e.orbitAngle) * r;
    e.y = this.girlY + Math.sin(e.orbitAngle) * r;

    // 공격 주기 (속도 비례 단축, 정규화 진행률로 연속성 유지)
    const period = attackPeriod(this.speed);
    e.attackProgress += dt / period;
    const remaining = (1 - e.attackProgress) * period;
    const wasTelegraphing = e.telegraphing;
    e.telegraphing = remaining <= config.telegraphSec && e.attackProgress < 1;
    if (e.telegraphing && !wasTelegraphing) this.events.push({ type: 'attackTelegraph', enemyId: e.id });

    if (e.attackProgress >= 1) {
      e.attackProgress = 0;
      e.telegraphing = false;
      if (e.type === 'a-4') {
        this.damagePlayer(config.contactDamage); // 근접 공격 적중 1 (기획서 9장)
      } else {
        this.fireProjectile(e);
        e.exposeTimer = config.a5ExposeSec;
      }
    }
  }

  private fireProjectile(e: Enemy): void {
    const p = this.projectilePool.find(pr => !pr.active);
    if (!p) return;
    p.id = this.nextId++;
    p.active = true;
    p.x = e.x; p.y = e.y;
    p.prevX = p.x; p.prevY = p.y;
    const dx = this.girlX - e.x, dy = this.girlY - e.y;
    const d = Math.hypot(dx, dy) || 1;
    p.vx = (dx / d) * config.projectileSpeedWu;
    p.vy = (dy / d) * config.projectileSpeedWu;
  }

  private updateProjectiles(dt: number): void {
    for (const p of this.projectilePool) {
      if (!p.active) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const d = Math.hypot(p.x - this.girlX, p.y - this.girlY);
      if (d < 0.3) {
        p.active = false;
        this.damagePlayer(config.contactDamage); // 투사체 피격 1 (기획서 9장)
      } else if (d > config.ringRadiusWu * 4) {
        p.active = false;
      }
    }
  }

  // ─────────────────────────── 도약 ───────────────────────────

  /** 현재 활성 적이 가장 밀집한 방향 탐색 (기획서 8장 자동 경로) */
  private retargetDive(): void {
    const act = this.enemyPool.filter(e => e.active && e.phase !== 'passing');
    if (act.length === 0) {
      // 잔적 없음 → 하방 직진 (M1 검수 질문 8 확정)
      this.diveTargetX = this.girlX;
      this.diveTargetY = -this.plane.belowWu() * 0.55;
      return;
    }
    const R2 = (config.ringRadiusWu * 1.9) ** 2;
    let best: Enemy = act[0], bestScore = -1;
    for (const e of act) {
      let n = 0;
      for (const o of act) {
        if ((e.x - o.x) ** 2 + (e.y - o.y) ** 2 < R2) n++;
      }
      if (n > bestScore) { bestScore = n; best = e; }
    }
    let cx = 0, cy = 0, cn = 0;
    for (const o of act) {
      if ((best.x - o.x) ** 2 + (best.y - o.y) ** 2 < R2) { cx += o.x; cy += o.y; cn++; }
    }
    // 화면 밖으로 나가지 않도록 클램프 (고정 카메라 = 화면 내 비행, 기획서 8장)
    const hw = this.plane.halfWidthWu() - config.ringRadiusWu * 0.5;
    const up = this.plane.aboveWu() - config.ringRadiusWu * 0.6;
    const down = this.plane.belowWu() - config.ringRadiusWu * 0.6;
    this.diveTargetX = Math.max(-hw, Math.min(hw, cx / cn));
    this.diveTargetY = Math.max(-down, Math.min(up, cy / cn));
  }

  private updateDive(dt: number): void {
    this.diveTimer -= dt;
    this.diveKillCooldown -= dt;
    this.retargetDive();

    const dx = this.diveTargetX - this.girlX;
    const dy = this.diveTargetY - this.girlY;
    const d = Math.hypot(dx, dy);
    if (d > 0.05) {
      const v = Math.min(config.diveSpeedWu * dt, d);
      this.girlX += (dx / d) * v;
      this.girlY += (dy / d) * v;
    }

    // 판정 링에 들어온 적 순차 자동 격파 (기획서 8장)
    if (this.diveKillCooldown <= 0) {
      let nearest: Enemy | null = null;
      let nd = Infinity;
      for (const e of this.enemyPool) {
        if (!e.active || e.phase === 'passing') continue;
        const dd = Math.hypot(e.x - this.girlX, e.y - this.girlY);
        if (dd <= config.ringRadiusWu && dd < nd) { nd = dd; nearest = e; }
      }
      if (nearest) {
        this.events.push({ type: 'slashHit', enemyId: nearest.id, killed: true, x: nearest.x, y: nearest.y });
        this.killEnemy(nearest, true); // 도약 중 깃털 미지급
        this.diveKillCooldown = config.diveKillStaggerSec;
      }
    }

    if (this.diveTimer <= 0) {
      this.diveActive = false;
      this.speed = config.diveEndSpeed;                 // 3.0x 강제 복귀 (기획서 8장)
      this.toggleLockTimer = config.diveToggleLockSec;  // 1초 토글 잠금
      this.returnTimer = 0.4;
      this.shakeImpulse = 0.8;
      this.events.push({ type: 'diveEnd' });
    }
  }
}
