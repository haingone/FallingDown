# FallingDown — P1 HD-2D 전환 프로토타입

> 지시문: `docs/instructions/P1_hd2d_conversion.md` / 기획서: `fallingdown_game_design.md` **v2.0**
> 스택: TypeScript + Vite + three.js (패키지 매니저: npm, lockfile 커밋)

M1(3D 그레이박스)에서 검증된 코어 로직(`src/core/`)을 이월하고 **뷰·판정을 HD-2D 다운 스크롤로 전환**한
프로토타입입니다. 기획서 v2 17장 검증 항목 1·3~8을 실측하며, 측정 결과는 `docs/reports/P1_report.md` 참조.

- 아트 에셋 0개 — 소녀·적은 플레이스홀더 실루엣, 배경·구름·베기 궤적은 전부 프로시저럴 셰이더.
- 판정은 **2D 평면 하나**에서만 일어납니다. 3D 오브젝트 레이어는 순수 연출입니다.

## 실행

```bash
cd game
npm install
npm run dev        # 개발 서버 (--host 포함, LAN 노출)
```

### 폰에서 접속 (게이트 판정용)

1. PC와 폰을 **같은 Wi-Fi**에 연결합니다.
2. `npm run dev` 실행 후 터미널의 `Network:` 주소(예: `http://192.168.0.12:5173`)를 폰 브라우저에서 엽니다.
3. 세로로 들고 플레이합니다 (9:16 고정, 좌우 레터박스).
4. 우측 상단 **⚙ 버튼**으로 튜닝 패널을 열면 FPS·1% low·draw call·오디오 지연·게이지 A/B 수치를
   실시간으로 읽을 수 있습니다.

원격/클라우드 환경이라 LAN 접속이 불가하면 `npm run build` 후 `dist/`를 아무 정적 호스팅
(GitHub Pages, Netlify 등)에 올려 URL로 접속합니다 (순수 정적 빌드, 서버 불필요).

**첫 터치 전에는 소리가 나지 않습니다** (모바일 자동재생 정책). 화면을 한 번 탭하면 해제됩니다.

## 빌드 / 테스트

```bash
npm run build      # 타입체크 + dist/ 정적 빌드 (gzip 약 148KB)
npm run preview    # 빌드 결과 로컬 서빙
npm test           # Playwright 자가 검증 (22 테스트)
```

- 테스트는 사전 설치된 Chromium(`/opt/pw-browsers/chromium`)을 사용합니다. 다른 환경에서는
  `FD_CHROMIUM=<chrome 경로>`로 지정하거나 `npx playwright install chromium` 후
  `playwright.config.ts`의 `executablePath` 지정을 제거하세요.
- 실행 후 `test-results/`에 실측 지표(JSON)와 스크린샷이 남습니다
  (`p1-gauge-ab.json`, `p1-perf-metrics.json`, `p1-2d-lifecycle.json`, `p1-crowding.json`, `screens/`).
- **FPS 실측 테스트는 단독 실행(`workers: 1`, 커밋된 기본 설정) 전제**입니다. `--workers=N`으로
  병렬 실행하면 다른 워커의 WebGL 페이지와 자원을 나눠 써 수치가 무의미해지므로 자동으로 건너뜁니다.

## 조작

| 입력 | 동작 |
|---|---|
| 탭 (이동 <24pt & <200ms) | 우산 접기/펼치기 토글 — 접음=가속·우산 베기, 펼침=감속·검 베기 (실루엣 자세로 구분) |
| 스와이프 (이동 ≥24pt 또는 0.5pt/ms 초과) | 베기 — 판정 링 안(하이라이트+비프음)의 적만 벨 수 있음 |
| 하단 게이지 버튼 탭 | 게이지 100% 시 도약 (2.5초 무적 자동 비행) |

- 데스크톱에서는 마우스 드래그 = 스와이프, 클릭 = 탭 (Pointer Events로 동일 처리).
- 빈 화면 스와이프는 무벌점입니다. **링 안에 적이 있는데 빗나간 헛스윙만** 베기 미스로 콤보가 리셋됩니다.

