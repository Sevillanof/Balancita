import { record } from '../shared/wire/decode.ts'

/**
 * Strategies the Terminal may show: only those that passed the whole cycle in
 * Estrategias (exam passed, activated to paper by the owner). None does yet,
 * so the Terminal shows only Qwen. Add an id here when one is activated.
 */
export const APPROVED_TERMINAL_STRATEGIES: readonly string[] = []

/** An engine verdict is shown only when its strategy is approved. */
export function isApprovedAnalysis(value: unknown): boolean {
  const analysis = record(value)
  const id =
    record(analysis.selector).strategy_id ?? analysis.selected_strategy_id
  return typeof id === 'string' && APPROVED_TERMINAL_STRATEGIES.includes(id)
}
