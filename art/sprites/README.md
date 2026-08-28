# art/sprites — 게임 반입용 스프라이트 (P1.5)

> 산출: AD 세션 / 2026-08-28 · 지시 `P1_5_pixel_mockup.md` §A-2
> 소스: `art/characters_v1/` v1r3 (사용자 승인본), `art/concept_pixel_2head/PX6_enemy_sheet.png`
> 개발 세션 반입: `git checkout origin/claude/art-director -- art/sprites/ docs/art/fx_palette_p15.md docs/art/background_p15.md`

## 내용

| 경로 | 셀 | 상태 | 프레임 |
|---|---|---|---|
| `girl/` | 48×48 | `fall_closed` (우산 접음) | 3 |
| | | `fall_open` (우산 펼침) | 3 |
| `enemies/` | 32×32 | `a1_fly` | 2 |
| | | `a3_fly` (a-1 소형 변형·편대용) | 2 |

각 폴더: `sprite-sheet-alpha.png` + `manifest.json` (+ `sprite-request.json`, `*.report.json`).
Sprite-Gen `compose_sprite_atlas` 출력 그대로 — 이것이 개발 반입 규격이다.

## 규격 준수 실측

| 계약 | 실측 |
|---|---|
| 48×48 (소녀) | ✅ 셀 48×48, 아틀라스 144×96 |
| 공유 팔레트 32~48색 | ✅ **38색** (girl 32 + enemies 14, 두 시트 공유) |
| 알파 배경 | ✅ 알파값 {0, 255} 이진 — 소프트 프린지 없음 |
| 아웃라인 없음 (소녀) | ✅ |
| 아웃라인 없음 (적) | ⚠️ **미준수** — 아래 참조 |
| 프레임 최소 (정지 1 + 흔들림 2 이내) | ✅ 소녀 3F / 적 2F |

## 제작 경로 (재현 가능)

1. v1r3 시트에서 포즈 크롭 → 배경 그레이 컬러키 → 알파
2. Sprite-Gen `_kcentroid_downscale(detail_bias=True)` 로 셀 콘텐츠 높이까지 축소
3. `binarize_alpha` → 전 프레임 대상 `build_shared_palette(40)` → `apply_palette`
4. 셀 배치 (소녀 bottom 정렬 · 적 center 정렬) → `frames/` 런 디렉터리 구성
5. `compose_sprite_atlas.py --run-dir` → 시트 + manifest

**pixel_unfake 격자 스냅은 쓰지 않았다.** `detect_pixel_grid` 가 v1r3 시트와 PX6 양쪽에서
격자 확신 없음(`(1.0,1.0)`)을 반환했다 — Seedream 출력의 블록 경계가 스냅에 필요한 만큼
또렷하지 않다. 이 경우의 정규 경로인 `fit.resample=kcentroid` 를 사용했다
(`docs/pixel-unfake.md`: "keeps 1px outlines readable when the generated art's implied pixel
grid does not match the target cell").

## 알려진 편차 (HQ 보고 대상)

1. **적 스프라이트에 1px 다크 아웃라인이 남아 있다.** 소스인 PX6 컨셉이 아웃라인을 두르고
   그려졌고, 크롭 반입 경로에서는 제거할 수 없다. 실사용상 적은 어두운 색이고 배경은 밝은
   시안이므로 아웃라인이 실루엣 경계와 겹쳐 시각적 문제는 없으나, **"아웃라인 없음" 계약과는
   불일치**다. P2에서 적 시트를 v1r3 기준으로 재생성할 때 해소한다.
2. **`fall_open` 의 흔들림 2프레임은 절차적 생성물**이다 — 시트에 펼침 스탠스의 연속 프레임이
   1컷만 있어, 정지 프레임을 세로 ±1px 이동한 아이들 보브로 만들었다. 내용을 지어내지 않았고
   P1.5의 "미세 흔들림" 범위 안이다. 본 애니메이션은 P2에서 제작한다.
3. **적은 좌향, 소녀는 우향**이다. 런타임에서 필요한 쪽을 플립해 쓴다.
