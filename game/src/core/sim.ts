/**
 * FallingDown M1 시뮬레이션 — 순수 TS, three.js/DOM 미의존 (로직-렌더링 분리, 검수 대상).
 * 고정 타임스텝으로 구동되며(runner.ts), 렌더러는 이 상태를 구독해 그리기만 한다.
 *
 * 좌표계는 projection.ts 참조. 소녀 기준 상대 좌표로 투영하므로 카메라는 항상 소녀를 따라간다.
 */
import { config, dwellTime, attackPeriod, fovForSpeed } from './balance';
import { Projector, segmentIntersectsCircle } from './projection';
import { Rng } from './rng';

export type EnemyType = 'a-1' | 'a-2' | 'a-3' | 'a-4' | 'a-5';
export type Lifecycle = 'pass' | 'stay';
export type Stance = 'umbrella' | 'sword'; // 접음=우산, 펼침=검 (기획서 5장)

const ENEMY_DEF: Record<EnemyType, { lifecycle: Lifecycle; hp: number; low: boolean; radius: number }> = {
  'a-1': { lifecycle: 'pass', hp: 1, low: true, radius: 0.32 },
  'a-2': { lifecycle: 'pass', hp: 1, low: true, radius: 0.32 },
  'a-3': { lifecycle: 'pass', hp: 1, low: true, radius: 0.28 },
  'a-4': { lifecycle: 'stay', hp: 2, low: false, radius: 0.38 },
  'a-5': { lifecycle: 'stay', hp: 1, low: false, radius: 0.38 },
};

export interface Enemy {
  id: number;
  active: boolean;
  type: EnemyType;
  lifecycle: Lifecycle;
  phase: 'approach' | 'ring' | 'orbit' | 'passing';
  hp: number;
  x: number; y: number; z: number;
  prevX: number; prevY: number; prevZ: number; // 렌더 보간용 이전 스텝 위치
  startX: number; startZ: number;
  targetX: number; targetZ: number;
  spawnY: number;
  zigzagSeed: number;
  waveIndex: number;
  // 체류형
  orbitAngle: number;
  orbitDir: number;
  attackProgress: number; // 0..1, 주기 정규화 (주기가 속도에 따라 변해도 연속)
  telegraphing: boolean;
  exposeTimer: number;    // a-5: >0 이면 링 안 노출(피격 가능)
  armorBroken: boolean;   // a-4: 1타 후 장갑 파괴
  // 판정
  lastCountedHitMs: number;
}

export interface Projectile {
  id: number;
  active: boolean;
  x: number; y: number; z: number;
  vx: number; vz: number;
}

export type SimEvent =
  | { type: 'ringEnter'; enemyId: number }
  | { type: 'slashHit'; enemyId: number; killed: boolean; x: number; y: number; z: number }
  | { type: 'armorBreak'; enemyId: number }
  | { type: 'projectileDown'; x: number; z: number }
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

const FORMATION_SPACING = 0.62; // a-3 편대 간격 (wu) — 긴 스와이프 1회로 관통 가능해야 함
const ORBIT_SPEED = 0.8;        // 체류형 선회 각속도 (rad/s)
const A4_ORBIT_R = 0.8;         // a-4 선회 반경 (×링 반경)
const A5_EDGE_R = 1.15;         // a-5 대기 위치 (링 가장자리 바깥 — 노출 시에만 피격 가능)
const A5_EXPOSE_R = 0.8;
const FAIL_RESTART_DELAY = 1.2; // 실패 연출 후 재시작 (기획서 "즉시 재시작" — 가독성용 지연, 리포트 기록)

export class Sim {
  readonly projector = new Projector();
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
  girlX = 0; girlY = 0; girlZ = 0;
  girlPrevX = 0; girlPrevY = 0; girlPrevZ = 0;
  private freezeTimer = 0; // 히트스톱
  private failTimer = 0;

  // 도약
  diveActive = false;
  private diveTimer = 0;
  private diveKillCooldown = 0;
  private diveTargetX = 0; private diveTargetY = 0; private diveTargetZ = 0;
  private returnTimer = 0;

  // 적
  private enemyPool: Enemy[] = [];
  private projectilePool: Projectile[] = [];
  private nextId = 1;
  private pendingStay: { type: EnemyType; waveIndex: number }[] = [];

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
  swipeHitFlags: boolean[] = [];
  restartCount = 0;

