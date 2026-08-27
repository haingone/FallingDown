/**
 * FallingDown P1 시뮬레이션 (HD-2D 다운 스크롤) — 순수 TS, three.js/DOM 미의존.
 * M1의 코어 규칙(속도 다이얼·게이지·도약·생애주기·HP·콤보·웨이브)을 그대로 이월하고,
 * 좌표·동선·판정만 2D 평면으로 교체했다 (기획서 v2 4장·10.0장).
 *
 * 좌표계는 core/field.ts 참조 (1.0 = 화면 폭, y+ = 위).
 * 적은 화면 하단(정하방/사선)에서 진입 → 상승 → 판정 링 통과 → 상단 프레임 아웃.
 */
import { config, dwellTime, attackPeriod, zoomForSpeed } from './balance';
import { Field, segmentIntersectsCircle, distanceToExit } from './field';
import { Rng } from './rng';

export type EnemyType = 'a-1' | 'a-2' | 'a-3' | 'a-4' | 'a-5';
export type Lifecycle = 'pass' | 'stay';
export type Stance = 'umbrella' | 'sword'; // 접음=우산, 펼침=검 (기획서 v2 5장)
export type EnemyPhase = 'approach' | 'ring' | 'passing' | 'orbit';

/** 적 정의 — hitRadius는 스프라이트 원형 히트박스 (필드 단위) */
const ENEMY_DEF: Record<EnemyType, { lifecycle: Lifecycle; low: boolean; hitRadius: number }> = {
  'a-1': { lifecycle: 'pass', low: true, hitRadius: 0.055 },
  'a-2': { lifecycle: 'pass', low: true, hitRadius: 0.055 },
  'a-3': { lifecycle: 'pass', low: true, hitRadius: 0.046 },
  'a-4': { lifecycle: 'stay', low: false, hitRadius: 0.066 },
  'a-5': { lifecycle: 'stay', low: false, hitRadius: 0.066 },
};

export function enemyHitRadius(type: EnemyType): number {
  return ENEMY_DEF[type].hitRadius;
}
export function enemyLifecycle(type: EnemyType): Lifecycle {
  return ENEMY_DEF[type].lifecycle;
}

export interface Enemy {
  id: number;
  active: boolean;
  type: EnemyType;
  lifecycle: Lifecycle;
  phase: EnemyPhase;
  hp: number;
  x: number; y: number;
  prevX: number; prevY: number; // 렌더 보간용
  dirX: number; dirY: number;   // 진행 방향 (정규화)
  zigzagSeed: number;
  zigzagOffset: number;         // 현재 적용된 지그재그 가로 오프셋
  // 통과형 링 판정
  ringPathLen: number;          // 진입 시 산출한 링 내 잔여 경로
  ringTraveled: number;
  // 체류형
  orbitSlot: number;
  orbitAngle: number;
  attackProgress: number;       // 0..1 (주기 정규화 — 속도 변화에도 연속)
  telegraphing: boolean;
  exposeTimer: number;          // a-5: >0 이면 링 안 노출(피격 가능)
  armorBroken: boolean;         // a-4: 1타 후 장갑 파괴
  spawnAnimT: number;           // 진입 연출 보간 (렌더 전용)
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

/** entry: 통과형 진입 각도 (기획서 v2 10.0 "정하방/사선 좌우") */
export type EntryAngle = 'down' | 'left' | 'right';
export interface WaveEntry { t: number; type: EnemyType; formationCount?: number; entry?: EntryAngle }
export interface Wave { name: string; restAfterSec: number; entries: WaveEntry[] }
export interface WavePlan { waves: Wave[] }

export type GameState = 'playing' | 'rest' | 'clear' | 'fail';

const DIAGONAL_DEG = 32;        // 사선 진입 각도
const TARGET_SPREAD = 0.45;     // 통과 목표점 산포 (×링 반경)
const ZIGZAG_AMPLITUDE = 0.16;  // a-2 지그재그 진폭 (필드 단위)
const ZIGZAG_FREQ = 4.4;        // a-2 지그재그 주파수
const FAIL_RESTART_DELAY = 1.2; // 실패 연출 후 재시작 (M1 검수 승인 편차)
const DIVE_RETURN_SEC = 0.4;

export class Sim {
  readonly field = new Field();
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
  diveCount = 0;        // 판당 도약 횟수 (게이지 A/B 실측 지표)
  combo = 0;
  private comboHoldAccum = 0;
  score = 0;
  girlX = 0; girlY = 0;
  girlPrevX = 0; girlPrevY = 0;
  private freezeTimer = 0; // 히트스톱
  private failTimer = 0;

