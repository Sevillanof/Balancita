import { record } from '../shared/wire/decode.ts'
import { QWEN_STRATEGY_ID } from './useQwenDecisions.ts'

/**
 * Strategies the Terminal may show: only those that passed the whole cycle in
 * Estrategias (exam passed, activated to paper by the owner). None does yet,
 * so the Terminal shows only Qwen. Set the ids (comma separated) in
 * VITE_TERMINAL_APPROVED_STRATEGIES when one is activated; the e2e server
 * sets `*` (every verdict) to exercise the verdict rendering.
 */
export const APPROVED_TERMINAL_STRATEGIES: readonly string[] = (
  import.meta.env.VITE_TERMINAL_APPROVED_STRATEGIES ?? ''
)
  .split(',')
  .map((id: string) => id.trim())
  .filter((id: string) => id.length > 0)

/** A verdict is shown when it is Qwen's or its strategy is approved. */
export function isApprovedAnalysis(value: unknown): boolean {
  const analysis = record(value)
  const id =
    record(analysis.selector).strategy_id ?? analysis.selected_strategy_id
  if (APPROVED_TERMINAL_STRATEGIES.includes('*')) return true
  if (id === QWEN_STRATEGY_ID) return true
  return typeof id === 'string' && APPROVED_TERMINAL_STRATEGIES.includes(id)
}
