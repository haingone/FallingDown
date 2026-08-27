/**
 * 밸런스 데이터 모듈 — 기획서(fallingdown_game_design.md) 7~11장 초기 기준값의 단일 출처.
 * 순수 데이터. three.js/DOM 의존 금지 (로직-렌더링 분리 원칙).
 *
 * 튜닝 패널은 이 객체(runtime config)를 직접 수정하고, 시뮬레이션은 매 스텝 이 값을 읽는다.
 * 기획서에 없는 값(★ 표시)은 M1에서 임의 선정한 값이며 전부 M1_report.md에 기록한다.
 */

export interface BalanceConfig {
  // ── 기획서 7장: 낙하 속도 시스템 ──
  speedMin: number;            // 1.0x
  speedMax: number;            // 3.0x
  accelPerSec: number;         // 접음 +0.25x/초
  decelPerSec: number;         // 펼침 -1.0x/초
  comboBonusMultiplier: number; // 콤보 10 도달 시 배율 +0.5
  comboBonusAt: number;        // 콤보 10
  // 통과형 링 체류: 0.8s@1.0x → 0.3s@3.0x 선형
  dwellAt1x: number;
  dwellAt3x: number;
  // 체류형 공격 주기: 3.0s@1.0x → 1.5s@3.0x 선형
  attackPeriodAt1x: number;
  attackPeriodAt3x: number;
  dwellScale: number;          // 튜닝 패널용 체류시간 배수 (기본 1.0)
  attackPeriodScale: number;   // 튜닝 패널용 공격주기 배수 (기본 1.0)

  // ── 기획서 5장: 입력 분류 ──
  tapMaxDistancePt: number;    // 24pt (CSS px, DPR 독립)
  tapMaxDurationMs: number;    // 200ms
  swipeSpeedThresholdPtMs: number; // ★ 속도 임계 (pt/ms) — "또는 속도 임계 초과" 판정용. 기획서 미정값

  // ── 기획서 5/12.3장: 스탠스 (M1은 파라미터 차이로만) ──
  umbrellaTrajWidthPt: number; // ★ 우산: 궤적 판정 폭 (스와이프 선분에 더해지는 반경, CSS px)
  swordTrajWidthPt: number;    // ★ 검: 좁음
  umbrellaRejudgeMs: number;   // ★ 우산: 동일 적 재판정 간격
  swordRejudgeMs: number;      // ★ 검: 연격 빠름

  // ── 기획서 8장: 도약 ──
  gaugePerLowKill: number;     // 하급 1기 = 5% (0.05), 배율 곱 적용
  diveDurationSec: number;     // 2.5초 무적
  diveEndSpeed: number;        // 종료 후 3.0x 강제
  diveToggleLockSec: number;   // 1초 토글 잠금
  diveSpeedWu: number;         // ★ 도약 비행 속도 (world unit/s)
  diveKillStaggerSec: number;  // ★ 순차 자동 격파 간격 (연출용)

  // ── 기획서 9장: 생존 ──
  maxHp: number;               // 5칸
  contactDamage: number;       // 통과/공격/투사체 1
  invulnSec: number;           // 피격 무적 0.5초

  // ── 기획서 10장: 적 ──
  stayCap: number;             // 체류형 동시 상한 4기
  telegraphSec: number;        // 공격 예고 0.6초 발광
  a4Hp: number;                // a-4 베기 2회
  a5ExposeSec: number;         // a-5 발사 후 1초 링 안 노출
  projectileSpeedWu: number;   // ★ a-5 투사체 속도 (world unit/s)

  // ── 기획서 4장: 카메라/연출 ──
  fovMin: number;              // 60°
  fovMax: number;              // 72°
  hitstopMs: number;           // 히트스톱 30~50ms (기본 40)