  // 도약
  diveActive = false;
  private diveTimer = 0;
  private diveKillCooldown = 0;
  private diveTargetX = 0; private diveTargetY = 0;
  private returnTimer = 0;

  // 적
  private enemyPool: Enemy[] = [];
  private projectilePool: Projectile[] = [];
  private nextId = 1;
  private pendingStay: { type: EnemyType }[] = [];
  private orbitBaseAngle = 0;

  // 웨이브
  waveIndex = -1;
  private waveTime = 0;
  private spawnCursor = 0;
  private restTimer = 0;

  // 통계
  kills = 0;
  passedCount = 0;
  hitsTaken = 0;
  multIntegral = 0;
  private multTimeAccum = 0;
  restartCount = 0;
  /** 현재 스와이프 중 링 안에 벨 대상이 있었는가 (M1 검수 질문 3: 헛스윙 판정 한정) */
  private swipeHadTargets = false;

  constructor(plan: WavePlan, seed = 20260821) {
    this.plan = plan;
    this.seed = seed;
    this.rng = new Rng(seed);
    for (let i = 0; i < 64; i++) this.enemyPool.push(this.makeEnemy());
    for (let i = 0; i < 16; i++) {
      this.projectilePool.push({ id: 0, active: false, x: 0, y: 0, prevX: 0, prevY: 0, vx: 0, vy: 0 });
    }
    this.girlY = this.girlHomeY();
    this.girlPrevY = this.girlY;
    this.startWave(0);
  }

  private makeEnemy(): Enemy {
    return {
      id: 0, active: false, type: 'a-1', lifecycle: 'pass', phase: 'approach', hp: 1,
      x: 0, y: 0, prevX: 0, prevY: 0, dirX: 0, dirY: 1,
      zigzagSeed: 0, zigzagOffset: 0, ringPathLen: 0, ringTraveled: 0,
      orbitSlot: 0, orbitAngle: 0, attackProgress: 0, telegraphing: false,
      exposeTimer: 0, armorBroken: false, spawnAnimT: 0, lastCountedHitMs: -1e9,
    };
  }

  // ─────────────────────────── 파생 상태 ───────────────────────────

  get enemies(): readonly Enemy[] { return this.enemyPool; }
  get projectiles(): readonly Projectile[] { return this.projectilePool; }
  get multiplier(): number {
    return this.speed + (this.combo >= config.comboBonusAt ? config.comboBonusMultiplier : 0);
  }
  get avgMultiplier(): number { return this.multTimeAccum > 0 ? this.multIntegral / this.multTimeAccum : 0; }
  get stance(): Stance { return this.umbrellaOpen ? 'sword' : 'umbrella'; }
  get zoom(): number { return this.diveActive ? config.zoomMax : zoomForSpeed(this.speed); }
  get ringRadius(): number { return config.ringRadiusFrac; }
  get currentWaveName(): string { return this.plan.waves[this.waveIndex]?.name ?? ''; }
  get waveCount(): number { return this.plan.waves.length; }
  girlHomeY(): number { return this.field.yAtScreenFraction(config.girlScreenFrac); }
  activeEnemyCount(): number { return this.enemyPool.filter(e => e.active).length; }
  activeStayCount(): number {
    return this.enemyPool.filter(e => e.active && e.lifecycle === 'stay').length;
  }
  /** 링 안에서 현재 벨 수 있는 적 수 (혼잡도·헛스윙 판정용) */
  hittableCount(): number {
    let n = 0;
    for (const e of this.enemyPool) if (e.active && this.isHittable(e)) n++;
    return n;
  }

