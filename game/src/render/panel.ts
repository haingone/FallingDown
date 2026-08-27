/**
 * 튜닝 패널 (P1 디버그) — M1 항목 이월 + HD-2D 확장 (지시문 P1 §5).
 * 핵심 수치를 새로고침 없이 조정 + 세션 통계 표시. `?debug=0`으로 숨김.
 */
import { config, resetConfig, BalanceConfig, PixelScaleMode } from '../core/balance';
import type { Sim } from '../core/sim';
import type { GestureClassifier } from '../core/classifier';
import type { PerfTracker } from './perf';
import type { Beeper } from './audio';

interface SliderField {
  kind: 'slider';
  key: keyof BalanceConfig;
  label: string;
  min: number;
  max: number;
  step: number;
}
interface ToggleField {
  kind: 'toggle';
  key: keyof BalanceConfig;
  label: string;
}
interface ModeField {
  kind: 'mode';
  label: string;
}
type Field = SliderField | ToggleField | ModeField;

const FIELDS: Field[] = [
  // ── 입력 (M1 검증치) ──
  { kind: 'slider', key: 'tapMaxDistancePt', label: '탭/스와이프 거리 임계 (pt)', min: 8, max: 60, step: 1 },
  { kind: 'slider', key: 'tapMaxDurationMs', label: '탭 시간 임계 (ms)', min: 80, max: 400, step: 10 },
  { kind: 'slider', key: 'swipeSpeedThresholdPtMs', label: '스와이프 속도 임계 (pt/ms)', min: 0.1, max: 2, step: 0.05 },
  // ── 속도 다이얼 ──
  { kind: 'slider', key: 'accelPerSec', label: '접음 가속 (x/s)', min: 0.05, max: 1, step: 0.05 },
  { kind: 'slider', key: 'decelPerSec', label: '펼침 감속 (x/s)', min: 0.25, max: 3, step: 0.25 },
  // ── 2D 판정·동선 ──
  { kind: 'slider', key: 'ringRadiusFrac', label: '판정 링 반경 (화면 폭 비)', min: 0.15, max: 0.7, step: 0.01 },
  { kind: 'slider', key: 'girlScreenFrac', label: '소녀 세로 위치 (0=상 1=하)', min: 0.25, max: 0.7, step: 0.01 },
  { kind: 'slider', key: 'dwellScale', label: '통과형 체류시간 배수', min: 0.5, max: 2.5, step: 0.1 },
  { kind: 'slider', key: 'attackPeriodScale', label: '체류형 공격주기 배수', min: 0.5, max: 2.5, step: 0.1 },
  { kind: 'slider', key: 'orbitRadiusFactor', label: '체류형 선회 반경 (×링)', min: 0.4, max: 1.4, step: 0.02 },
  { kind: 'slider', key: 'orbitSpreadDeg', label: '체류형 배치각 분산 (°)', min: 60, max: 360, step: 10 },
  { kind: 'slider', key: 'orbitSpeedDegSec', label: '선회 각속도 (°/s)', min: 0, max: 90, step: 2 },
  { kind: 'slider', key: 'approachSpeed', label: '접근 속도 (units/s)', min: 0.08, max: 0.6, step: 0.01 },
  // ── 스탠스 ──
  { kind: 'slider', key: 'umbrellaTrajWidthPt', label: '우산 궤적 폭 (pt)', min: 6, max: 80, step: 2 },
  { kind: 'slider', key: 'swordTrajWidthPt', label: '검 궤적 폭 (pt)', min: 4, max: 60, step: 2 },
  { kind: 'slider', key: 'umbrellaRejudgeMs', label: '우산 재판정 간격 (ms)', min: 40, max: 600, step: 20 },
  { kind: 'slider', key: 'swordRejudgeMs', label: '검 재판정 간격 (ms)', min: 20, max: 400, step: 10 },
  { kind: 'slider', key: 'hitstopMs', label: '히트스톱 (ms)', min: 0, max: 100, step: 5 },
  { kind: 'slider', key: 'slashLifeSec', label: '베기 궤적 잔광 (s)', min: 0.1, max: 3, step: 0.05 },
  // ── 게이지 A/B (기획서 v2 17장 4) ──
  { kind: 'toggle', key: 'gaugeMultiplierEnabled', label: '★ 게이지에 배율 적용 (A/B)' },
  // ── HD-2D 연출 ──
  { kind: 'slider', key: 'scrollSpeedCoef', label: '스크롤 속도 계수', min: 0.2, max: 2.5, step: 0.1 },
  { kind: 'slider', key: 'zoomMax', label: '최고속 줌', min: 1.0, max: 1.3, step: 0.01 },
  { kind: 'slider', key: 'shakeStrength', label: '셰이크 강도 (px)', min: 0, max: 16, step: 0.5 },
  { kind: 'slider', key: 'objectDensity', label: '3D 오브젝트 밀도', min: 0, max: 1, step: 0.1 },
  // ── 픽셀 스케일링 정책 (기획서 v2 17장 7) ──
  { kind: 'mode', label: '픽셀 스케일링' },
  { kind: 'slider', key: 'pixelScaleFactor', label: '픽셀 정수 배율', min: 2, max: 4, step: 1 },
];

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
    private stats: () => { drawCalls: number; overdraw: number },
    private onRestart: () => void,
    private onScaleModeChange: () => void,
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

    for (const f of FIELDS) body.appendChild(this.buildRow(f));

    const btnRow = document.createElement('div');
    btnRow.className = 'panel-row';
    const resetBtn = document.createElement('button');
    resetBtn.textContent = '기본값 복원';
    resetBtn.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      resetConfig();
      this.syncFns.forEach(fn => fn());
      this.onScaleModeChange();
    });
    const restartBtn = document.createElement('button');
    restartBtn.textContent = '재시작';
    restartBtn.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      this.onRestart();
    });
    btnRow.append(resetBtn, restartBtn);
    body.appendChild(btnRow);

    this.root.append(toggle, body);
    stage.appendChild(this.root);
    if (!this.visible) this.root.style.display = 'none';
  }

  private buildRow(f: Field): HTMLElement {
    const row = document.createElement('label');
    row.className = 'panel-row';

    if (f.kind === 'toggle') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'panel-check';
      input.checked = config[f.key] as boolean;
      input.addEventListener('change', () => {
        (config[f.key] as boolean) = input.checked;
      });
      input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      const name = document.createElement('span');
      name.textContent = ' ' + f.label;
      row.append(input, name);
      this.syncFns.push(() => { input.checked = config[f.key] as boolean; });
      return row;
    }

    if (f.kind === 'mode') {
      const name = document.createElement('span');
      name.textContent = f.label + ' ';
      const select = document.createElement('select');
      for (const [value, text] of [['native', '네이티브'], ['pixel', '저해상도→정수배']] as const) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        select.appendChild(opt);
      }
      select.value = config.pixelScaleMode;
      select.addEventListener('change', () => {
        config.pixelScaleMode = select.value as PixelScaleMode;
        this.onScaleModeChange();
      });
      select.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      row.append(name, select);
      this.syncFns.push(() => { select.value = config.pixelScaleMode; });
      return row;
    }

    const name = document.createElement('span');
    name.textContent = f.label + ' ';
    const valEl = document.createElement('b');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(f.min);
    input.max = String(f.max);
    input.step = String(f.step);
    const sync = () => {
      const v = config[f.key] as number;
      valEl.textContent = String(v);
      input.value = String(v);
    };
    input.addEventListener('input', () => {
      (config[f.key] as number) = Number(input.value);
      valEl.textContent = input.value;
      if (f.key === 'pixelScaleFactor') this.onScaleModeChange();
    });
    input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    sync();
    row.append(name, valEl, input);
    this.syncFns.push(sync);
    return row;
  }

  updateStats(): void {
    if (!this.visible) return;
    const sim = this.sim();
    const s = this.classifier.suspectStats(this.swipeHits);
    const totalInputs = s.taps + s.swipes + s.none;
    const suspectRate = totalInputs > 0 ? ((s.suspects / totalInputs) * 100).toFixed(1) : '0.0';
    const lat = this.beeper.latencyMs();
    const rs = this.stats();
    const lines = [
      `sim ${sim.time.toFixed(1)}s  wave ${sim.waveIndex + 1}/${sim.waveCount} [${sim.state}]`,
      `FPS ${this.perf.fps().toFixed(0)} / 1%low ${this.perf.onePercentLow().toFixed(0)}  draw ${rs.drawCalls}  overdraw~${rs.overdraw}`,
      `입력: 탭 ${s.taps} · 스와이프 ${s.swipes} · 무효 ${s.none}`,
      `오분류 의심 ${s.suspects}건 (${suspectRate}%)`,
      `속도 ${sim.speed.toFixed(2)}x  평균배율 ${sim.avgMultiplier.toFixed(2)}x  콤보 ${sim.combo}`,
      `게이지 ${(sim.gauge * 100).toFixed(0)}%  100%도달 ${sim.gaugeFullAt !== null ? sim.gaugeFullAt.toFixed(1) + 's' : '—'}  도약 ${sim.diveCount}회`,
      `게이지 배율 ${config.gaugeMultiplierEnabled ? 'ON (B안)' : 'OFF (A안·권장)'}`,
      `격파 ${sim.kills}  통과 ${sim.passedCount}  피격 ${sim.hitsTaken}  점수 ${sim.score}`,
      `활성 적 ${sim.activeEnemyCount()} (체류 ${sim.activeStayCount()}/${config.stayCap}, 링내 ${sim.hittableCount()})`,
      `오디오 지연 base ${lat ? lat.base.toFixed(0) : '—'}ms out ${lat ? lat.output.toFixed(0) : '—'}ms`,
    ];
    this.statsEl.textContent = lines.join('\n');
  }
}
