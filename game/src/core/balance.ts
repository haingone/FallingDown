/**
 * 밸런스 데이터 모듈 — 기획서(fallingdown_game_design.md) v2.0 4~11장 초기 기준값의 단일 출처.
 * 순수 데이터. three.js/DOM 의존 금지 (로직-렌더링 분리 원칙).
 *
 * 튜닝 패널은 이 객체(runtime config)를 직접 수정하고, 시뮬레이션은 매 스텝 이 값을 읽는다.
 * 기획서에 없는 값(★ 표시)은 임의 선정값이며 전부 리포트(P1_report.md)에 기록한다.
 *
 * P1(HD-2D 전환): 카메라 FOV·소실점 깊이 등 3D 전용 값은 제거되고, 2D 평면 좌표계
 * (worldHeightWu 기준)와 스크롤·줌·셰이크 값으로 대체되었다. 속도 다이얼·게이지·생애주기
 * 규칙 수치는 M1에서 그대로 이월한다.
 */

export type PixelScalingMode = 'native' | 'pixel';

export interface BalanceConfig {
  // ── 기획서 7장: 낙하 속도 시스템 (M1 이월) ──
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

  // ── 기획서 5장: 입력 분류 (M1 검증 완료, 이월) ──
  tapMaxDistancePt: number;    // 24pt (CSS px, DPR 독립)
  tapMaxDurationMs: number;    // 200ms
  swipeSpeedThresholdPtMs: number; // 속도 임계 (pt/ms) — M1 검수 확정 0.5

  // ── 기획서 5/12.3장: 스탠스 (M1 잠정치 이월) ──
  umbrellaTrajWidthPt: number; // 우산: 궤적 판정 폭 (스와이프 선분에 더해지는 반경, CSS px)
  swordTrajWidthPt: number;    // 검: 좁음
  umbrellaRejudgeMs: number;   // 우산: 동일 적 재판정 간격
  swordRejudgeMs: number;      // 검: 연격 빠름

  // ── 기획서 8장: 도약 ──
  gaugePerLowKill: number;     // 하급 1기 = 5% (0.05)
  gaugeMultiplierEnabled: boolean; // ★A/B: 게이지 충전에 배율 곱 적용 여부 (기본 OFF = HQ 권장안)
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
  stayOrbitRadiusScale: number; // ★ 체류형 선회 반경 배수 (×링 반경) — 검증 항목 5 손잡이
  stayArcDeg: number;          // ★ 체류형 배치각 (선회 슬롯이 퍼지는 부채각) — 검증 항목 5 손잡이
  stayOrbitSpeed: number;      // ★ 선회 각속도 (rad/s)

  // ── 기획서 v2 4장: HD-2D 뷰 (2D 평면 좌표계) ──
  worldHeightWu: number;       // ★ 화면 세로 = N world unit (2D 평면 스케일의 기준)
  girlScreenYPct: number;      // 소녀 세로 위치 (기획서 4장: 화면 세로 40~45%)
  ringRadiusWu: number;        // 판정 링 반경 (world unit). 화면 폭 대비 %는 ringRadiusScreenPct()
  zoomMax: number;             // 최고속 카메라 미세 줌아웃 (기준 1.0 → 1.06)
  shakeIntensity: number;      // ★ 셰이크 강도 배수 (0 = 끔)
  scrollSpeedCoef: number;     // ★ 배경 스크롤 속도 계수
  object3dDensity: number;     // ★ 3D 오브젝트 레이어 동시 배치 수
  hitstopMs: number;           // 히트스톱 30~50ms (기본 40)

  // ── 적 동선 (기획서 v2 4장·10.0장: 하단 진입 → 상방 통과) ──
  spawnDepthWu: number;        // ★ 화면 하단 밖 스폰 깊이 (소녀 기준 아래쪽 wu)
  approachBaseWu: number;      // ★ 접근 속도 기본값 (×현재 낙하 속도)
  entryAngleMaxDeg: number;    // ★ 사선 하단 진입 최대각 (수직 기준 ±°)
  spawnDensityScale: number;   // 튜닝 패널용 스폰 간격 배수 (작을수록 촘촘)

  // ── 점수 (★ 기획서 미정값, M1 이월) ──
  scoreLow: number;
  scoreMid: number;
  scoreProjectile: number;

  // ── 렌더 정책 (기획서 v2 17장 7: 픽셀 스케일링 검증) ──
  pixelScaling: PixelScalingMode; // 'native' | 'pixel'(저해상도 렌더타깃 → 정수 배 업스케일)
  pixelScaleFactor: number;    // 정수 배율 (2~4)
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
  diveSpeedWu: 7.5,
  diveKillStaggerSec: 0.06,

  maxHp: 5,
  contactDamage: 1,
  invulnSec: 0.5,

  stayCap: 4,
  telegraphSec: 0.6,
  a4Hp: 2,
  a5ExposeSec: 1.0,
  projectileSpeedWu: 2.2,
  stayOrbitRadiusScale: 1.0,
  stayArcDeg: 300,
  stayOrbitSpeed: 0.8,

  worldHeightWu: 10,
  girlScreenYPct: 0.42,
  ringRadiusWu: 1.6,
  zoomMax: 1.06,
  shakeIntensity: 1.0,
  scrollSpeedCoef: 1.0,
  object3dDensity: 12,
  hitstopMs: 40,

  spawnDepthWu: 7.2,
  approachBaseWu: 1.2,
  entryAngleMaxDeg: 38,
  spawnDensityScale: 1.0,

  scoreLow: 100,
  scoreMid: 300,
  scoreProjectile: 50,

  pixelScaling: 'native',
  pixelScaleFactor: 3,
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

/**
 * 속도에 따른 카메라 줌아웃 배수 (기획서 v2 4장: 기준 1.0 → 최고속 1.06).
 * 값이 클수록 화면에 담기는 월드가 넓어진다(= 줌아웃). 판정 투영도 동일 값을 쓴다.
 */
export function zoomForSpeed(speed: number, cfg: BalanceConfig = config): number {
  const t = (speed - cfg.speedMin) / (cfg.speedMax - cfg.speedMin);
  return 1 + (cfg.zoomMax - 1) * Math.max(0, Math.min(1, t));
}