  restart(): void {
    this.time = 0; this.state = 'playing';
    this.speed = config.speedMin; this.umbrellaOpen = false;
    this.hp = config.maxHp; this.invulnTimer = 0; this.toggleLockTimer = 0;
    this.gauge = 0; this.gaugeFullAt = null; this.diveCount = 0;
    this.combo = 0; this.comboHoldAccum = 0; this.score = 0;
    this.girlX = 0; this.girlY = this.girlHomeY();
    this.girlPrevX = this.girlX; this.girlPrevY = this.girlY;
    this.freezeTimer = 0; this.failTimer = 0;
    this.diveActive = false; this.diveTimer = 0; this.returnTimer = 0;
    for (const e of this.enemyPool) e.active = false;
    for (const p of this.projectilePool) p.active = false;
    this.pendingStay.length = 0;
    this.kills = 0; this.passedCount = 0; this.hitsTaken = 0;
    this.multIntegral = 0; this.multTimeAccum = 0;
    this.swipeHadTargets = false;
    this.rng = new Rng(this.seed + this.restartCount * 7919);
    this.restartCount++;
    this.startWave(0);
  }

  // ─────────────────────────── 입력 API ───────────────────────────

  /** 탭 = 우산 펼치기/접기 토글 */
  toggleUmbrella(): boolean {
    if (this.state !== 'playing' && this.state !== 'rest') return false;
    if (this.diveActive || this.toggleLockTimer > 0) return false;
    this.umbrellaOpen = !this.umbrellaOpen;
    this.events.push({ type: 'toggle', open: this.umbrellaOpen });
    return true;
  }

  /**
   * 스와이프 궤적 선분 1개 판정 (move마다 증분 호출 — 손을 떼기 전에 벤다).
   * 화면 좌표 선분 vs 링 내 적 스프라이트 원형 히트박스 교차 (기획서 v2 5장).
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
      this.swipeHadTargets = true; // 링 내 대상 존재 → 이번 스와이프는 헛스윙 판정 대상
      if (nowMs - e.lastCountedHitMs < rejudge) continue;
      const p = this.field.toScreen(e.x, e.y);
      const r = this.field.toScreenLength(ENEMY_DEF[e.type].hitRadius) + width;
      if (segmentIntersectsCircle(ax, ay, bx, by, p.x, p.y, r)) {
        e.lastCountedHitMs = nowMs;
        this.damageEnemy(e);
        hits++;
      }
    }
    // 투사체 요격 (기획서 v2 10.1 a-5)
    for (const pr of this.projectilePool) {
      if (!pr.active) continue;
      this.swipeHadTargets = true;
      const p = this.field.toScreen(pr.x, pr.y);
      const r = this.field.toScreenLength(0.03) + width;
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
   * 스와이프 종료. 콤보 리셋은 **링 내 대상이 있었는데 못 맞힌 경우(헛스윙)** 에만 발생한다
   * (M1 검수 질문 3 확정 — 빈 화면 스와이프는 무벌점).
   */
  endSwipe(totalHits: number): void {
    const whiffed = totalHits === 0 && this.swipeHadTargets;
    this.swipeHadTargets = false;
    if (whiffed && !this.diveActive && this.state === 'playing') this.combo = 0;
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
    this.events.push({ type: 'diveStart' });
    return true;
  }

  private isHittable(e: Enemy): boolean {
    if (e.lifecycle === 'pass') return e.phase === 'ring';
    if (e.phase !== 'orbit') return false;
    if (e.type === 'a-5') return e.exposeTimer > 0; // 발사 직후 1초만 링 안 노출
    return true;
  }

  private damageEnemy(e: Enemy): void {
    // 체류형: 공격 예고 중 베면 공격 저지 (기획서 v2 10.0)
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
    // 깃털: 하급만, 도약 중 미지급 (기획서 v2 8장).
    // 배율 곱 적용 여부는 A/B 토글 (기획서 v2 7장 미결 / 17장 검증 4). 기본 OFF.
    if (def.low && !inDive) {
      const gain = config.gaugePerLowKill * (config.gaugeMultiplierEnabled ? mult : 1);
      this.gauge = Math.min(1, this.gauge + gain);
      if (this.gauge >= 1 && this.gaugeFullAt === null) {
        this.gaugeFullAt = this.time;
        this.events.push({ type: 'gaugeFull' });
      }
    }
    this.score += Math.round((def.low ? config.scoreLow : config.scoreMid) * mult);
    this.freezeTimer = Math.max(this.freezeTimer, config.hitstopMs / 1000); // 히트스톱
  }

