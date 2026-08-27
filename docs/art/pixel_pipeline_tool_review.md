# 픽셀 변환 툴 비교 — Sprite-Gen vs Perfect Pixel

> 작성: 아트 디렉터(AD) 세션 / 2026-08-27
> 대상: AI 생성 이미지를 **게임에 실제로 쓸 수 있는 픽셀 아트 스프라이트**로 변환하는 용도
> 검토 방식: 두 저장소를 직접 클론해 SKILL.md / readme / 소스 코드 확인
> - `aldegad/sprite-gen` — v1.59.0, Apache-2.0, Python 17,882 LOC
> - `theamusing/perfectPixel` — MIT, Python 943 LOC

---

## 1. 결론

| | 판정 |
|---|---|
| **본 프로젝트 채택** | **Sprite-Gen** |
| Perfect Pixel | 보조 — 사전 점검용 / 단발 변환용으로만 |

**두 툴은 경쟁 관계가 아니다.** Perfect Pixel은 "그리드 검출 + 리샘플" 이라는 **한 단계를 푸는 라이브러리**이고, Sprite-Gen은 그 단계를 포함한 **스프라이트 제작 파이프라인 전체**다. 규모 차이(943 LOC vs 17,882 LOC)가 그대로 범위 차이다.

결정적 근거는 아래 §3의 **두 가지 구조적 결격**이다 — Perfect Pixel은 알파 채널과 팔레트 통일을 다루지 않는데, 이 둘은 게임 스프라이트의 필수 조건이다.

---

## 2. 각 툴이 실제로 하는 일

### Perfect Pixel

```
RGB 이미지 → FFT 크기 스펙트럼으로 그리드 피치 검출
          → Sobel 엣지로 그리드선 정렬 보정
          → 셀별 샘플링(center / median / majority)
          → 정렬된 저해상 RGB 이미지
```

- **입력**: `RGB 이미지 (H×W×3)`
- **출력**: `refined_w, refined_h, scaled_image`
- **공개 API**: `get_perfect_pixel()` 함수 하나
- 배포: `pip install perfect-pixel`, ComfyUI 커스텀 노드 제공, 웹 데모 있음
- OpenCV 백엔드 / NumPy 전용 백엔드 2종

### Sprite-Gen

```
sprite-request.json (SSoT)
  → 레이아웃 가이드 + 프롬프트
  → 상태별 row 이미지 생성 (또는 외부 PNG 반입)
  → 크로마 키 알파 제거
  → 연결 성분(connected component)으로 프레임 분리
  → [프레임별] 엣지 정렬 피치 검출 → 위상 실측 → 그리드 스냅
  → kCentroid 다운스케일 → run 전체 공유 팔레트 → 알파 이진화 → 정수 NEAREST 확대
  → 셀 배치 → sprite-sheet-alpha.png + manifest.json
```

부가 기능: 큐레이션 웹뷰(후보 나란히 비교·선택), 팔레트 스왑 베이크(리컬러), QA 스코어링, 프레임 보간, GIF 프리뷰, 엔진 익스포트.

---

## 3. 본 프로젝트 요구사항 대조

인터뷰 2회차 확정 사양 기준.

| 요구사항 | Sprite-Gen | Perfect Pixel |
|---|---|---|
| 48×48 해상도 스냅 | ✅ `--fit-logical-height` (셀 높이의 정수 약수) | ✅ 자동 검출 또는 `grid_size` 수동 지정 |
| **32~48색 팔레트** | ✅ `--fit-palette-size` — **run 전체 공유 median-cut** | ❌ **팔레트 양자화 기능 없음** |
| **알파(투명 배경)** | ✅ 크로마 키 → 알파 이진화 | ❌ **알파 채널 미지원** (RGB 전용) |
| 아웃라인 없음 | ✅ `--fit-outline {on,off,STRENGTH}` | — (해당 개념 없음) |
| 애니메이션 프레임 | ✅ 프레임 분리·정렬·보간·아틀라스 | ❌ 단일 이미지 전용 |
| **프레임 간 색 흔들림 방지** | ✅ 공유 팔레트가 이 목적으로 존재 | ❌ 이미지마다 독립 처리 → 플리커 발생 |
| 프레임 간 위치 지터 방지 | ✅ `align_x: foot-centroid / alpha-centroid` | — |

