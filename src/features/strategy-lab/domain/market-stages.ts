import type { GateRun } from '../infrastructure/gate-api.ts'
import type { Medicion } from '../infrastructure/quick-api.ts'

/**
 * Stretches of the practice window (everything before the exam cut), each one
 * a different slice of the market. «Testear» always takes the first one this
 * strategy has not been tried on, so every test adds evidence from somewhere new.
 */
export type MarketStage = { label: string; from: string; to: string }

export const MARKET_STAGES: readonly MarketStage[] = [
  { label: 'ene–mar 2025', from: '2025-01-01', to: '2025-04-01' },
  { label: 'abr–jun 2025', from: '2025-04-01', to: '2025-07-01' },
  { label: 'jul–sep 2025', from: '2025-07-01', to: '2025-10-01' },
  { label: 'oct–dic 2025', from: '2025-10-01', to: '2026-01-01' },
  { label: 'ene–abr 2026', from: '2026-01-01', to: '2026-04-19' },
]

/**
 * Stretches before the practice window that only the honest measurement can test: every quarter uses formulas refitted with
 * what came before it, so a 2023 or 2024 stretch is out of sample. The paper formulas were fitted up to 2025-09-30, so there
 * those stretches (and every 2025 one before October) would be tested inside their own fitting.
 */
export const HONEST_STAGES: readonly MarketStage[] = [
  { label: 'jul–dic 2023', from: '2023-07-01', to: '2024-01-01' },
  { label: 'ene–jun 2024', from: '2024-01-01', to: '2024-07-01' },
  { label: 'jul–dic 2024', from: '2024-07-01', to: '2025-01-01' },
]

/** First day after the fitting of the paper formulas (`config/qwen-lora-*.json` were fitted up to 2025-09-30). */
export const PAPER_FIT_END = '2025-10-01'

export const stagesFor = (medicion: Medicion): readonly MarketStage[] =>
  medicion === 'honesta' ? [...HONEST_STAGES, ...MARKET_STAGES] : MARKET_STAGES

/** A stage measured with the paper formulas that ends before they stopped fitting: the formulas had seen it. */
export const insideFit = (stage: MarketStage, medicion: Medicion): boolean =>
  medicion === 'vigente' && stage.to <= PAPER_FIT_END

/** The stage's name for the screen, with its mark when the measurement would be inside the fitting. */
export const stageLabel = (stage: MarketStage, medicion: Medicion): string =>
  insideFit(stage, medicion)
    ? `${stage.label} (dentro del ajuste)`
    : stage.label

/** How a run measured; runs made before the honest mode existed used the paper formulas. */
export const runMedicion = (run: GateRun): Medicion =>
  run.params?.medicion ?? 'vigente'

const day = (stamp: string | undefined) => (stamp ?? '').slice(0, 10)

/** Stages without a (non-failed) run of this strategy's current content, in order. */
export function untriedStages(
  runs: readonly GateRun[],
  stages: readonly MarketStage[] = MARKET_STAGES,
): MarketStage[] {
  const tried = runs.filter(
    (run) =>
      run.kind === 'practice' &&
      run.same_version !== false &&
      run.status !== 'failed' &&
      run.status !== 'cancelled',
  )
  return stages.filter(
    (stage) =>
      !tried.some(
        (run) =>
          day(run.params?.from) === stage.from &&
          day(run.params?.to) === stage.to,
      ),
  )
}

/** One tab per market stage: the newest finished practice run of the current content in it, or `null` (not tried). */
export type StageTab = { stage: MarketStage; run: GateRun | null }

export function stageTabs(
  runs: readonly GateRun[],
  stages: readonly MarketStage[] = MARKET_STAGES,
): StageTab[] {
  const done = runs
    .filter(
      (run) =>
        run.kind === 'practice' &&
        run.status === 'done' &&
        run.same_version !== false,
    )
    .sort((a, b) => b.id - a.id)
  return stages.map((stage) => ({
    stage,
    run:
      done.find(
        (run) =>
          day(run.params?.from) === stage.from &&
          day(run.params?.to) === stage.to,
      ) ?? null,
  }))
}

/** Next stage without a run of this strategy's current content, or null when all were tried. */
export function nextStage(runs: readonly GateRun[]): MarketStage | null {
  return untriedStages(runs)[0] ?? null
}