  private damagePlayer(dmg: number): void {
    if (this.invulnTimer > 0 || this.diveActive) return;
    if (this.state !== 'playing' && this.state !== 'rest') return;
    this.hp -= dmg;
    this.invulnTimer = config.invulnSec;
    this.combo = 0;
    this.comboHoldAccum = 0;
    this.hitsTaken++;
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
      if (this.failTimer <= 0) this.restart();
      return;
    }
    if (this.state === 'clear') return;

    // 렌더 보간용 이전 위치 스냅샷
    this.girlPrevX = this.girlX; this.girlPrevY = this.girlY;
    for (const e of this.enemyPool) if (e.active) { e.prevX = e.x; e.prevY = e.y; }
    for (const p of this.projectilePool) if (p.active) { p.prevX = p.x; p.prevY = p.y; }

    this.time += dt;
    this.field.zoom = this.zoom;

    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.toggleLockTimer > 0) this.toggleLockTimer -= dt;

    // 낙하 속도 다이얼 (기획서 v2 7장) — 도약 중에는 속도계 정지
    if (!this.diveActive) {
      if (this.umbrellaOpen) this.speed -= config.decelPerSec * dt;
      else this.speed += config.accelPerSec * dt;
      this.speed = Math.max(config.speedMin, Math.min(config.speedMax, this.speed));
    }

    // 최고속 콤보: 3.0x 유지 1초당 +1 (리셋은 피격/헛스윙 시 — M1 검수 질문 2 확정)
    if (!this.diveActive && this.speed >= config.speedMax - 1e-9) {
      this.comboHoldAccum += dt;
      while (this.comboHoldAccum >= 1) {
        this.comboHoldAccum -= 1;
        this.combo++;
      }
    }

    this.multIntegral += this.multiplier * dt;
    this.multTimeAccum += dt;
    this.orbitBaseAngle += (config.orbitSpeedDegSec * Math.PI / 180) * dt;

    this.updateWaves(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    if (this.diveActive) this.updateDive(dt);
    else if (this.returnTimer > 0) {
      this.returnTimer -= dt;
      const k = Math.max(0, this.returnTimer / DIVE_RETURN_SEC);
      const homeY = this.girlHomeY();
      this.girlX *= k;
      this.girlY = homeY + (this.girlY - homeY) * k;
    }
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

    while (this.spawnCursor < wave.entries.length &&
           wave.entries[this.spawnCursor].t <= this.waveTime) {
      this.spawnEntry(wave.entries[this.spawnCursor++]);
    }

    // 체류형 대기열 방출 (상한 4기 — 기획서 v2 10.0)
    while (this.pendingStay.length > 0 && this.activeStayCount() < config.stayCap) {
      this.spawnEnemy(this.pendingStay.shift()!.type, undefined, undefined);
    }

    if (this.spawnCursor >= wave.entries.length && this.activeEnemyCount() === 0 && this.pendingStay.length === 0) {
      if (this.waveIndex >= this.plan.waves.length - 1) {
        this.state = 'clear'; // 최종 웨이브 격퇴 = 클리어 (P1: 중간 보스 범위 외)
        this.events.push({ type: 'clear' });
      } else {
        this.state = 'rest'; // 휴지기 2~3초 (기획서 v2 11.3)
        this.restTimer = wave.restAfterSec;
      }
    }
  }