  constructor(plan: WavePlan, seed = 20260821) {
    this.plan = plan;
    this.seed = seed;
    this.rng = new Rng(seed);
    for (let i = 0; i < 64; i++) this.enemyPool.push(this.makeEnemy());
    for (let i = 0; i < 16; i++) this.projectilePool.push({ id: 0, active: false, x: 0, y: 0, z: 0, vx: 0, vz: 0 });
    this.startWave(0);
  }

  private makeEnemy(): Enemy {
    return {
      id: 0, active: false, type: 'a-1', lifecycle: 'pass', phase: 'approach', hp: 1,
      x: 0, y: 0, z: 0, prevX: 0, prevY: 0, prevZ: 0,
      startX: 0, startZ: 0, targetX: 0, targetZ: 0, spawnY: 0,
      zigzagSeed: 0, waveIndex: 0, orbitAngle: 0, orbitDir: 1, attackProgress: 0,
      telegraphing: false, exposeTimer: 0, armorBroken: false, lastCountedHitMs: -1e9,
    };
  }

  get enemies(): readonly Enemy[] { return this.enemyPool; }
  get projectiles(): readonly Projectile[] { return this.projectilePool; }
  get multiplier(): number {
    return this.speed + (this.combo >= config.comboBonusAt ? config.comboBonusMultiplier : 0);
  }
  get avgMultiplier(): number { return this.multTimeAccum > 0 ? this.multIntegral / this.multTimeAccum : 0; }
  get stance(): Stance { return this.umbrellaOpen ? 'sword' : 'umbrella'; }
  get fov(): number { return this.diveActive ? config.fovMax : fovForSpeed(this.speed); }
  get currentWaveName(): string { return this.plan.waves[this.waveIndex]?.name ?? ''; }
  get waveCount(): number { return this.plan.waves.length; }
  activeEnemyCount(): number { return this.enemyPool.filter(e => e.active).length; }
  activeStayCount(): number {
    return this.enemyPool.filter(e => e.active && e.lifecycle === 'stay' && e.phase === 'orbit').length;
  }