### 결격 1 — 알파 채널

소스 코드에서 `alpha` / `RGBA` / `palette` / `quantize` 검색 결과 **0건**. `get_perfect_pixel()`은 RGB 3채널만 받고 3채널만 돌려준다.

게임 스프라이트는 배경이 투명해야 한다. Perfect Pixel만 쓰면 배경 제거를 별도 툴로 처리한 뒤, 그 결과의 알파를 보존한 채 다시 합성해야 한다 — 그런데 그리드 스냅이 알파를 모르면 반투명 경계가 그대로 남는다.

### 결격 2 — 팔레트 통일

32~48색으로 묶기로 확정했는데 Perfect Pixel에는 양자화가 없다. 더 중요한 건 **프레임 간 색 일관성**이다. 낙하·베기·도약 프레임을 각각 독립 변환하면 프레임마다 미세하게 다른 색이 나와 재생 시 **색 플리커**가 생긴다. Sprite-Gen의 `run-wide shared median-cut palette`는 정확히 이 문제를 위해 있다(문서에 "kills frame-to-frame color flicker"로 명시).

---

## 4. 그리드 검출 알고리즘 자체의 비교

두 툴의 핵심 단계가 겹치는 부분이다. **이 지점에서도 Sprite-Gen이 더 정교하다.**

| | Sprite-Gen | Perfect Pixel |
|---|---|---|
| 피치 검출 | 엣지 정렬 스코어링 (그리드선 ±w에 색 경계가 모이는 비율 − 우연 기대치의 argmax) | FFT 크기 스펙트럼 피크 + 그래디언트 |
| 피치 정밀도 | **소수(fractional)** — "AI 도트의 블록 폭은 정수로 안 떨어진다(예 17.24px)" | 정수 기반 |
| 위상(phase) 결정 | **실측** — 후보 위상마다 셀 균일도를 채점해 최선 선택 | 히스토그램 근사 |
| 적용 단위 | **프레임별** (합의 피치는 검출 실패 시 fallback) | 이미지 단위 |
| 디테일 보존 | `detail_bias` — 근-검정 소수 클러스터 우선(눈·아웃라인이 다수결에 먹히지 않게) | 샘플링 방식 선택(center/median/majority)만 |

Sprite-Gen 문서는 위상 근사의 실패 사례까지 수치로 기록해 두었다 — 히스토그램 위상이 참 위상에서 최대 pitch/2까지 밀려 캐릭터 눈 4행이 3행으로 병합된 회귀. Perfect Pixel이 쓰는 방식이 정확히 그 히스토그램 근사다.

**단, 이건 "Perfect Pixel이 나쁘다"가 아니라 "용도가 다르다"로 읽어야 한다.** 단일 이미지를 깔끔하게 정렬하는 데는 943 LOC로 충분하고, 실제로 잘 작동한다.

---

## 5. Sprite-Gen 채택 시 감수할 것

정직하게 짚는다.

| 항목 | 내용 |
|---|---|
| **복잡도** | 17,882 LOC, 다수의 BLOCKING 게이트, 20개 문서. 학습 곡선이 있다 |
| **환경 요구** | 레포 루트 venv 강제(`.venv/bin/python`). 전역 `python3` 사용 금지가 명시적 규칙 |
| **생성 백엔드** | `sprite-gen gen`은 `codex`(ChatGPT OAuth) 또는 `grok`(xAI OAuth) CLI를 요구 |
| 의존 | Python + Pillow + NumPy (순수 파이썬 폴백 없음 — 의도적) |

### ⚠ 생성 백엔드 문제 — 우리는 Seedream을 쓴다

