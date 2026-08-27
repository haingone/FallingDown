/**
 * 튜닝 패널 (프로토타입 전용 디버그) — 자작 HTML 오버레이.
 * M1 항목 + P1 확장(링 반경·선회 반경·배치각·스크롤·줌·셰이크·게이지 배율 A/B·3D 밀도·픽셀 스케일링).
 * `?debug=0`으로 숨김.
 */
import { config, resetConfig, DEFAULT_BALANCE, BalanceConfig } from '../core/balance';
import type { Sim } from '../core/sim';
import type { GestureClassifier } from '../core/classifier';
import type { PerfTracker } from './perf';
import type { Beeper } from './audio';
import type { Renderer } from './renderer';

interface NumField {
  kind: 'num';
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
}

interface BoolField {
  kind: 'bool';
  label: string;
  get: () => boolean;
  set: (v: boolean) => void;
}

type Field = NumField | BoolField;

function num(key: keyof BalanceConfig, label: string, min: number, max: number, step: number): NumField {
  return {
    kind: 'num', label, min, max, step,
    get: () => config[key] as number,
    set: (v) => { (config[key] as number) = v; },
  };
}

export class Panel {
  private root: HTMLElement;
  private statsEl: HTMLElement;
  private visible: boolean;
  private syncFns: (() => void)[] = [];
  swipeHits: boolean[] = [];

