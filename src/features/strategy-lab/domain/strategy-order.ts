import type { InventoryStrategy } from '../infrastructure/strategy-api.ts'
import { STAGES, type StageName } from './run-stage.ts'

/** Where a strategy stands in the cycle and what its latest test netted per trade. */
export type Standing = { stage: number; meanBp: number | null }

export type StrategyGroup = {
  key: string
  /** `null` for the models block, which has no heading. */
  title: StageName | null
  rows: InventoryStrategy[]
}

const MODEL_RANK: Partial<Record<InventoryStrategy['kind'], number>> = {
  qwen_live: 0,
  qwen_exit: 1,
  model: 2,
}
const isModel = (row: InventoryStrategy) => row.kind in MODEL_RANK

/** Highest net per trade first; strategies without a figure go last, in inventory order. */
const byNet =
  (standings: ReadonlyMap<string, Standing>) =>
  (a: InventoryStrategy, b: InventoryStrategy) => {
    const x = standings.get(a.id)?.meanBp ?? null
    const y = standings.get(b.id)?.meanBp ?? null
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
    return y - x
  }

/**
 * The list of the Estrategias screen: Qwen and Kronos first, then the other
 * strategies split by stage of the cycle (Hipótesis → Paper), each group sorted
 * by «Neto por operación» from the highest to the lowest. Empty stages are left out.
 */
export function groupStrategies(
  rows: InventoryStrategy[],
  standings: ReadonlyMap<string, Standing>,
): StrategyGroup[] {
  const indexed = rows.map((row, index) => ({ row, index }))
  const models = indexed
    .filter(({ row }) => isModel(row))
    .sort(
      (a, b) =>
        (MODEL_RANK[a.row.kind] ?? 9) - (MODEL_RANK[b.row.kind] ?? 9) ||
        a.index - b.index,
    )
    .map(({ row }) => row)
  const groups: StrategyGroup[] = models.length
    ? [{ key: 'models', title: null, rows: models }]
    : []
  const others = rows.filter((row) => !isModel(row))
  STAGES.forEach((title, stage) => {
    // Array.prototype.sort is stable, so ties keep the inventory order.
    const inStage = others
      .filter((row) => (standings.get(row.id)?.stage ?? 0) === stage)
      .sort(byNet(standings))
    if (inStage.length) groups.push({ key: title, title, rows: inStage })
  })
  return groups
}