본 프로젝트는 이미지 생성을 **Seedream 5.0 Pro로 고정**했다. Sprite-Gen의 `gen` 단계는 codex/grok을 전제한다.

**해결됨:** Sprite-Gen은 **외부 생성 이미지 반입 경로를 공식 지원**한다.

```
unpack_atlas_run.py --pngs-dir <PNG 폴더> --out-dir <run 디렉터리>
```

`docs/run-contract.md` §4에 "Import-run source rule (`--pngs-dir`)"로 규격이 문서화돼 있고, `docs/curation.md`에도 실행 예시가 있다. 즉 **Seedream으로 생성 → PNG 폴더로 반입 → Sprite-Gen의 추출·스냅·팔레트 경로만 사용**하는 구성이 가능하다. 생성은 우리 방식대로, 변환은 Sprite-Gen으로 간다.

---

## 6. ⚠ 우리 워크플로에 직접 걸리는 경고

Sprite-Gen 문서가 반복해서 경고하는 실패 모드가 **현재 우리 상황과 정확히 일치한다.**

> `fit.pixel_unfake` 런에 AA/벡터풍 베이스를 붙이면 프롬프트에 "TRUE 32x32 pixel art"를 적어도 raw가 도트로 나오지 않는다. (…) 프롬프트 문구로 베이스의 스타일을 이기려 하지 마라.

> 픽셀 밀도는 프롬프트가 아니라 **레퍼런스가 지배한다.** 고해상 가짜-도트(1024px+ 생성물)를 붙이면 그 고밀도를 따라가 로지컬 축소에서 뭉개진다.

**현재 우리 컨셉아트가 정확히 "고해상 가짜-도트"다.** Seedream이 2496×1664로 뽑은, 픽셀처럼 보이지만 그리드가 균일하지 않은 이미지다. 이미 `character_sheet_v0.md`와 `direction_pivot_2_5d.md`에 "방향 제시용이며 스프라이트로 직접 쓸 수 없다"고 기록해 둔 것과 같은 지적이다.

**대응:** Sprite-Gen의 Base Lock Gate를 따른다 — 먼저 **픽셀 격자가 실측으로 검출되는 진짜 저해상 베이스 1장**을 확보해 잠그고, 그것을 스타일 레퍼런스로 삼아 나머지를 생성한다. 베이스가 가짜-도트면 뒤가 전부 무너진다.

---

## 7. 권고 구성

```
[생성]        Seedream 5.0 Pro
                ↓ (PNG 폴더)
[반입]        sprite-gen unpack_atlas_run --pngs-dir
                ↓
[변환]        sprite-gen 추출 경로
              피치 검출 → 위상 실측 → 그리드 스냅
              → kCentroid → 공유 팔레트(32~48색) → 알파 이진화
                ↓
[검수]        sprite-gen 큐레이션 웹뷰 (인간이 채택 여부 결정)
                ↓
[산출]        sprite-sheet-alpha.png + manifest.json
```

**Perfect Pixel의 자리:** 버리지 않는다. `pip install perfect-pixel` 한 줄이면 되고 ComfyUI 노드도 있으므로, **"이 AI 이미지에 검출 가능한 픽셀 그리드가 있는가?"를 30초 만에 확인하는 사전 점검 도구**로 쓸 수 있다. Base Lock Gate 판정을 빠르게 내리는 데 유용하다. 단, 최종 에셋 경로에는 넣지 않는다.

---

## 8. 다음 액션

| # | 내용 | 담당 |
|---|---|---|
| 1 | Sprite-Gen 설치·venv 부트스트랩, `--pngs-dir` 반입 경로 실측 검증 | 사용자 / 개발 |
| 2 | 진짜 저해상 베이스 1장 확보 (Base Lock Gate 통과본) | AD |
| 3 | 베이스 잠금 후 그것을 레퍼런스로 나머지 스프라이트 생성 | AD |
| 4 | 계획서 8장 리스크의 "픽셀 에셋 제작 파이프라인" 항목을 본 구성으로 확정 | HQ |