  private spawnEntry(entry: WaveEntry): void {
    if (entry.type === 'a-3') {
      // 밀집 편대: 긴 스와이프 1회로 다수 격파 (기획서 v2 10.1).
      // 전원이 판정 링을 통과해야 의미가 있으므로 편대 폭을 링 지름의 80% 안으로 클램프한다.
      const n = entry.formationCount ?? this.rng.int(5, 8);
      const dir = this.entryDirection(entry.entry);
      const maxSpacing = (config.ringRadiusFrac * 2 * 0.8) / Math.max(1, n - 1);
      const spacing = Math.min(config.formationSpacing, maxSpacing);
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * spacing;
        // 진행 방향으로도 살짝 어긋나게 배치해 평면적인 일렬이 아닌 "무리"로 보이게 한다
        const stagger = (i % 2 === 0 ? 1 : -1) * spacing * 0.55;
        this.spawnEnemy('a-3', dir, off, stagger);
      }
      return;
    }
    if (ENEMY_DEF[entry.type].lifecycle === 'stay' && this.activeStayCount() >= config.stayCap) {
      this.pendingStay.push({ type: entry.type });
      return;
    }
    this.spawnEnemy(entry.type, this.entryDirection(entry.entry), undefined);
  }

  /** 통과형 진입 각도 (기획서 v2 10.0: 정하방 / 사선 좌우) */
  private entryDirection(entry?: EntryAngle): { x: number; y: number } {
    const pick: EntryAngle = entry ?? (['down', 'left', 'right'] as EntryAngle[])[this.rng.int(0, 2)];
    if (pick === 'down') return { x: 0, y: 1 };
    const rad = (DIAGONAL_DEG * Math.PI) / 180;
    // 'left' = 좌측 하단에서 진입 → 우상향
    const sign = pick === 'left' ? 1 : -1;
    return { x: Math.sin(rad) * sign, y: Math.cos(rad) };
  }

  private spawnEnemy(
    type: EnemyType,
    dir: { x: number; y: number } | undefined,
    formationOffset: number | undefined,
    formationStagger = 0,
  ): void {
    const e = this.enemyPool.find(en => !en.active) ?? this.enemyPool[this.enemyPool.length - 1];
    const def = ENEMY_DEF[type];
    e.id = this.nextId++;
    e.active = true;
    e.type = type;
    e.lifecycle = def.lifecycle;
    e.hp = type === 'a-4' ? config.a4Hp : type === 'a-5' ? config.a5Hp : 1;
    e.zigzagSeed = this.rng.range(0, Math.PI * 2);
    e.zigzagOffset = 0;
    e.ringPathLen = 0;
    e.ringTraveled = 0;
    e.attackProgress = 0;
    e.telegraphing = false;
    e.exposeTimer = 0;
    e.armorBroken = false;
    e.spawnAnimT = 0;
    e.lastCountedHitMs = -1e9;

    if (def.lifecycle === 'stay') {
      // 체류형: 하단에서 진입해 배정된 선회 슬롯으로 이동
      e.phase = 'approach';
      e.orbitSlot = this.freeOrbitSlot();
      e.orbitAngle = this.slotAngle(e.orbitSlot);
      const target = this.orbitPosition(e);
      e.dirX = 0; e.dirY = 1;
      e.x = target.x;
      e.y = this.field.bottomY - config.spawnMargin;
      e.prevX = e.x; e.prevY = e.y;
      return;
    }

    // 통과형: 링 안을 스치도록 목표점을 잡고, 진입 방향의 반대편으로 역산해 스폰
    const d = dir ?? this.entryDirection();
    e.dirX = d.x; e.dirY = d.y;
    e.phase = 'approach';
    const R = config.ringRadiusFrac;
    // 편대는 링 중심을 겨냥 (전원이 판정 창을 지나야 하므로 산포 없음)
    const spread = formationOffset !== undefined ? 0 : R * TARGET_SPREAD;
    let tx = this.girlX + (spread > 0 ? this.rng.range(-spread, spread) : 0);
    let ty = this.girlY + (spread > 0 ? this.rng.range(-spread, spread) : 0);
    if (formationOffset !== undefined) {
      // 편대는 진행 방향에 수직으로 배열 + 진행축으로 약간의 어긋남
      tx += -d.y * formationOffset + d.x * formationStagger;
      ty += d.x * formationOffset + d.y * formationStagger;
    }
    // 목표점에서 진입 방향 반대로 화면 밖까지 물러난 지점이 스폰 위치
    const back = (this.field.aspect / 2 + config.spawnMargin + Math.abs(ty)) / Math.max(0.2, d.y);
    e.x = tx - d.x * back;
    e.y = ty - d.y * back;
    e.prevX = e.x; e.prevY = e.y;
  }

  private freeOrbitSlot(): number {
    const used = new Set<number>();
    for (const e of this.enemyPool) if (e.active && e.lifecycle === 'stay') used.add(e.orbitSlot);
    for (let i = 0; i < config.stayCap; i++) if (!used.has(i)) return i;
    return 0;
  }

  /** 슬롯별 배치각 — orbitSpreadDeg 범위에 균등 분산 (혼잡도 검증 손잡이) */
  private slotAngle(slot: number): number {
    const spread = (config.orbitSpreadDeg * Math.PI) / 180;
    const step = spread / config.stayCap;
    return -Math.PI / 2 + (slot - (config.stayCap - 1) / 2) * step;
  }

  private orbitPosition(e: Enemy): { x: number; y: number } {
    const base = config.ringRadiusFrac * config.orbitRadiusFactor;
    let r = base;
    if (e.type === 'a-5') {
      r = config.ringRadiusFrac * (e.exposeTimer > 0 ? config.a5ExposeFactor : config.a5EdgeFactor);
    }
    const ang = this.slotAngle(e.orbitSlot) + this.orbitBaseAngle;
    return { x: this.girlX + Math.cos(ang) * r, y: this.girlY + Math.sin(ang) * r };
  }

  // ─────────────────────────── 적 갱신 ───────────────────────────

  private updateEnemies(dt: number): void {
    const R = config.ringRadiusFrac;
    for (const e of this.enemyPool) {
      if (!e.active) continue;
      if (e.spawnAnimT < 1) e.spawnAnimT = Math.min(1, e.spawnAnimT + dt * 4);

      if (e.lifecycle === 'stay') {
        this.updateStayEnemy(e, dt);
        continue;
      }

      // 접근 속도 ∝ 낙하 속도 (기획서 v2 7장)
      if (e.phase === 'approach') {
        const v = config.approachSpeed * this.speed;
        e.x += e.dirX * v * dt;
        e.y += e.dirY * v * dt;
        this.applyZigzag(e);
        // 링을 스치지 못하고 지나쳐 버린 개체 회수 (편대 바깥쪽 등) — 웨이브 교착 방지
        if (e.y > this.field.topY + config.spawnMargin) {
          e.active = false;
          continue;
        }
        // 링 진입 판정
        if (Math.hypot(e.x - this.girlX, e.y - this.girlY) <= R) {
          e.phase = 'ring';
          e.ringTraveled = 0;
          e.ringPathLen = Math.max(
            1e-4,
            distanceToExit(e.x, e.y, e.dirX, e.dirY, this.girlX, this.girlY, R),
          );
          this.events.push({ type: 'ringEnter', enemyId: e.id });
        }
      } else if (e.phase === 'ring') {
        // 링 내 이동 속도 = 잔여 경로 / 체류 시간 → 기획서 7장 표를 정확히 재현
        const v = e.ringPathLen / Math.max(0.05, dwellTime(this.speed));
        const step = v * dt;
        e.x += e.dirX * step;
        e.y += e.dirY * step;
        e.ringTraveled += step;
        if (e.ringTraveled >= e.ringPathLen) {
          e.phase = 'passing';
          this.passedCount++;
          this.damagePlayer(config.contactDamage); // 미처치 통과 = 접촉 1
          this.events.push({ type: 'enemyPassed', enemyId: e.id });
        }
      } else if (e.phase === 'passing') {
        const v = config.approachSpeed * this.speed;
        e.x += e.dirX * v * dt;
        e.y += e.dirY * v * dt;
        if (e.y > this.field.topY + config.spawnMargin) e.active = false; // 상단 프레임 아웃
      }
    }
  }

  /** a-2 지그재그 — 진행 방향에 수직인 사인 진동. 링 안에서는 감쇠(가독성) */
  private applyZigzag(e: Enemy): void {
    if (e.type !== 'a-2') return;
    const damp = e.phase === 'ring' ? 0.25 : 1;
    const next = Math.sin(this.time * ZIGZAG_FREQ + e.zigzagSeed) * ZIGZAG_AMPLITUDE * damp;
    const delta = next - e.zigzagOffset;
    e.x += -e.dirY * delta;
    e.y += e.dirX * delta;
    e.zigzagOffset = next;
  }

  private updateStayEnemy(e: Enemy, dt: number): void {
    const target = this.orbitPosition(e);
    if (e.phase === 'approach') {
      const v = config.approachSpeed * this.speed * 1.15;
      const dx = target.x - e.x, dy = target.y - e.y;
      const d = Math.hypot(dx, dy);
      if (d <= v * dt || d < 1e-4) {
        e.x = target.x; e.y = target.y;
        e.phase = 'orbit';
        e.attackProgress = 0;
        this.events.push({ type: 'ringEnter', enemyId: e.id });
      } else {
        e.x += (dx / d) * v * dt;
        e.y += (dy / d) * v * dt;
      }
      return;
    }

    // 선회: 슬롯 각도를 따라간다
    e.x = target.x;
    e.y = target.y;
    e.orbitAngle = this.slotAngle(e.orbitSlot) + this.orbitBaseAngle;
    if (e.type === 'a-5' && e.exposeTimer > 0) e.exposeTimer -= dt;

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
        this.damagePlayer(config.contactDamage); // 근접 공격 적중 1
      } else {
        this.fireProjectile(e);
        e.exposeTimer = config.a5ExposeSec; // 발사 직후 링 안으로 노출
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
    p.vx = (dx / d) * config.projectileSpeed;
    p.vy = (dy / d) * config.projectileSpeed;
  }

  private updateProjectiles(dt: number): void {
    for (const p of this.projectilePool) {
      if (!p.active) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      const d = Math.hypot(p.x - this.girlX, p.y - this.girlY);
      if (d < 0.05) {
        p.active = false;
        this.damagePlayer(config.contactDamage); // 투사체 피격 1
      } else if (d > config.ringRadiusFrac * 4) {
        p.active = false;
      }
    }
  }

  // ─────────────────────────── 도약 ───────────────────────────

  /** 현재 활성 적이 가장 밀집한 방향 (기획서 v2 8장). 잔적 없으면 하방 직진 (M1 검수 질문 8) */
  private retargetDive(): void {
    const act = this.enemyPool.filter(e => e.active);
    if (act.length === 0) {
      this.diveTargetX = this.girlX;
      this.diveTargetY = this.girlY - 0.5;
      return;
    }
    const RADIUS2 = 0.36 * 0.36;
    let best = act[0], bestScore = -1;
    for (const e of act) {
      let n = 0;
      for (const o of act) {
        if ((e.x - o.x) ** 2 + (e.y - o.y) ** 2 < RADIUS2) n++;
      }
      if (n > bestScore) { bestScore = n; best = e; }
    }
    let cx = 0, cy = 0, cn = 0;
    for (const o of act) {
      if ((best.x - o.x) ** 2 + (best.y - o.y) ** 2 < RADIUS2) { cx += o.x; cy += o.y; cn++; }
    }
    this.diveTargetX = cx / cn;
    this.diveTargetY = cy / cn;
  }

  private updateDive(dt: number): void {
    this.diveTimer -= dt;
    this.diveKillCooldown -= dt;
    this.retargetDive();

    const dx = this.diveTargetX - this.girlX;
    const dy = this.diveTargetY - this.girlY;
    const d = Math.hypot(dx, dy);
    if (d > 0.01) {
      const v = Math.min(config.diveSpeed * dt, d);
      this.girlX += (dx / d) * v;
      this.girlY += (dy / d) * v;
    }
    // 화면 밖으로 나가지 않도록 클램프
    const marginX = 0.5 - config.ringRadiusFrac * 0.5;
    const marginY = this.field.aspect / 2 - config.ringRadiusFrac * 0.5;
    this.girlX = Math.max(-marginX, Math.min(marginX, this.girlX));
    this.girlY = Math.max(-marginY, Math.min(marginY, this.girlY));

    // 판정 링에 들어온 적 순차 자동 격파 (도약 중 깃털 미지급)
    if (this.diveKillCooldown <= 0) {
      let nearest: Enemy | null = null;
      let nd = Infinity;
      for (const e of this.enemyPool) {
        if (!e.active) continue;
        const dd = Math.hypot(e.x - this.girlX, e.y - this.girlY);
        if (dd <= config.ringRadiusFrac && dd < nd) { nd = dd; nearest = e; }
      }
      if (nearest) {
        this.events.push({ type: 'slashHit', enemyId: nearest.id, killed: true, x: nearest.x, y: nearest.y });
        this.killEnemy(nearest, true);
        this.diveKillCooldown = config.diveKillStaggerSec;
      }
    }

    if (this.diveTimer <= 0) {
      this.diveActive = false;
      this.speed = config.diveEndSpeed;                 // 3.0x 강제 복귀
      this.toggleLockTimer = config.diveToggleLockSec;  // 1초 토글 잠금
      this.returnTimer = DIVE_RETURN_SEC;
      this.events.push({ type: 'diveEnd' });
    }
  }
}