  constructor(
    stage: HTMLElement,
    private sim: () => Sim,
    private classifier: GestureClassifier,
    private perf: PerfTracker,
    private beeper: Beeper,
    private renderer: Renderer,
    onRestart: () => void,
  ) {
    const params = new URLSearchParams(location.search);
    this.visible = params.get('debug') !== '0';

    this.root = document.createElement('div');
    this.root.id = 'panel';

    const toggle = document.createElement('button');
    toggle.id = 'panel-toggle';
    toggle.textContent = '⚙';
    toggle.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      this.root.classList.toggle('open');
    });

    const body = document.createElement('div');
    body.id = 'panel-body';

    this.statsEl = document.createElement('pre');
    this.statsEl.id = 'panel-stats';
    body.appendChild(this.statsEl);

    for (const group of this.fieldGroups()) {
      const head = document.createElement('div');
      head.className = 'panel-group';
      head.textContent = group.title;
      body.appendChild(head);
      for (const f of group.fields) body.appendChild(this.buildRow(f));
    }

    const btnRow = document.createElement('div');
    btnRow.className = 'panel-row';
    const resetBtn = document.createElement('button');
    resetBtn.textContent = '기본값 복원';
    resetBtn.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      resetConfig();
      for (const fn of this.syncFns) fn();
    });
    const restartBtn = document.createElement('button');
    restartBtn.textContent = '재시작';
    restartBtn.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      onRestart();
    });
    btnRow.append(resetBtn, restartBtn);
    body.appendChild(btnRow);

    this.root.append(toggle, body);
    stage.appendChild(this.root);
    if (!this.visible) this.root.style.display = 'none';
  }

  /** 화면 폭 대비 링 반경 % ↔ ringRadiusWu 변환 (줌 영향 배제를 위해 기준 배율 1.0로 계산) */
  private basePxPerWu(): number {
    const s = this.sim();
    return s.plane.viewport.height / config.worldHeightWu;
  }
  private ringPct(): number {
    const s = this.sim();
    return (config.ringRadiusWu * this.basePxPerWu()) / s.plane.viewport.width * 100;
  }
  private setRingPct(pct: number): void {
    const s = this.sim();
    config.ringRadiusWu = (pct / 100) * s.plane.viewport.width / this.basePxPerWu();
  }

  private fieldGroups(): { title: string; fields: Field[] }[] {
    return [
      {
        title: '── 입력 (기획서 5장) ──',
        fields: [
          num('tapMaxDistancePt', '탭/스와이프 거리 임계 (pt)', 8, 60, 1),
          num('tapMaxDurationMs', '탭 시간 임계 (ms)', 80, 400, 10),
          num('swipeSpeedThresholdPtMs', '스와이프 속도 임계 (pt/ms)', 0.1, 2, 0.05),
          num('umbrellaTrajWidthPt', '우산 궤적 폭 (pt)', 6, 80, 2),
          num('swordTrajWidthPt', '검 궤적 폭 (pt)', 4, 60, 2),
          num('umbrellaRejudgeMs', '우산 재판정 간격 (ms)', 40, 600, 20),
          num('swordRejudgeMs', '검 재판정 간격 (ms)', 20, 400, 10),
        ],
      },
      {
        title: '── 속도 다이얼 (기획서 7장) ──',
        fields: [
          num('accelPerSec', '접음 가속 (x/s)', 0.05, 1, 0.05),
          num('decelPerSec', '펼침 감속 (x/s)', 0.25, 3, 0.25),
          num('dwellScale', '통과형 체류시간 배수', 0.5, 2.5, 0.1),
          num('attackPeriodScale', '체류형 공격주기 배수', 0.5, 2.5, 0.1),
        ],
      },
      {
        title: '── 2D 판정·동선 (기획서 v2 4·10장) ──',
        fields: [
          {
            kind: 'num', label: '판정 링 반경 (화면 폭 %)', min: 15, max: 70, step: 1,
            get: () => Math.round(this.ringPct()),
            set: (v) => this.setRingPct(v),
          },
          num('stayOrbitRadiusScale', '체류형 선회 반경 배수', 0.5, 1.8, 0.05),
          num('stayArcDeg', '체류형 배치각 (°)', 60, 360, 10),
          num('stayOrbitSpeed', '선회 각속도 (rad/s)', 0, 2, 0.05),
          num('approachBaseWu', '접근 속도 기본 (wu/s)', 0.4, 3.5, 0.05),
          num('entryAngleMaxDeg', '사선 진입 최대각 (°)', 0, 60, 2),
          num('spawnDensityScale', '스폰 간격 배수', 0.3, 2, 0.1),
          num('girlScreenYPct', '소녀 세로 위치 (비율)', 0.35, 0.55, 0.01),
        ],
      },
      {
        title: '── HD-2D 연출 (기획서 v2 4장) ──',
        fields: [
          num('scrollSpeedCoef', '스크롤 속도 계수', 0.2, 3, 0.1),
          num('zoomMax', '최고속 줌아웃 배수', 1, 1.3, 0.01),
          num('shakeIntensity', '셰이크 강도', 0, 3, 0.1),
          num('object3dDensity', '3D 오브젝트 밀도 (개)', 0, 24, 1),
          num('hitstopMs', '히트스톱 (ms)', 0, 100, 5),
        ],
      },
      {
        title: '── A/B · 렌더 정책 ──',
        fields: [
          {
            kind: 'bool', label: '게이지 배율 적용 (A/B)',
            get: () => config.gaugeMultiplierEnabled,
            set: (v) => { config.gaugeMultiplierEnabled = v; },
          },
          {
            kind: 'bool', label: '픽셀 스케일링 (저해상도 RT)',
            get: () => config.pixelScaling === 'pixel',
            set: (v) => { config.pixelScaling = v ? 'pixel' : 'native'; },
          },
          num('pixelScaleFactor', '픽셀 정수 배율', 2, 4, 1),
        ],
      },
    ];
  }

  private buildRow(f: Field): HTMLElement {
    const row = document.createElement('label');
    row.className = 'panel-row';
    const name = document.createElement('span');
    name.textContent = f.label + ' ';
    if (f.kind === 'bool') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'panel-check';
      const sync = () => { input.checked = f.get(); };
      input.addEventListener('change', () => f.set(input.checked));
      input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      sync();
      this.syncFns.push(sync);
      row.append(input, name);
      return row;
    }
    const valEl = document.createElement('b');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(f.min);
    input.max = String(f.max);
    input.step = String(f.step);
    const fmt = (v: number) => (f.step < 1 ? v.toFixed(2) : String(Math.round(v)));
    const sync = () => {
      const v = f.get();
      input.value = String(v);
      valEl.textContent = fmt(v);
    };
    input.addEventListener('input', () => {
      f.set(Number(input.value));
      valEl.textContent = fmt(Number(input.value));
    });
    input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    sync();
    this.syncFns.push(sync);
    row.append(name, valEl, input);
    return row;
  }

  updateStats(): void {
    if (!this.visible) return;
    const sim = this.sim();
    const s = this.classifier.suspectStats(this.swipeHits);
    const totalInputs = s.taps + s.swipes + s.none;
    const suspectRate = totalInputs > 0 ? ((s.suspects / totalInputs) * 100).toFixed(1) : '0.0';
    const lat = this.beeper.latencyMs();
    const res = this.renderer.renderResolution();
    const lines = [
      `sim ${sim.time.toFixed(1)}s  wave ${sim.waveIndex + 1}/${sim.waveCount} [${sim.state}]`,
      `FPS ${this.perf.fps().toFixed(0)} / 1%low ${this.perf.onePercentLow().toFixed(0)}  draw ${this.renderer.drawCalls()}`,
      `레이어 ${this.renderer.layerCount()}  풀스크린 패스 ${this.renderer.fullscreenPasses()}  ${res.w}×${res.h} (${config.pixelScaling})`,
      `입력: 탭 ${s.taps} · 스와이프 ${s.swipes} · 무효 ${s.none}`,
      `베기 미스 ${sim.swipeMissCount} · 빈 스와이프(무벌점) ${sim.emptySwipeCount}`,
      `오분류 의심 ${s.suspects}건 (${suspectRate}%)`,
      `속도 ${sim.speed.toFixed(2)}x  평균배율 ${sim.avgMultiplier.toFixed(2)}x  콤보 ${sim.combo}`,
      `게이지 ${(sim.gauge * 100).toFixed(0)}%  100%도달 ${sim.gaugeFullAt !== null ? sim.gaugeFullAt.toFixed(1) + 's' : '—'}  도약 ${sim.diveCount}회`,
      `게이지 배율 ${config.gaugeMultiplierEnabled ? 'ON (A)' : 'OFF (B, 권장안)'}`,
      `격파 ${sim.kills}  통과 ${sim.passedCount}  이탈 ${sim.strayCount}  피격 ${sim.hitsTaken}  점수 ${sim.score}`,
      `활성 적 ${sim.activeEnemyCount()} (최대 ${sim.peakActiveEnemies} · 체류 ${sim.activeStayCount()}/${config.stayCap} · 링 내 ${sim.hittableInRingCount()})`,
      `오디오 지연 base ${lat ? lat.base.toFixed(0) : '—'}ms out ${lat ? lat.output.toFixed(0) : '—'}ms`,
      `링 반경 ${config.ringRadiusWu.toFixed(2)}wu = 화면 폭 ${this.ringPct().toFixed(0)}% (지름 ${(this.ringPct() * 2).toFixed(0)}%)`,
      `기본 링 반경 ${DEFAULT_BALANCE.ringRadiusWu}wu`,
    ];
    this.statsEl.textContent = lines.join('\n');
  }
}