  // ── 씬 지오메트리 (★ M1 그레이박스 임의값 — 판정 튜닝 대상) ──
  ringRadiusWu: number;        // 판정 링 반경 (world unit)
  ringWindowWu: number;        // 통과형 판정 창 깊이 (링 평면 앞뒤 폭)
  spawnDistWu: number;         // 스폰 깊이 (소실점 거리)
  approachBaseWu: number;      // 접근 속도 기본값 (×현재 낙하 속도)
  camHeightWu: number;         // 카메라-소녀 거리
  spawnDensityScale: number;   // 튜닝 패널용 스폰 간격 배수 (작을수록 촘촘)

  // ── 점수 (★ 기획서 미정값) ──
  scoreLow: number;
  scoreMid: number;
  scoreProjectile: number;
}

export const DEFAULT_BALANCE: BalanceConfig = {
  speedMin: 1.0,
  speedMax: 3.0,
  accelPerSec: 0.25,
  decelPerSec: 1.0,
  comboBonusMultiplier: 0.5,
  comboBonusAt: 10,
  dwellAt1x: 0.8,
  dwellAt3x: 0.3,
  attackPeriodAt1x: 3.0,
  attackPeriodAt3x: 1.5,
  dwellScale: 1.0,
  attackPeriodScale: 1.0,

  tapMaxDistancePt: 24,
  tapMaxDurationMs: 200,
  swipeSpeedThresholdPtMs: 0.5,

  umbrellaTrajWidthPt: 34,
  swordTrajWidthPt: 14,
  umbrellaRejudgeMs: 260,
  swordRejudgeMs: 110,

  gaugePerLowKill: 0.05,
  diveDurationSec: 2.5,
  diveEndSpeed: 3.0,
  diveToggleLockSec: 1.0,
  diveSpeedWu: 16,
  diveKillStaggerSec: 0.06,

  maxHp: 5,
  contactDamage: 1,
  invulnSec: 0.5,

  stayCap: 4,
  telegraphSec: 0.6,
  a4Hp: 2,
  a5ExposeSec: 1.0,
  projectileSpeedWu: 2.2,

  fovMin: 60,
  fovMax: 72,
  hitstopMs: 40,

  ringRadiusWu: 1.6,
  ringWindowWu: 2.0,
  spawnDistWu: 40,
  approachBaseWu: 8,
  camHeightWu: 6,
  spawnDensityScale: 1.0,

  scoreLow: 100,
  scoreMid: 300,
  scoreProjectile: 50,
};

/** 런타임 설정: 튜닝 패널이 이 객체를 직접 수정한다. */
export const config: BalanceConfig = { ...DEFAULT_BALANCE };

export function resetConfig(): void {
  Object.assign(config, DEFAULT_BALANCE);
}

/** 통과형 링 체류 시간 (속도 선형 보간, 링 반경 확대 시 비례 증가 = 기획서 12.1 "등가" 규칙) */
export function dwellTime(speed: number, cfg: BalanceConfig = config): number {
  const t = (speed - cfg.speedMin) / (cfg.speedMax - cfg.speedMin);
  const base = cfg.dwellAt1x + (cfg.dwellAt3x - cfg.dwellAt1x) * t;
  return base * cfg.dwellScale * (cfg.ringRadiusWu / DEFAULT_BALANCE.ringRadiusWu);
}

/** 체류형 공격 주기 (속도 선형 보간) */
export function attackPeriod(speed: number, cfg: BalanceConfig = config): number {
  const t = (speed - cfg.speedMin) / (cfg.speedMax - cfg.speedMin);
  return (cfg.attackPeriodAt1x + (cfg.attackPeriodAt3x - cfg.attackPeriodAt1x) * t) * cfg.attackPeriodScale;
}

/** 속도에 따른 FOV (기획서 4장: 60° → 72°) */
export function fovForSpeed(speed: number, cfg: BalanceConfig = config): number {
  const t = (speed - cfg.speedMin) / (cfg.speedMax - cfg.speedMin);
  return cfg.fovMin + (cfg.fovMax - cfg.fovMin) * t;
}
