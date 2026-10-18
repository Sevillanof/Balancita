import type {
  Inventory,
  InventoryStrategy,
} from '../infrastructure/strategy-api.ts'

const RETIRED_STATES: readonly string[] = [
  'closed',
  'off',
  'retired',
  'inactive',
]

/**
 * The reason of a retired or turned-off strategy as a reader sees it. The
 * registry's own words are kept (config/strategy-closed.json, config/*.json);
 * only machine codes, repeated dates and maintenance instructions are removed.
 */
export function retiredReason(
  reason: string | null | undefined,
): string | null {
  if (!reason) return null
  if (reason === 'closed_with_engine_d')
    return 'se cerró con el motor viejo D: sin ventaja tras costes'
  return (
    reason
      .replace(/^apagada desde \d{4}-\d{2}-\d{2}:\s*/i, '')
      .replace(/^Retirada \([^)]*\):\s*/, '')
      .replace(/\s*Para reactivarla[^.]*\.\s*$/, '')
      .trim() || null
  )
}

/**
 * Estrategias page groups: `active` are the ones the registry has not closed,
 * turned off or retired (Kronos stays "Estado no verificado", Carry is its own
 * counter); `retired` go in the collapsed section with reason and date.
 */
export function splitStrategies(inventory: Inventory) {
  const active: InventoryStrategy[] = []
  const retired: InventoryStrategy[] = []
  for (const row of inventory.strategies)
    (RETIRED_STATES.includes(row.operational.state) ? retired : active).push(
      row,
    )
  return { active, retired }
}