---

# 부록 — PerfectPixel Studio 검토 (2026-08-27 추가)

> 대상: `Canine89/perfectpixel-studio` @ `openai-gpt-image-2-support` (upstream `gykim80/perfectpixel-studio`)
> MIT · Go 1.25 + Wails v2 + React 18 · 데스크톱 앱 + 헤드리스 CLI(`ppgen`) + Claude Code 스킬 3형태

**앞선 §3의 `theamusing/perfectPixel`(943 LOC 라이브러리)과는 이름만 비슷할 뿐 완전히 다른 프로젝트다.** 혼동하지 말 것.

## 1. 정체

**AI 애니메이션 스프라이트 생성 스튜디오.** 텍스트 설명 한 줄 → 베이스 캐릭터 → 100여 종 동작 애니메이션 → 8방향 세트 → 게임 엔진용 번들 익스포트까지의 완결 파이프라인.

`sprite-gen` 문서가 `alpha-centroid` 정렬을 이 프로젝트에서 포팅해 갔다고 명시하고 있다(`internal/sprite/extract.go`, MIT). 즉 **두 프로젝트는 같은 문제를 푸는 동류이고, 서로 참조 관계가 있다.**

## 2. 결정론적 보정 4축 — 기술적으로 매우 견고하다

README가 "휴리스틱이 아니라 신호처리"라고 요약하는데, 실제 구현이 그 말에 부합한다. 각 축마다 **전/후 비교를 실측 수치와 함께** 제시한다.

| 축 | 기법 | 실측 근거 |
|---|---|---|
| **배경 제거** | RGB threshold 대신 **YCbCr 색차 매팅** — luma 버리고 Cb/Cr만 사용. 배경 키를 CbCr 히스토그램 **mode**로 추정(평균 아님), Hermite smoothstep 페더링, despill, 4-connectivity flood fill | 마젠타 잔여 2,739px → **2px** |
| **프레임 분할** | OCR의 **projection profile + DP 전역 최적 절단**. 세로 알파 투영의 valley를 찾고, 포즈가 붙으면 `Σ P[cut] + λ(width−ideal)²` 최소화 | 9프레임 스트립에서 캐릭터를 가로지르는 절단선 **8개 → 0개** |
| **프레임 정렬** | **알파 가중 무게중심**(`cx = Σ(x·α)/Σα`)을 셀 중앙에 정렬. 팔다리를 뻗어도 torso가 고정 | 지터 σ **27.2px → 0.2px (약 135배)** |
| **픽셀아트화** | 전 프레임 **공유 팔레트** median-cut(프레임별 양자화는 플리커 유발) + 동일색 run length 최빈값으로 블록 크기 추정 후 **grid snap**. 색 거리에 인간 시각 가중 `2dr²+4dg²+3db²` | 색 7,834 → **12가지**, 경계 또렷 |

여기에 **자기 보정 루프**가 얹힌다 — 생성 → 검사 → 결함을 영문 교정 지시로 변환해 다음 프롬프트에 주입 → 재생성(최대 3회). `score = Found×100 − errors×10`으로 best-candidate를 보관해 빈손을 주지 않는다. 품질은 **64-bin RGB 히스토그램 + dHash 지각 해시** 2축으로 identity drift를 재고, motion presence(사실상 정지 화면)까지 0~100점으로 채점한다.

## 3. 본 프로젝트 요구사항 대조

