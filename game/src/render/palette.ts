/**
 * 확정 팔레트 — `docs/art/fx_palette_p15.md` · `docs/art/background_p15.md` (AD, 2026-08-28).
 * 색상값의 단일 출처. 코드 어디서도 hex를 직접 쓰지 않는다.
 *
 * 예약 규칙 (fx_palette §1):
 *  - 핫 마젠타는 **소녀 전용** (피격 플래시) — 배경·적·UI·일반 이펙트 사용 금지
 *  - 콜드 시안 = 플레이어 액션 이펙트 / 바이올렛 = 적 액센트 / 화이트 = 임팩트 코어(1~2프레임)
 *  - 점등은 **새 색상을 얻지 않는다** — 명도 점프 + 외곽 발광으로만 표현 (민트 폐기)
 */

// ── 역할별 예약색 ──
export const HOT_MAGENTA = 0xe60986;   // 소녀 전용
export const COLD_CYAN = 0x63dce3;     // 플레이어 액션 이펙트
export const CYAN_MID = 0x3ec2c1;      // 소녀 림라이트
export const CYAN_DEEP = 0x3c81a2;     // 저명도 시안 (적 눈·파편 하이라이트·밴드 진입)
export const VIOLET = 0x8a5cd8;        // 적 액센트
export const WHITE = 0xffffff;         // 임팩트 코어

// ── 배경 (background_p15 §1·2) ──
/** 스카이 5단 밴딩 — 위에서 아래로 */
export const SKY_BANDS = [0x0c0f25, 0x131b3c, 0x1d2c51, 0x23476c, 0x3c81a2] as const;
/** 각 단의 경계 위치 (화면 세로 0=상단 ~ 1=하단) */
export const SKY_STOPS = [0.18, 0.40, 0.62, 0.82] as const;
export const NEAR_BLACK = 0x0c0f25;

/** 구름 2장 — 색·알파·패럴랙스 배속 */
export const CLOUD_LAYERS = [
  { color: 0x1f3157, opacity: 0.40, parallax: 0.25 },
  { color: 0x21395f, opacity: 0.55, parallax: 0.55 },
] as const;

/** 캐릭터 뒤 소프트 비네트 — 가독성 필수 요소 (background_p15 §1.1, 끄지 않는다) */
export const VIGNETTE = { color: NEAR_BLACK, alpha: 0.45, radiusFrac: 0.25 } as const;

// ── 밴드 라인 (fx_palette §2.4) ──
export const BAND_IDLE = { color: 0x24274d, alpha: 0.35 } as const;
export const BAND_ENEMY_IN = { color: CYAN_DEEP, alpha: 0.70 } as const;
export const BAND_KILL = { color: COLD_CYAN, alpha: 1.0 } as const;

// ── 격파 파편 (fx_palette §2.3) ──
/** 적 본체 색에서 채취한 파편 색 */
export const DEBRIS_COLORS = [0x1d2c51, 0x23476c, 0x214066] as const;
/** 파편의 20%만 명도 점프 */
export const DEBRIS_HIGHLIGHT = CYAN_DEEP;
export const DEBRIS_HIGHLIGHT_RATIO = 0.2;

// ── 속도선 (fx_palette §2.6) ──
export const SPEEDLINE_SLOW = 0x707da2;
export const SPEEDLINE_FAST = CYAN_DEEP;
/** 화면 중앙 40%는 항상 클린 — 속도선을 배치하지 않는 반경 (화면 폭 비) */
export const SPEEDLINE_CENTER_CLEAR = 0.20;

// ── 점등 (fx_palette §2.5) — 색이 아니라 명도 ──
/** 판정 영역 진입: 명도 점프 배수 */
export const LIT_BRIGHTNESS = 1.45;
/** 공격 예고: 더 강한 명도 점프 */
export const TELEGRAPH_BRIGHTNESS = 1.8;
/** 외곽 발광 — 대상 뒤에 깔리는 확대 실루엣의 배율·알파 */
export const GLOW_SCALE = 1.16;
export const GLOW_ALPHA = 0.6;

// ── 3D 오브젝트 레이어 (background_p15 §3 — 색만 예약) ──
export const RUIN_BODY = 0x131b3c;
export const RUIN_EDGE = 0x23476c;
