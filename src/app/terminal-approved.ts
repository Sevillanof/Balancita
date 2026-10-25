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

/** An order, fill or position shows on the chart only if its strategy is Qwen's or approved. */
export function isApprovedStrategyId(id: unknown): boolean {
  if (typeof id !== 'string') return true
  if (APPROVED_TERMINAL_STRATEGIES.includes('*')) return true
  if (id === QWEN_STRATEGY_ID) return true
  return typeof id === 'string' && APPROVED_TERMINAL_STRATEGIES.includes(id)
}

/**
 * Chart data of the Terminal: drops what belongs to other strategies (e.g. the
 * retired C25/C27 history). Fills carry no strategy: they follow their order. Rows with no strategy id are kept.
 */
export function approvedChartData(input: {
  orders: unknown[]
  fills: unknown[]
  positions: unknown[]
  position: Record<string, unknown>
}) {
  const orders = input.orders.filter((order) =>
    isApprovedStrategyId(record(order).strategy_id),
  )
  const dropped = new Set(
    input.orders
      .filter((order) => !orders.includes(order))
      .map((order) => record(order).order_id),
  )
  return {
    orders,
    fills: input.fills.filter((fill) => !dropped.has(record(fill).order_id)),
    positions: input.positions.filter((item) =>
      isApprovedStrategyId(record(item).strategy_id),
    ),
    position: isApprovedStrategyId(input.position.strategy_id)
      ? input.position
      : {},
  }
}
