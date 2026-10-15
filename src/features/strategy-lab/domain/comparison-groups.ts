import type {
  Inventory,
  InventoryStrategy,
} from '../infrastructure/strategy-api.ts'

/**
 * Experiments of the comparison: each is its own book. `running` are the ones
 * the registry does not close (their operational badge still says what is
 * known: Kronos stays "Estado no verificado"); `stopped` are closed strategies
 * and the carry counter, which does not trade.
 */
export function splitExperiments(inventory: Inventory) {
  const running: InventoryStrategy[] = []
  const stopped: InventoryStrategy[] = []
  for (const row of inventory.strategies)
    (row.operational.state === 'closed' || row.kind === 'carry'
      ? stopped
      : running
    ).push(row)
  return { running, stopped }
}
