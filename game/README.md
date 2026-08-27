# FallingDown — M1 그레이박스 프로토타입

> 지시문: `docs/instructions/M1_graybox.md` / 기획서: `fallingdown_game_design.md` v0.9.1
> 스택: TypeScript + Vite + three.js (패키지 매니저: npm, lockfile 커밋)

아트 없는 코어 루프 검증용 프로토타입입니다. 낙하 속도 다이얼(탭 토글) × Z축 스와이프 베기 × 도약을
프리미티브만으로 구현하고, 기획서 17장 검증 항목 1~6을 실측합니다. 측정 결과는
`docs/reports/M1_report.md` 참조.

## 실행

```bash
cd game
npm install
npm run dev        # 개발 서버 (기본 http://localhost:5173, --host 로 LAN 노출됨)
```

- 데스크톱: 마우스 드래그 = 스와이프, 클릭 = 탭 (터치와 동일 처리)
- **폰에서 접속**: `npm run dev` 실행 후 터미널에 표시되는 `Network:` 주소(예: `http://192.168.x.x:5173`)를
  같은 Wi-Fi에 있는 폰 브라우저로 열면 됩니다. 원격 환경이라면 `npm run build` 후 `dist/`를
  아무 정적 호스팅(GitHub Pages, Netlify 등)에 올려 URL로 접속합니다 (순수 정적 빌드, 서버 불필요).

## 빌드 / 테스트

```bash
npm run build      # 타입체크 + dist/ 정적 빌드 (gzip 총 ~137KB)
npm run preview    # 빌드 결과 로컬 서빙
npm test           # Playwright 자가 검증 (입력 분류·90초 시퀀스·규칙·성능·UI, 14 테스트)
```

테스트는 사전 설치된 Chromium(`/opt/pw-browsers/chromium`)을 사용합니다. 다른 환경에서는
`FD_CHROMIUM=<chrome 경로>` 환경 변수로 지정하거나 `npx playwright install chromium` 후
`playwright.config.ts`의 `executablePath` 지정을 제거하세요.
실행 후 `test-results/`에 실측 지표(JSON)와 스크린샷이 남습니다.

## 조작

| 입력 | 동작 |
|---|---|
| 탭 (이동 <24pt & <200ms) | 우산 접기/펼치기 토글 — 접음(빨강)=가속·우산 베기, 펼침(파랑)=감속·검 베기 |
| 스와이프 (이동 ≥24pt 또는 고속) | 베기 — 판정 링 안(하이라이트+비프음)의 적만 벨 수 있음 |
| 하단 게이지 버튼 탭 | 게이지 100% 시 도약 (2.5초 무적 자동 비행) |

## URL 파라미터

- `?debug=0` — 튜닝 패널 숨김 (기본: 표시, ⚙ 버튼으로 열기)
- `?seed=N` — 스폰 난수 시드 고정 (기본 20260821)

## 구조 (로직-렌더링 분리)

```
src/core/     # 순수 TS — three.js/DOM 미참조 (Unity 전환 트리거 대비 이식 가능 계층)
  balance.ts    # 기획서 7~11장 수치 단일 데이터 모듈 (튜닝 패널이 이 객체를 실시간 수정)
  sim.ts        # 시뮬레이션: 속도 다이얼·적 생애주기·판정·게이지·도약·웨이브·HP
  classifier.ts # 탭/스와이프 분류기 (단일 모듈 격리, 전 입력 기록)
  projection.ts # 화면 공간 판정용 순수 핀홀 투영 (렌더러 카메라와 동일 모델)
  runner.ts     # 고정 타임스텝(120Hz) + 렌더 보간
  rng.ts        # 시드 RNG
src/data/     # waves.json — 90초 웨이브 시퀀스 (코드와 분리된 데이터)
src/render/   # three.js 렌더러·HUD(HTML)·튜닝 패널·WebAudio 비프음·FPS 트래커
tests/        # Playwright 자가 검증
```

시뮬레이션은 화면 좌표(CSS px) 기준 스와이프 궤적을 `core/projection.ts`의 자체 투영으로 판정하므로
렌더러를 통째로 교체해도 게임 로직·판정이 그대로 이식됩니다. 적·투사체·파티클은 전부 오브젝트 풀링.