| 요구사항 | PerfectPixel Studio |
|---|---|
| 48×48 해상도 | ✅ `CellSize` 지정 가능 |
| 32~48색 팔레트 | ✅ 공유 팔레트 median-cut |
| 알파(투명 배경) | ✅ **YCbCr 매팅** — 세 툴 중 가장 정교 |
| 아웃라인 없음 | ✅ (아웃라인 강제 없음) |
| 애니메이션 프레임 | ✅ 100여 종 프리셋 + 프레임 수 보정 루프 |
| 프레임 간 색 플리커 | ✅ 공유 팔레트 |
| 프레임 간 위치 지터 | ✅ 알파 가중 무게중심 (σ 0.2px) |
| 정측면 Y축 낙하 | ⚠ 프리셋이 **횡스크롤 액션 게임 기준**(걷기·달리기·공격). 낙하 전용 프리셋은 없으나 커스텀 상태 입력 가능 |
| 게임 엔진 익스포트 | ✅ 스프라이트시트 + manifest.json + Aseprite JSON + GIF/APNG + 개별 PNG |

## 4. ⚠ 결정적 제약 — 외부 베이스 이미지 반입

**우리 워크플로의 핵심 질문: Seedream으로 만든 캐릭터를 베이스로 넣을 수 있는가?**

소스를 직접 확인한 결과 **형태에 따라 답이 갈린다.**

| 형태 | 외부 베이스 반입 | 근거 |
|---|---|---|
| **데스크톱 앱 (Wails GUI)** | ✅ **가능** | `App.PickImage()` — 파일 다이얼로그 제목이 그대로 "베이스 이미지 선택". `GenerateStateArgs.BaseImage`(dataURL)로 주입 |
| **헤드리스 CLI (`ppgen`)** | ❌ **불가** | 플래그 전수 확인 결과 `-desc`로 베이스를 **항상 자체 생성**한다. `-input`/`-base` 계열 플래그 없음. `-baseonly`는 "베이스만 생성"이지 "베이스를 받는" 게 아니다 |
| **Claude Code 스킬** | ❌ **불가** | 스킬은 `ppgen` CLI를 구동하므로 CLI 제약을 그대로 상속 |

**즉 사용자가 언급한 "스킬" 형태로는 우리 캐릭터를 쓸 수 없다.** 텍스트 설명으로 새 캐릭터를 만들어 줄 뿐이다. 확정한 소녀 디자인(검은 코트·2등신·마젠타 액센트)을 이어가려면 **데스크톱 앱을 설치해서 GUI로 써야 한다.**

## 5. 프로바이더

| 프로바이더 | 기본 모델 |
|---|---|
| Gemini (기본) | `gemini-3-pro-image` |
| OpenAI *(이 브랜치의 추가분)* | `internal/gen/openai.go` 신규 |
| OpenRouter | `google/gemini-3-pro-image-preview` |
| fal.ai | `fal-ai/nano-banana-pro` |
| **BytePlus** | **`seedream-4-0-250828`** |

**BytePlus를 지원하므로 Seedream 계열을 쓸 수 있다** — 다만 등록된 모델 목록은 `seedream-4-0-250828` / `seedream-3-0-t2i-250415`로, **우리가 고정한 5.0 Pro는 목록에 없다.** `-model` 플래그로 강제 지정은 가능하나 어댑터가 5.0 Pro를 받는지는 **미검증**이다. 실측 필요.

## 6. 세 툴 최종 비교

| | **sprite-gen** | **PerfectPixel Studio** | **perfectPixel (라이브러리)** |
|---|---|---|---|
| 성격 | 스프라이트 파이프라인 (에이전트 스킬) | 스프라이트 **스튜디오** (GUI 앱 + CLI + 스킬) | 그리드 정렬 **라이브러리** |
| 규모 | 17,882 LOC Python | Go + React 풀스택 | 943 LOC Python |
| 알파 | ✅ 크로마 키 | ✅ **YCbCr 매팅 (최정교)** | ❌ |
| 공유 팔레트 | ✅ | ✅ | ❌ |
| 프레임 분할 | 연결 성분 | ✅ **projection + DP 최적 절단** | ❌ |
| 지터 방지 | foot/alpha-centroid | ✅ alpha-centroid (σ 0.2px) | ❌ |
| 그리드 스냅 | ✅ **소수 피치 + 위상 실측 + 프레임별** | ✅ run length 최빈값 + grid snap | ✅ FFT + Sobel |
| 품질 자동 채점·재생성 | QA 스코어링 | ✅ **0~100점 + 최대 3회 자기 보정 루프** | ❌ |
| **외부 이미지 반입** | ✅ `--pngs-dir` (CLI로 가능) | ⚠ **GUI만 가능**, CLI/스킬 불가 | ✅ (단일 이미지) |
| 사용 형태 | CLI (에이전트가 구동) | GUI 앱 중심 | 라이브러리 |
| 진입 장벽 | 높음 (게이트·문서 다수) | 낮음 (GUI) / Go+Node 빌드 필요 | 최저 |

