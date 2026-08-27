/**
 * 튜닝 패널 (M1 전용 디버그) — 자작 HTML 오버레이.
 * 핵심 수치를 새로고침 없이 실시간 조정 + 세션 통계 표시. `?debug=0`으로 숨김.
 */
import { config, resetConfig, DEFAULT_BALANCE, BalanceConfig } from '../core/balance';
import type { Sim } from '../core/sim';
import type { GestureClassifier } from '../core/classifier';
import type { PerfTracker } from './perf';
import type { Beeper } from './audio';

interface Field {
  key: keyof BalanceConfig;
  label: string;
  min: number;
  max: number;
  step: number;
}

const FIELDS: Field[] = [
  { key: 'tapMaxDistancePt', label: '탭/스와이프 거리 임계 (pt)', min: 8, max: 60, step: 1 },
  { key: 'tapMaxDurationMs', label: '탭 시간 임계 (ms)', min: 80, max: 400, step: 10 },
  { key: 'swipeSpeedThresholdPtMs', label: '스와이프 속도 임계 (pt/ms)', min: 0.1, max: 2, step: 0.05 },
  { key: 'accelPerSec', label: '접음 가속 (x/s)', min: 0.05, max: 1, step: 0.05 },
  { key: 'decelPerSec', label: '펼침 감속 (x/s)', min: 0.25, max: 3, step: 0.25 },
  { key: 'ringRadiusWu', label: '판정 링 반경 (wu)', min: 0.8, max: 3, step: 0.1 },
  { key: 'dwellScale', label: '통과형 체류시간 배수', min: 0.5, max: 2.5, step: 0.1 },
  { key: 'attackPeriodScale', label: '체류형 공격주기 배수', min: 0.5, max: 2.5, step: 0.1 },
  { key: 'spawnDensityScale', label: '스폰 간격 배수', min: 0.3, max: 2, step: 0.1 },
  { key: 'fovMin', label: 'FOV 최소 (°)', min: 45, max: 75, step: 1 },
  { key: 'fovMax', label: 'FOV 최대 (°)', min: 55, max: 95, step: 1 },
  { key: 'hitstopMs', label: '히트스톱 (ms)', min: 0, max: 100, step: 5 },
  { key: 'umbrellaTrajWidthPt', label: '우산 궤적 폭 (pt)', min: 6, max: 80, step: 2 },
  { key: 'swordTrajWidthPt', label: '검 궤적 폭 (pt)', min: 4, max: 60, step: 2 },
  { key: 'umbrellaRejudgeMs', label: '우산 재판정 간격 (ms)', min: 40, max: 600, step: 20 },
  { key: 'swordRejudgeMs', label: '검 재판정 간격 (ms)', min: 20, max: 400, step: 10 },
  { key: 'approachBaseWu', label: '접근 속도 기본 (wu/s)', min: 3, max: 20, step: 0.5 },
];

export class Panel {
  private root: HTMLElement;
  private statsEl: HTMLElement;
  private visible: boolean;
  swipeHits: boolean[] = [];

  constructor(
    stage: HTMLElement,
    private sim: () => Sim,
    private classifier: GestureClassifier,
    private perf: PerfTracker,
    private beeper: Beeper,
    private drawCalls: () => number,
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

    for (const f of FIELDS) {
      const row = document.createElement('label');
      row.className = 'panel-row';
      const name = document.createElement('span');
      const valEl = document.createElement('b');
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(f.min);
      input.max = String(f.max);
      input.step = String(f.step);
      input.value = String(config[f.key]);
      const sync = () => {
        valEl.textContent = String(config[f.key]);
        input.value = String(config[f.key]);
      };
      name.textContent = f.label + ' ';
      input.addEventListener('input', () => {
        (config[f.key] as number) = Number(input.value);
        valEl.textContent = input.value;
      });
      input.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      sync();
      row.append(name, valEl, input);
      body.appendChild(row);
      (row as HTMLElement & { syncFn?: () => void }).syncFn = sync;
    }

    const btnRow = document.createElement('div');
    btnRow.className = 'panel-row';
    const resetBtn = document.createElement('button');
    resetBtn.textContent = '기본값 복원';
    resetBtn.addEventListener('pointerdown', (ev) => {
      ev.stopPropagation();
      resetConfig();
      body.querySelectorAll('.panel-row').forEach((r) => (r as HTMLElement & { syncFn?: () => void }).syncFn?.());
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

  updateStats(): void {
    if (!this.visible) return;
    const sim = this.sim();
    const s = this.classifier.suspectStats(this.swipeHits);
    const totalInputs = s.taps + s.swipes + s.none;
    const suspectRate = totalInputs > 0 ? ((s.suspects / totalInputs) * 100).toFixed(1) : '0.0';
    const lat = this.beeper.latencyMs();
    const lines = [
      `sim ${sim.time.toFixed(1)}s  wave ${sim.waveIndex + 1}/${sim.waveCount} [${sim.state}]`,
      `FPS ${this.perf.fps().toFixed(0)} / 1%low ${this.perf.onePercentLow().toFixed(0)}  draw ${this.drawCalls()}`,
      `입력: 탭 ${s.taps} · 스와이프 ${s.swipes} · 무효 ${s.none}`,
      `오분류 의심 ${s.suspects}건 (${suspectRate}%)`,
      `속도 ${sim.speed.toFixed(2)}x  평균배율 ${sim.avgMultiplier.toFixed(2)}x  콤보 ${sim.combo}`,
      `게이지 ${(sim.gauge * 100).toFixed(0)}%  100%도달 ${sim.gaugeFullAt !== null ? sim.gaugeFullAt.toFixed(1) + 's' : '—'}`,
      `격파 ${sim.kills}  통과 ${sim.passedCount}  피격 ${sim.hitsTaken}  점수 ${sim.score}`,
      `활성 적 ${sim.activeEnemyCount()} (체류 ${sim.activeStayCount()}/${config.stayCap})`,
      `오디오 지연 base ${lat ? lat.base.toFixed(0) : '—'}ms out ${lat ? lat.output.toFixed(0) : '—'}ms`,
      `링 반경 기본 ${DEFAULT_BALANCE.ringRadiusWu}wu → 현재 ${config.ringRadiusWu}wu`,
    ];
    this.statsEl.textContent = lines.join('\n');
  }
}
