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