## 화면 구성 (HD-2D 5레이어, 기획서 v2 4장)

| 레이어 | 내용 | 구현 |
|---|---|---|
| ① 원경 | 스카이 그라데이션 + 지구/달 구체 | 프래그먼트 셰이더 1패스 (`render/layers/sky.ts`) |
| ② 중경 | 패럴랙스 구름 3장 (속도 차등) | fbm 노이즈 셰이더 3패스 |
| ③ 3D | 로우폴리 유적 3종(아치·계단·잔해) | 원근 카메라 + 안개 (`render/layers/objects3d.ts`) — **연출 전용** |
| ④ 게임플레이 | 소녀·적·투사체·판정 링 | 직교 카메라, 판정 좌표계와 동일 매핑 |
| ⑤ 전경 | 속도선·파편 + **베기 궤적** | 화면 px 공간 (`render/slashfx.ts`) |

## 튜닝 패널

⚙ 버튼으로 열고, 슬라이더·체크박스로 새로고침 없이 조정합니다 (`?debug=0`으로 숨김).

- **입력**: 탭/스와이프 임계, 우산/검 궤적 폭·재판정 간격
- **속도 다이얼**: 가감속, 체류시간·공격주기 배수
- **2D 판정·동선**: 판정 링 반경(화면 폭 %), 체류형 선회 반경·배치각·각속도, 접근 속도,
  사선 진입 최대각, 스폰 간격, 소녀 세로 위치
- **HD-2D 연출**: 스크롤 속도 계수, 최고속 줌아웃, 셰이크 강도, 3D 오브젝트 밀도, 히트스톱
- **A/B · 렌더 정책**: **게이지 배율 적용 토글**(기본 OFF), **픽셀 스케일링 토글**과 정수 배율

통계 표시: FPS / 1% low / draw call / 레이어 수 / 풀스크린 패스(오버드로우 추정) / 렌더 해상도 /
입력 분류 카운트 / 베기 미스·빈 스와이프 / 게이지 100% 도달 시각·도약 횟수 / 활성 적·링 내 적 수 /
오디오 지연.

## URL 파라미터

- `?debug=0` — 튜닝 패널 숨김 (기본: 표시)
- `?seed=N` — 스폰 난수 시드 고정 (기본 20260821)

## 구조 (로직-렌더링 분리)

```
src/core/       # 순수 TS — three.js/DOM 미참조 (검증된 코어의 보호 계층)
  balance.ts      # 기획서 수치 단일 데이터 모듈 (튜닝 패널이 이 객체를 실시간 수정)
  sim.ts          # 시뮬레이션: 속도 다이얼·2D 적 동선·판정·게이지·도약·웨이브·HP
  classifier.ts   # 탭/스와이프 분류기 (M1 오분류 0% 검증분 그대로 이월)
  projection.ts   # 2D 평면 투영 (Plane2D) — M1의 원근 핀홀 투영을 대체
  runner.ts       # 고정 타임스텝(120Hz) + 렌더 보간
  rng.ts          # 시드 RNG
src/data/       # waves.json — 90초 웨이브 시퀀스 (M1 이월, 코드와 분리)
src/render/     # three.js HD-2D 렌더러·레이어·베기 이펙트·HUD·튜닝 패널·WebAudio·FPS 트래커
  layers/sky.ts, layers/objects3d.ts, layers/girl.ts, slashfx.ts, renderer.ts
tests/          # Playwright 자가 검증 (helpers.ts = 공통 대기·오토플레이)
```

시뮬레이션은 화면 좌표(CSS px) 기준 스와이프 궤적을 `core/projection.ts`의 자체 투영으로 판정하므로
렌더러를 통째로 교체해도 게임 로직·판정이 그대로 이식됩니다 (M1 → P1 전환이 그 증명입니다).
적·투사체·파티클·베기 궤적은 전부 오브젝트 풀링.
