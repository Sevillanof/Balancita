import type { GateRun } from '../infrastructure/gate-api.ts'

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

const day = (stamp: string | undefined) => (stamp ?? '').slice(0, 10)

/** Stages without a (non-failed) run of this strategy's current content, in order. */
export function untriedStages(runs: readonly GateRun[]): MarketStage[] {
  const tried = runs.filter(
    (run) =>
      run.kind === 'practice' &&
      run.same_version !== false &&
      run.status !== 'failed' &&
      run.status !== 'cancelled',
  )
  return MARKET_STAGES.filter(
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

export function stageTabs(runs: readonly GateRun[]): StageTab[] {
  const done = runs
    .filter(
      (run) =>
        run.kind === 'practice' &&
        run.status === 'done' &&
        run.same_version !== false,
    )
    .sort((a, b) => b.id - a.id)
  return MARKET_STAGES.map((stage) => ({
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
