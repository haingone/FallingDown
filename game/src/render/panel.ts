/**
 * 튜닝 패널 (P1 디버그) — M1 항목 이월 + HD-2D 확장 (지시문 P1 §5).
 * 핵심 수치를 새로고침 없이 조정 + 세션 통계 표시. `?debug=0`으로 숨김.
 */
import { config, resetConfig, BalanceConfig, PixelScaleMode, JudgeAreaKind } from '../core/balance';
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
interface SelectField {
  kind: 'select';
  key: 'pixelScaleMode' | 'judgeArea';
  label: string;
  options: [string, string][];
  /** 선택 시 렌더 해상도 재설정이 필요한가 */
  relayout?: boolean;
}
type Field = SliderField | ToggleField | SelectField;

const FIELDS: Field[] = [
  // ── 입력 (M1 검증치) ──
  { kind: 'slider', key: 'tapMaxDistancePt', label: '탭/스와이프 거리 임계 (pt)', min: 8, max: 60, step: 1 },
  { kind: 'slider', key: 'tapMaxDurationMs', label: '탭 시간 임계 (ms)', min: 80, max: 400, step: 10 },
  { kind: 'slider', key: 'swipeSpeedThresholdPtMs', label: '스와이프 속도 임계 (pt/ms)', min: 0.1, max: 2, step: 0.05 },
  // ── 속도 다이얼 ──
  { kind: 'slider', key: 'accelPerSec', label: '접음 가속 (x/s)', min: 0.05, max: 1, step: 0.05 },
  { kind: 'slider', key: 'decelPerSec', label: '펼침 감속 (x/s)', min: 0.25, max: 3, step: 0.25 },
  // ── 2D 판정·동선 ──
  {
    kind: 'select', key: 'judgeArea', label: '판정 영역',
    options: [['band', 'B 화면 밴드 ✅확정'], ['circle', 'A 원형 링 (폐기 예정)']],
  },
  { kind: 'slider', key: 'bandHeightFrac', label: 'B: 밴드 높이 (화면 폭 비)', min: 0.15, max: 1.2, step: 0.01 },
  { kind: 'slider', key: 'ringRadiusFrac', label: 'A: 링 반경 (폐기 예정)', min: 0.15, max: 0.7, step: 0.01 },
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
  { kind: 'slider', key: 'slashLifeSec', label: '베기 궤적 잔광 (s)', min: 0.1, max: 3, step: 0.05 },
  // ── r3 손맛 주스 (격파 피드백) ──
  { kind: 'slider', key: 'burstDebrisCount', label: '① 파편 수', min: 0, max: 40, step: 1 },
  { kind: 'slider', key: 'burstSparkCount', label: '① 코어 스파크 수', min: 0, max: 20, step: 1 },
  { kind: 'slider', key: 'burstSpeed', label: '① 파편 분사 속도', min: 0.2, max: 3, step: 0.05 },
  { kind: 'slider', key: 'burstDirectionality', label: '① 파편 지향성 (0방사~1스와이프)', min: 0, max: 1, step: 0.05 },
  { kind: 'slider', key: 'burstLifeSec', label: '① 파편 지속 (s)', min: 0.1, max: 1.2, step: 0.02 },
  { kind: 'slider', key: 'particleBudget', label: '① 파편 총량 상한', min: 40, max: 260, step: 10 },
  { kind: 'slider', key: 'impactFlashStrength', label: '② 임팩트 플래시 (0=끔)', min: 0, max: 2, step: 0.05 },
  { kind: 'slider', key: 'deathPopMs', label: '② 스케일 팝 (ms, 0=끔)', min: 0, max: 400, step: 10 },
  { kind: 'slider', key: 'cameraPunch', label: '③ 카메라 펀치 (0=끔)', min: 0, max: 0.06, step: 0.002 },
  { kind: 'slider', key: 'cameraPunchMs', label: '③ 펀치 복귀 (ms)', min: 20, max: 250, step: 5 },
  { kind: 'slider', key: 'killSoundGain', label: '④ 격파음 게인 (0=끔)', min: 0, max: 2, step: 0.05 },
  { kind: 'slider', key: 'killPitchStackMax', label: '④ 피치 스택 상한 (반음)', min: 0, max: 12, step: 1 },
  { kind: 'slider', key: 'soundVoiceLimit', label: '④ 동시발음 제한', min: 1, max: 8, step: 1 },
  { kind: 'slider', key: 'bandFlashStrength', label: '⑤ 밴드 히트 플래시 (0=끔)', min: 0, max: 2, step: 0.05 },
  { kind: 'slider', key: 'bandFlashMs', label: '⑤ 밴드 플래시 지속 (ms)', min: 20, max: 400, step: 10 },
  { kind: 'slider', key: 'uiPulseStrength', label: '⑥ 배율 UI 펄스 (0=끔)', min: 0, max: 1, step: 0.05 },
  { kind: 'slider', key: 'hitstopMs', label: '⑦ 히트스톱 (ms)', min: 0, max: 100, step: 5 },
  { kind: 'toggle', key: 'hitstopMultiEnabled', label: '⑦ 다중 격파 히트스톱 연장' },
  { kind: 'slider', key: 'hitstopMultiMaxMs', label: '⑦ 다중 격파 히트스톱 상한 (ms)', min: 40, max: 140, step: 5 },
  // ── 게이지 A/B (기획서 v2 17장 4) ──
  { kind: 'toggle', key: 'gaugeMultiplierEnabled', label: '★ 게이지에 배율 적용 (A/B)' },
  // ── HD-2D 연출 ──
  { kind: 'slider', key: 'scrollSpeedCoef', label: '스크롤 속도 계수', min: 0.2, max: 2.5, step: 0.1 },
  { kind: 'slider', key: 'zoomMax', label: '최고속 줌', min: 1.0, max: 1.3, step: 0.01 },
  { kind: 'slider', key: 'shakeStrength', label: '셰이크 강도 (px)', min: 0, max: 16, step: 0.5 },
  { kind: 'slider', key: 'objectDensity', label: '3D 오브젝트 밀도', min: 0, max: 1, step: 0.1 },
  // ── 픽셀 스케일링 정책 (기획서 v2 17장 7) ──
  {
    kind: 'select', key: 'pixelScaleMode', label: '픽셀 스케일링', relayout: true,
    options: [['native', '네이티브'], ['pixel', '저해상도→정수배']],
  },
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
    private stats: () => { drawCalls: number; overdraw: number; particles: number; sprites: string },
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

    if (f.kind === 'select') {
      const name = document.createElement('span');
      name.textContent = f.label + ' ';
      const select = document.createElement('select');
      for (const [value, text] of f.options) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        select.appendChild(opt);
      }
      select.value = config[f.key];
      select.addEventListener('change', () => {
        if (f.key === 'pixelScaleMode') config.pixelScaleMode = select.value as PixelScaleMode;
        else config.judgeArea = select.value as JudgeAreaKind;
        if (f.relayout) this.onScaleModeChange();
      });
      select.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      row.append(name, select);
      this.syncFns.push(() => { select.value = config[f.key]; });
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
      `▶ FPS ${this.perf.fps().toFixed(0)}  1%low ${this.perf.onePercentLow().toFixed(0)}  draw ${rs.drawCalls}`,
      `sim ${sim.time.toFixed(1)}s  wave ${sim.waveIndex + 1}/${sim.waveCount} [${sim.state}]`,
      `파편 ${rs.particles}/${config.particleBudget}  overdraw~${rs.overdraw}`,
      `스프라이트 ${rs.sprites}  픽셀스케일 ${config.pixelScaleMode === 'pixel' ? '1/' + config.pixelScaleFactor : '네이티브'}`,
      `입력: 탭 ${s.taps} · 스와이프 ${s.swipes} · 무효 ${s.none}`,
      `오분류 의심 ${s.suspects}건 (${suspectRate}%)`,
      `속도 ${sim.speed.toFixed(2)}x  평균배율 ${sim.avgMultiplier.toFixed(2)}x  콤보 ${sim.combo}`,
      `게이지 ${(sim.gauge * 100).toFixed(0)}%  100%도달 ${sim.gaugeFullAt !== null ? sim.gaugeFullAt.toFixed(1) + 's' : '—'}  도약 ${sim.diveCount}회`,
      `게이지 배율 ${config.gaugeMultiplierEnabled ? 'ON (B안)' : 'OFF (A안·권장)'}`,
      `격파 ${sim.kills}  통과 ${sim.passedCount}  피격 ${sim.hitsTaken}  점수 ${sim.score}`,
      `판정 영역 ${config.judgeArea === 'band' ? 'B 밴드 (높이 ' + config.bandHeightFrac + ')' : 'A 원형 (반경 ' + config.ringRadiusFrac + ')'}`,
      `활성 적 ${sim.activeEnemyCount()} (체류 ${sim.activeStayCount()}/${config.stayCap}, 판정내 ${sim.hittableCount()})`,
      `통과 놓침 ${sim.passedCount}  영역 빗나감 ${sim.missedAreaCount}`,
      `오디오 지연 base ${lat ? lat.base.toFixed(0) : '—'}ms out ${lat ? lat.output.toFixed(0) : '—'}ms`,
    ];
    this.statsEl.textContent = lines.join('\n');
  }
}