  /** 전판 재시작 (실패 시 자동 호출, 자원 100% 소실 = 게이지·점수 리셋) */
  restart(): void {
    this.time = 0; this.state = 'playing';
    this.speed = config.speedMin; this.umbrellaOpen = false;
    this.hp = config.maxHp; this.invulnTimer = 0; this.toggleLockTimer = 0;
    this.gauge = 0; this.gaugeFullAt = null;
    this.combo = 0; this.comboHoldAccum = 0; this.score = 0;
    this.girlX = 0; this.girlY = 0; this.girlZ = 0;
    this.freezeTimer = 0; this.failTimer = 0;
    this.diveActive = false; this.diveTimer = 0; this.returnTimer = 0;
    for (const e of this.enemyPool) e.active = false;
    for (const p of this.projectilePool) p.active = false;
    this.pendingStay.length = 0;
    this.kills = 0; this.passedCount = 0; this.hitsTaken = 0;
    this.multIntegral = 0; this.multTimeAccum = 0;
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
      if (nowMs - e.lastCountedHitMs < rejudge) continue;
      const p = this.projector.project(e.x - this.girlX, e.y - this.girlY, e.z - this.girlZ);
      if (!p) continue;
      const r = this.projector.projectRadius(ENEMY_DEF[e.type].radius, e.y - this.girlY) + width;
      if (segmentIntersectsCircle(ax, ay, bx, by, p.x, p.y, r)) {
        e.lastCountedHitMs = nowMs;
        this.damageEnemy(e);
        hits++;
      }
    }
    for (const pr of this.projectilePool) {
      if (!pr.active) continue;
      const p = this.projector.project(pr.x - this.girlX, pr.y - this.girlY, pr.z - this.girlZ);
      if (!p) continue;
      const r = this.projector.projectRadius(0.2, pr.y - this.girlY) + width;
      if (segmentIntersectsCircle(ax, ay, bx, by, p.x, p.y, r)) {
        pr.active = false;
        this.score += Math.round(config.scoreProjectile * this.multiplier);
        this.events.push({ type: 'projectileDown', x: pr.x, z: pr.z });
        hits++;
      }
    }
    return hits;
  }

  /** 스와이프 종료 — 총 히트 0이면 베기 미스 → 콤보 리셋 (기획서 7장) */
  endSwipe(totalHits: number): void {
    this.swipeHitFlags.push(totalHits > 0);
    if (totalHits === 0 && !this.diveActive && this.state === 'playing') this.combo = 0;
  }

  /** 도약 버튼 — 게이지 100% 시 발동 */
  tryDive(): boolean {
    if (this.state !== 'playing' && this.state !== 'rest') return false;
    if (this.diveActive || this.gauge < 1) return false;
    this.gauge = 0;
    this.diveActive = true;
    this.diveTimer = config.diveDurationSec;
    this.diveKillCooldown = 0;
    this.retargetDive();
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
    this.events.push({ type: 'slashHit', enemyId: e.id, killed, x: e.x, y: e.y, z: e.z });
    if (killed) this.killEnemy(e, false);
  }

  private killEnemy(e: Enemy, inDive: boolean): void {
    e.active = false;
    this.kills++;
    const def = ENEMY_DEF[e.type];
    const mult = this.multiplier;
    // 깃털: 하급만, 도약 중 미지급 (기획서 8장). 배율 곱 적용 (기획서 8장 "5% (배율 곱 적용)")
    if (def.low && !inDive) {
      this.gauge = Math.min(1, this.gauge + config.gaugePerLowKill * mult);
      if (this.gauge >= 1 && this.gaugeFullAt === null) {
        this.gaugeFullAt = this.time;
        this.events.push({ type: 'gaugeFull' });
      }
    }
    this.score += Math.round((def.low ? config.scoreLow : config.scoreMid) * mult);
    this.freezeTimer = Math.max(this.freezeTimer, config.hitstopMs / 1000); // 히트스톱 (기획서 16장 1)
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
      if (this.failTimer <= 0) this.restart(); // 즉시 재시작 (기획서 9장)
      return;
    }
    if (this.state === 'clear') return;

    // 렌더 보간용 이전 위치 스냅샷
    this.girlPrevX = this.girlX; this.girlPrevY = this.girlY; this.girlPrevZ = this.girlZ;
    for (const e of this.enemyPool) {
      if (e.active) { e.prevX = e.x; e.prevY = e.y; e.prevZ = e.z; }
    }

    this.time += dt;
    this.projector.fovDeg = this.fov;
    this.projector.camHeight = config.camHeightWu;

    // 타이머
    if (this.invulnTimer > 0) this.invulnTimer -= dt;
    if (this.toggleLockTimer > 0) this.toggleLockTimer -= dt;

    // 낙하 속도 다이얼 (기획서 7장) — 도약 중에는 속도계 정지
    if (!this.diveActive) {
      if (this.umbrellaOpen) this.speed -= config.decelPerSec * dt;
      else this.speed += config.accelPerSec * dt;
      this.speed = Math.max(config.speedMin, Math.min(config.speedMax, this.speed));
    }

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

    this.updateWaves(dt);
    this.updateEnemies(dt);
    this.updateProjectiles(dt);
    if (this.diveActive) this.updateDive(dt);
    else if (this.returnTimer > 0) {
      // 도약 종료 후 원위치 복귀 보간
      this.returnTimer -= dt;
      const k = Math.max(0, this.returnTimer / 0.4);
      this.girlX *= k; this.girlY *= k; this.girlZ *= k;
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
        this.state = 'clear'; // 최종 웨이브 격퇴 = 클리어 (M1: 중간 보스 범위 외)
        this.events.push({ type: 'clear' });
      } else {
        this.state = 'rest'; // 휴지기 2~3초 (기획서 11.3)
        this.restTimer = wave.restAfterSec;
      }
    }
  }

  private spawnEntry(entry: WaveEntry): void {
    if (entry.type === 'a-3') {
      // 밀집 편대: 평행 궤적의 가로 열 — 긴 스와이프 1회로 다수 격파 (기획서 10.1)
      const n = entry.formationCount ?? this.rng.int(5, 8);
      const angle = this.rng.range(0, Math.PI);
      const dirX = Math.cos(angle), dirZ = Math.sin(angle);
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * FORMATION_SPACING;
        this.spawnEnemy('a-3', { offX: dirX * off, offZ: dirZ * off }, this.waveIndex);
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

  private spawnEnemy(type: EnemyType, formationOff: { offX: number; offZ: number } | undefined, waveIndex: number): void {
    const e = this.enemyPool.find(en => !en.active) ?? this.enemyPool[this.enemyPool.length - 1];
    const def = ENEMY_DEF[type];
    e.id = this.nextId++;
    e.active = true;
    e.type = type;
    e.lifecycle = def.lifecycle;
    e.phase = 'approach';
    e.hp = def.hp;
    e.spawnY = -config.spawnDistWu;
    e.y = e.spawnY;
    // 시작점: 소실점 부근 넓게, 목표점: 소녀 근방 (링 안을 스치도록)
    const spreadStart = 6, spreadTarget = config.ringRadiusWu * 0.55;
    e.startX = this.rng.range(-spreadStart, spreadStart);
    e.startZ = this.rng.range(-spreadStart, spreadStart);
    e.targetX = this.rng.range(-spreadTarget, spreadTarget);
    e.targetZ = this.rng.range(-spreadTarget, spreadTarget);
    if (formationOff) {
      e.startX = e.targetX + formationOff.offX;
      e.startZ = e.targetZ + formationOff.offZ;
      e.targetX += formationOff.offX;
      e.targetZ += formationOff.offZ;
    }
    e.x = e.startX; e.z = e.startZ;
    e.prevX = e.x; e.prevY = e.y; e.prevZ = e.z;
    e.zigzagSeed = this.rng.range(0, Math.PI * 2);
    e.waveIndex = waveIndex;
    e.orbitAngle = this.rng.range(0, Math.PI * 2);
    e.orbitDir = this.rng.next() < 0.5 ? 1 : -1;
    e.attackProgress = 0;
    e.telegraphing = false;
    e.exposeTimer = 0;
    e.armorBroken = false;
    e.lastCountedHitMs = -1e9;
  }

  // ─────────────────────────── 적 갱신 ───────────────────────────

  private updateEnemies(dt: number): void {
    const halfWin = config.ringWindowWu / 2;
    for (const e of this.enemyPool) {
      if (!e.active) continue;

      if (e.phase === 'approach') {
        // 접근 속도 ∝ 낙하 속도 (기획서 7장)
        const vy = config.approachBaseWu * this.speed;
        e.y += vy * dt;
        const ringEntryY = e.lifecycle === 'pass' ? -halfWin : 0;
        const p = Math.min(1, (e.y - e.spawnY) / (ringEntryY - e.spawnY));
        e.x = e.startX + (e.targetX - e.startX) * p;
        e.z = e.startZ + (e.targetZ - e.startZ) * p;
        if (e.type === 'a-2') {
          // 지그재그: 진행에 따라 감쇠하는 가로 사인 진동
          e.x += Math.sin(this.time * 5 + e.zigzagSeed) * 1.6 * (1 - p);
        }
        if (e.y >= ringEntryY) {
          if (e.lifecycle === 'pass') {
            e.phase = 'ring';
            this.events.push({ type: 'ringEnter', enemyId: e.id });
          } else {
            e.phase = 'orbit';
            e.attackProgress = 0;
            this.events.push({ type: 'ringEnter', enemyId: e.id });
          }
        }
      } else if (e.phase === 'ring') {
        // 판정 창 통과: 체류 시간 = dwellTime(v) (기획서 7장 선형 규칙)
        const vy = config.ringWindowWu / Math.max(0.05, dwellTime(this.speed));
        e.y += vy * dt;
        if (e.y > halfWin) {
          e.phase = 'passing';
          this.passedCount++;
          this.damagePlayer(config.contactDamage); // 미처치 통과 = 접촉 1 (기획서 10.0)
          this.events.push({ type: 'enemyPassed', enemyId: e.id });
        }
      } else if (e.phase === 'passing') {
        e.y += config.approachBaseWu * this.speed * dt;
        if (e.y > config.camHeightWu + 2) e.active = false; // 카메라 뒤 프레임 아웃
      } else if (e.phase === 'orbit') {
        this.updateStayEnemy(e, dt);
      }
    }
  }

  private updateStayEnemy(e: Enemy, dt: number): void {
    e.orbitAngle += ORBIT_SPEED * e.orbitDir * dt;
    let r = e.type === 'a-4' ? config.ringRadiusWu * A4_ORBIT_R : config.ringRadiusWu * A5_EDGE_R;
    if (e.type === 'a-5' && e.exposeTimer > 0) {
      e.exposeTimer -= dt;
      r = config.ringRadiusWu * A5_EXPOSE_R; // 발사 후 1초 링 안 노출 (기획서 10.1)
    }
    e.x = this.girlX + Math.cos(e.orbitAngle) * r;
    e.z = this.girlZ + Math.sin(e.orbitAngle) * r;
    e.y = this.girlY;

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
    p.x = e.x; p.y = e.y; p.z = e.z;
    const dx = this.girlX - e.x, dz = this.girlZ - e.z;
    const d = Math.hypot(dx, dz) || 1;
    p.vx = (dx / d) * config.projectileSpeedWu;
    p.vz = (dz / d) * config.projectileSpeedWu;
  }

  private updateProjectiles(dt: number): void {
    for (const p of this.projectilePool) {
      if (!p.active) continue;
      p.x += p.vx * dt;
      p.z += p.vz * dt;
      const d = Math.hypot(p.x - this.girlX, p.z - this.girlZ);
      if (d < 0.35) {
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
    const act = this.enemyPool.filter(e => e.active);
    if (act.length === 0) {
      this.diveTargetX = this.girlX; this.diveTargetY = this.girlY - 6; this.diveTargetZ = this.girlZ;
      return;
    }
    let best: Enemy = act[0], bestScore = -1;
    for (const e of act) {
      let n = 0;
      for (const o of act) {
        const d2 = (e.x - o.x) ** 2 + (e.y - o.y) ** 2 + (e.z - o.z) ** 2;
        if (d2 < 9) n++;
      }
      if (n > bestScore) { bestScore = n; best = e; }
    }
    // 클러스터 중심
    let cx = 0, cy = 0, cz = 0, cn = 0;
    for (const o of act) {
      const d2 = (best.x - o.x) ** 2 + (best.y - o.y) ** 2 + (best.z - o.z) ** 2;
      if (d2 < 9) { cx += o.x; cy += o.y; cz += o.z; cn++; }
    }
    this.diveTargetX = cx / cn; this.diveTargetY = cy / cn; this.diveTargetZ = cz / cn;
  }

  private updateDive(dt: number): void {
    this.diveTimer -= dt;
    this.diveKillCooldown -= dt;
    this.retargetDive();

    // 목표를 향해 비행
    const dx = this.diveTargetX - this.girlX;
    const dy = this.diveTargetY - this.girlY;
    const dz = this.diveTargetZ - this.girlZ;
    const d = Math.hypot(dx, dy, dz);
    if (d > 0.1) {
      const v = Math.min(config.diveSpeedWu * dt, d);
      this.girlX += (dx / d) * v;
      this.girlY += (dy / d) * v;
      this.girlZ += (dz / d) * v;
    }

    // 판정 링에 들어온 적 순차 자동 격파 (기획서 8장)
    if (this.diveKillCooldown <= 0) {
      let nearest: Enemy | null = null;
      let nd = Infinity;
      for (const e of this.enemyPool) {
        if (!e.active) continue;
        const dd = Math.hypot(e.x - this.girlX, e.y - this.girlY, e.z - this.girlZ);
        if (dd <= config.ringRadiusWu && dd < nd) { nd = dd; nearest = e; }
      }
      if (nearest) {
        this.events.push({ type: 'slashHit', enemyId: nearest.id, killed: true, x: nearest.x, y: nearest.y, z: nearest.z });
        this.killEnemy(nearest, true); // 도약 중 깃털 미지급
        this.diveKillCooldown = config.diveKillStaggerSec;
      }
    }

    if (this.diveTimer <= 0) {
      this.diveActive = false;
      this.speed = config.diveEndSpeed;         // 3.0x 강제 복귀 (기획서 8장)
      this.toggleLockTimer = config.diveToggleLockSec; // 1초 토글 잠금
      this.returnTimer = 0.4;
      this.events.push({ type: 'diveEnd' });
    }
  }
}
