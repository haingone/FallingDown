/**
 * 밸런스 데이터 모듈 — 기획서 v2.0 7~11장 초기 기준값의 단일 출처.
 * 순수 데이터. three.js/DOM 의존 금지 (로직-렌더링 분리 원칙).
 *
 * 튜닝 패널은 이 객체(runtime config)를 직접 수정하고, 시뮬레이션은 매 스텝 이 값을 읽는다.
 * 기획서에 없는 값(★ 표시)은 임의 선정값이며 전부 P1_report.md에 기록한다.
 * ✅ = M1에서 실측 검증된 값 (기획서 v2 표기 계승).
 *
 * 길이 단위: 1.0 = 화면 폭 (core/field.ts 참조).
 */

import type { JudgeAreaKind } from './judgeArea';

export type PixelScaleMode = 'native' | 'pixel';
export type { JudgeAreaKind };

export interface BalanceConfig {
  // ── 기획서 v2 7장: 낙하 속도 시스템 (M1 이월, 변경 없음) ──
  speedMin: number;            // 1.0x
  speedMax: number;            // 3.0x
  accelPerSec: number;         // 접음 +0.25x/초
  decelPerSec: number;         // 펼침 -1.0x/초
  comboBonusMultiplier: number; // 콤보 10 도달 시 배율 +0.5
  comboBonusAt: number;        // 콤보 10
  dwellAt1x: number;           // 통과형 링 체류 0.8초 @1.0x
  dwellAt3x: number;           //                  0.3초 @3.0x
  attackPeriodAt1x: number;    // 체류형 공격 주기 3.0초 @1.0x
  attackPeriodAt3x: number;    //                  1.5초 @3.0x
  dwellScale: number;          // 튜닝 패널용 체류시간 배수
  attackPeriodScale: number;   // 튜닝 패널용 공격주기 배수

  // ── 기획서 v2 5장: 입력 분류 (✅ M1 검증, 오분류 0.0%) ──
  tapMaxDistancePt: number;    // ✅ 24pt
  tapMaxDurationMs: number;    // ✅ 200ms
  swipeSpeedThresholdPtMs: number; // ✅ 0.5pt/ms (M1 검수 잠정 확정)

  // ── 기획서 v2 5장: 2스탠스 (M1 잠정치 이월) ──
  umbrellaTrajWidthPt: number; // 우산 34pt
  swordTrajWidthPt: number;    // 검 14pt
  umbrellaRejudgeMs: number;   // 우산 260ms
  swordRejudgeMs: number;      // 검 110ms

  // ── 기획서 v2 8장: 도약 ──
  gaugePerLowKill: number;     // 하급 1기 = 5%
  /** 게이지 배율 적용 A/B (기획서 v2 7장 미결 / 17장 검증 4). 기본 OFF = HQ 권장안 */
  gaugeMultiplierEnabled: boolean;
  diveDurationSec: number;     // 2.5초 무적
  diveEndSpeed: number;        // 종료 후 3.0x 강제
  diveToggleLockSec: number;   // 1초 토글 잠금
  diveSpeed: number;           // ★ 도약 비행 속도 (units/s)
  diveKillStaggerSec: number;  // ★ 순차 자동 격파 간격

  // ── 기획서 v2 9장: 생존 ──
  maxHp: number;               // 5칸
  contactDamage: number;       // 1
  invulnSec: number;           // 피격 무적 0.5초

  // ── 기획서 v2 10장: 적 ──
  stayCap: number;             // 체류형 동시 상한 4기
  telegraphSec: number;        // 공격 예고 0.6초
  a4Hp: number;                // a-4 베기 2회
  a5ExposeSec: number;         // a-5 발사 후 1초 노출
  a5Hp: number;                // a-5 본체 1회 (M1 검수 질문 4 확정)
  projectileSpeed: number;     // ★ 투사체 속도 (units/s)

