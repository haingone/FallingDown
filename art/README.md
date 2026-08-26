# `art/` — 아트 산출물 인덱스

> 관리: 아트 디렉터(AD) 세션
> 현재 단계: **컨셉아트 탐색 종료 / 방향 확정.** 에셋 제작은 스토리·개발 방향 재정리 이후 착수한다.

## 확정된 방향 (2026-08-26)

| 항목 | 확정값 |
|---|---|
| 그래픽 형식 | **2.5D** — 캐릭터·몬스터·이펙트·UI = 2D 픽셀 아트 / 배경 일부 3D |
| 카메라 | **정측면 + Y축 낙하** (원근·소실점 없음) |
| 캐릭터 비율 | **2등신 SD** |
| 매력 배분 | **몸은 귀엽게, 액션은 멋지게** — 멋짐은 이펙트·모션·연출이 담당 |
| 생성 모델 | **Seedream 5.0 Pro** 고정 |

상세 경위와 근거는 `docs/art/direction_pivot_2_5d.md`.

## 디렉터리

### `concept_pixel_2head/` — **현행 확정 방향 컨셉아트 (보고용)**

2등신 픽셀 아트 방향의 채택본. 아래 8개 파일이 현재 방향을 대표한다.

| 파일 | 내용 |
|---|---|
| `PX1_girl_sheet.png` | 소녀 스프라이트 시트 — 우산 접음/펼침, 검 연격, 돌진, 피격, 팔레트 |
| `PX2_duo.png` | 소녀 + 까마귀, 표정 세트, 소형 가독성 테스트 |
| `PX3_mockup_fall.png` | 인게임 목업 — 일반 낙하 (x1.6) |
| `PX4_mockup_leap.png` | 인게임 목업 — 도약 + 광역 베기 (x3.0) |
| `PX5_key_visual.png` | 키 비주얼 포스터 |
| `PX6_enemy_sheet.png` | 적 스프라이트 시트 — 3타입, 편대, 실루엣 식별 검증 |
| `_sheet_sprites.png` | 스프라이트 시트 3종 묶음 뷰 |
| `_sheet_screens.png` | 인게임·키비주얼 3종 묶음 뷰 |

**대표 컷: `PX4_mockup_leap.png`** — "귀여운 몸 + 멋진 액션"이 성립함을 보여주는 기준 이미지.

### `characters/` — 캐릭터 시트 v0.1 (초안)

| 파일 | 내용 | 상태 |
|---|---|---|
| `CS1_girl_model_sheet.png` | 소녀 모델 시트 — 턴어라운드·상태·표정·디테일·팔레트 | 초안 (비율 미달) |
| `CS2_girl_action_sheet.png` | 액션 프레임 시트 | 초안 (비율 미달) |
| `CS3_crow_sheet.png` | 까마귀 6종 + 스케일·실루엣 검증 | **확정 가능 수준** |

검수 내역은 `docs/art/character_sheet_v0.md`. CS1·CS2는 2등신 미달과 액센트 컬러 부재로 재생성 대상이나, **에셋 제작 착수 전이므로 현 단계에서는 보류**한다.

### `_archive/` — 폐기·대체된 탐색본 (이력 보존용)

의사결정 경위 추적을 위해 보존한다. **어느 것도 현행 방향이 아니다.**

| 폴더 | 내용 | 폐기 사유 |
|---|---|---|
| `rejected_v0_1/` | HQ 1차 아트 디렉션 컨셉 4종 | 사용자 반려 (2026-08-21) |
| `concept/`, `mockup/` | 3D 툰셰이딩 탐색 라운드 1 (컨셉 10 + 목업 10) | 전량 반려 |
| `seedream/` | 3D 툰셰이딩 라운드 2 목업 10 | 2.5D 전환으로 폐기 |
| `seedream_r3/`, `seedream_r4/`, `seedream_r4c/`, `seedream_r4d/` | 3D 카메라·자세·크롭 교정 라운드 | 2.5D 전환으로 폐기 |
| `seedream_fpv/` | 3D 1인칭 카메라 규격 탐색 | 2.5D 전환으로 폐기 |
| `pixel_3head/`, `pixel_3head_sd/` | 3등신 픽셀 대조군 | 2등신 확정으로 미채택 |

## 문서

| 문서 | 내용 |
|---|---|
| `docs/art/direction_pivot_2_5d.md` | **현행 방향의 정본** — 2.5D 전환 경위, 카메라 규격, 확정 사항, 기획서 개정 필요 항목 |
| `docs/art/character_sheet_v0.md` | 캐릭터 시트 v0.1 검수 |
| `docs/art/AD_milestones.md` | AD 자체 마일스톤 (3D 전제로 작성 — **개정 필요**) |
| `docs/art/interview_01.md` | 사용자 인터뷰 1회차 기록 |
| `docs/art/style_exploration.md`, `style_exploration_r2.md` | 3D 방향 탐색 기록 (이력) |
| `docs/art/art_direction.md` | HQ 1차 초안 (반려됨) |