## 7. 판정 (수정)

앞선 §1의 "Sprite-Gen 채택" 판정을 **조건부로 수정한다.**

### 두 툴은 강점이 갈리며, 워크플로에 따라 답이 다르다

**PerfectPixel Studio가 더 나은 점**
1. **배경 제거 품질** — YCbCr 색차 매팅은 sprite-gen의 크로마 키보다 원리적으로 우수하다. 특히 JPEG 4:2:0 압축에 본질적으로 강건하다는 점은 AI 생성물(대개 압축을 거침)을 다룰 때 실질적 이점이다.
2. **프레임 분할** — DP 전역 최적 절단은 sprite-gen의 연결 성분 방식이 실패하는 케이스(포즈가 서로 닿음)를 정면으로 푼다.
3. **자기 보정 루프** — "프레임 6개 요청했는데 7개 나옴"을 자동으로 잡아 재생성한다. sprite-gen에는 이 수준의 closed loop가 없다.
4. **진입 장벽** — GUI가 있다. sprite-gen은 문서 20개와 다수의 BLOCKING 게이트를 읽어야 한다.

**sprite-gen이 더 나은 점**
1. **그리드 스냅 정밀도** — 소수 피치 + 위상 실측 + 프레임별 적용. PerfectPixel의 run-length 최빈값 방식보다 정교하다(§4 참조).
2. **외부 이미지 반입이 CLI로 된다** — 우리에게 **가장 중요한 차이**다.
3. **에이전트 친화** — 헤드리스로 완결되어 AD 세션이 직접 구동할 수 있다.

### 권고

| 시나리오 | 선택 |
|---|---|
| **확정 캐릭터를 유지하며 애니메이션 제작** (현 계획) | **PerfectPixel Studio 데스크톱 앱** — 베이스 반입이 GUI로만 되므로 사용자가 직접 운용 |
| **AD 세션이 헤드리스로 변환까지 자동화** | **sprite-gen** — `--pngs-dir` 반입이 CLI로 됨 |
| 빠른 그리드 검출 점검 | perfectPixel 라이브러리 |

**AD 권고: PerfectPixel Studio를 1순위로 실측 검증할 것.** 이유는 우리의 실제 병목이 "그리드 스냅 정밀도"가 아니라 **"애니메이션 프레임을 어떻게 뽑을 것인가"** 이기 때문이다. 낙하·베기·도약·피격 프레임을 일관된 캐릭터로 만들어 내는 것이 과제이고, PerfectPixel의 자기 보정 루프 + 프레임 분할 + 지터 방지가 정확히 그 문제를 겨냥한다.

**단, 채택 전에 실측할 것 3가지:**

1. **GUI 베이스 반입 실효성** — Seedream 생성물(고해상 가짜-도트)을 베이스로 넣었을 때 결과가 성립하는가. §6의 경고("픽셀 밀도는 레퍼런스가 지배한다")가 여기에도 적용될 가능성이 높다.
2. **BytePlus 어댑터에서 Seedream 5.0 Pro 사용 가능 여부** — 목록에 없음. `-model` 강제가 통하는지.
3. **정측면 Y축 낙하 프리셋 부재** — 100여 프리셋이 횡스크롤 액션 기준이다. 커스텀 상태로 낙하 모션이 나오는지.

3번이 안 되면 프리셋의 이점이 대부분 사라지고, 그때는 sprite-gen 쪽이 다시 유리해진다.