  // ── 2D 지오메트리 (기획서 v2 4장·17장 5) ──
  /** 판정 영역 방식 A/B — 지시문 P1 r2 개정. 'circle' = 원형 링(원안), 'band' = 화면 밴드(AD 권고안) */
  judgeArea: JudgeAreaKind;
  /** 판정 링 반경 — 화면 폭 대비 비율. HQ 검수 결정: 기획서 "60~70%"는 **지름** 기준 */
  ringRadiusFrac: number;
  /** 밴드 높이 — 화면 폭 대비 비율. 초기값은 원 지름과 등가 (r2 지시문) */
  bandHeightFrac: number;
  /** 소녀 화면 세로 위치 (0=상단, 1=하단). 기획서 4장 "40~45%" */
  girlScreenFrac: number;
  approachSpeed: number;       // ★ 접근 속도 기본 (units/s, ×현재 낙하 속도)
  spawnMargin: number;         // ★ 화면 밖 스폰·프레임아웃 여유
  orbitRadiusFactor: number;   // 체류형 선회 반경 (×링 반경) — 혼잡도 손잡이
  orbitSpreadDeg: number;      // 체류형 배치각 분산 (360 = 전방위) — 혼잡도 손잡이
  orbitSpeedDegSec: number;    // ★ 선회 각속도
  a5EdgeFactor: number;        // ★ a-5 대기 위치 (×링 반경) — 링 밖
  a5ExposeFactor: number;      // ★ a-5 노출 위치 (×링 반경) — 링 안
  formationSpacing: number;    // ★ a-3 편대 간격

  // ── 연출 (기획서 v2 4장) ──
  zoomMax: number;             // 최고속 줌 1.06
  shakeStrength: number;       // ★ 셰이크 강도 (px @3.0x)
  scrollSpeedCoef: number;     // ★ 배경 스크롤 속도 계수
  objectDensity: number;       // ★ 3D 오브젝트 레이어 밀도 (0~1)
  hitstopMs: number;           // 히트스톱 40ms
  slashLifeSec: number;        // ★ 베기 궤적 잔광 지속 (액션 체감 튜닝 손잡이)

  // ── r3 손맛 주스 (기획서 v2.2 16장 1번 "손맛" — 전부 프로시저럴/합성음, 항목별 조절) ──
  /** 1. 파편 버스트: 적 색상 파편 수 / 흰 코어 스파크 수 / 분사 속도 / 지향성(0=방사, 1=스와이프 방향) */
  burstDebrisCount: number;
  burstSparkCount: number;
  burstSpeed: number;
  burstDirectionality: number;
  burstLifeSec: number;
  /** 파편 총량 상한 — 다중 격파 시 과부하 방지 */
  particleBudget: number;
  /** 2. 임팩트 플래시 강도(0=끔) / 격파 스프라이트 스케일 팝 지속 */
  impactFlashStrength: number;
  deathPopMs: number;
  /** 3. 카메라 펀치 줌킥 비율(0=끔) / 복귀 시간 */
  cameraPunch: number;
  cameraPunchMs: number;
  /** 4. 격파음: 전체 게인(0=끔) / 연속 격파 피치 스택 상한 / 동시발음 제한 */
  killSoundGain: number;
  killPitchStackMax: number;
  soundVoiceLimit: number;
  /** 5. 밴드 히트 플래시 강도(0=끔) / 지속 */
  bandFlashStrength: number;
  bandFlashMs: number;
  /** 6. 배율 UI 펄스 강도(0=끔) */
  uiPulseStrength: number;
  /** 7. 다중 격파 시 히트스톱 연장 허용 + 상한 */
  hitstopMultiEnabled: boolean;
  hitstopMultiMaxMs: number;
  pixelScaleMode: PixelScaleMode; // 픽셀 스케일링 정책 검증 (기획서 v2 17장 7)
  pixelScaleFactor: number;    // 정수 배율 (2/3/4)

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
  gaugeMultiplierEnabled: false,
  diveDurationSec: 2.5,
  diveEndSpeed: 3.0,
  diveToggleLockSec: 1.0,
  diveSpeed: 1.1,
  diveKillStaggerSec: 0.06,

  maxHp: 5,
  contactDamage: 1,
  invulnSec: 0.5,

  stayCap: 4,
  telegraphSec: 0.6,
  a4Hp: 2,
  a5ExposeSec: 1.0,
  a5Hp: 1,
  projectileSpeed: 0.4,

  judgeArea: 'band', // ✅ 2026-08-27 실기기 A/B 판정으로 확정 (기획서 v2.2 15장)
  ringRadiusFrac: 0.33,
  bandHeightFrac: 0.66, // = 원 지름 등가
  girlScreenFrac: 0.42,
  approachSpeed: 0.22,
  spawnMargin: 0.18,
  orbitRadiusFactor: 0.78,
  orbitSpreadDeg: 360,
  orbitSpeedDegSec: 26,
  a5EdgeFactor: 1.12,
  a5ExposeFactor: 0.72,
  formationSpacing: 0.105,

  zoomMax: 1.06,
  shakeStrength: 4,
  scrollSpeedCoef: 1.0,
  objectDensity: 0.6,
  hitstopMs: 40,
  slashLifeSec: 0.3,

  burstDebrisCount: 14,
  burstSparkCount: 7,
  burstSpeed: 1.15,
  burstDirectionality: 0.6,
  burstLifeSec: 0.42,
  particleBudget: 220,
  impactFlashStrength: 1.0,
  deathPopMs: 140,
  cameraPunch: 0.018,
  cameraPunchMs: 70,
  killSoundGain: 1.0,
  killPitchStackMax: 6,
  soundVoiceLimit: 4,
  bandFlashStrength: 1.0,
  bandFlashMs: 120,
  uiPulseStrength: 0.35,
  hitstopMultiEnabled: true,
  hitstopMultiMaxMs: 60,
  pixelScaleMode: 'native',
  pixelScaleFactor: 3,

  scoreLow: 100,
  scoreMid: 300,
  scoreProjectile: 50,
};

/** 런타임 설정: 튜닝 패널이 이 객체를 직접 수정한다. */
export const config: BalanceConfig = { ...DEFAULT_BALANCE };

export function resetConfig(): void {
  Object.assign(config, DEFAULT_BALANCE);
}

/** 속도 정규화 0..1 */
export function speedT(speed: number, cfg: BalanceConfig = config): number {
  return (speed - cfg.speedMin) / (cfg.speedMax - cfg.speedMin);
}

/**
 * 통과형 링 체류 시간 (속도 선형 보간).
 * 링 반경 확대는 체류 시간 증가와 등가(기획서 12.1)이나, 2D에서는 반경이 커지면
 * 통과 경로(현)가 자연히 길어져 체류가 늘어나므로 별도 보정을 넣지 않는다 (M1 대비 변경점).
 */
export function dwellTime(speed: number, cfg: BalanceConfig = config): number {
  const t = speedT(speed, cfg);
  return (cfg.dwellAt1x + (cfg.dwellAt3x - cfg.dwellAt1x) * t) * cfg.dwellScale;
}

/** 체류형 공격 주기 (속도 선형 보간) */
export function attackPeriod(speed: number, cfg: BalanceConfig = config): number {
  const t = speedT(speed, cfg);
  return (cfg.attackPeriodAt1x + (cfg.attackPeriodAt3x - cfg.attackPeriodAt1x) * t) * cfg.attackPeriodScale;
}

/** 속도에 따른 카메라 줌 (기획서 v2 4장: 1.0 → 1.06) */
export function zoomForSpeed(speed: number, cfg: BalanceConfig = config): number {
  return 1 + (cfg.zoomMax - 1) * speedT(speed, cfg);
}
