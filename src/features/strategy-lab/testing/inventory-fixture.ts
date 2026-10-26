import type { InventoryStrategy } from '../infrastructure/strategy-api.ts'

/**
 * DATOS DE EJEMPLO: a hand-built inventory for unit tests (never shown in the
 * app). Real figures come from `GET /api-strategies/inventory`.
 */
const forward = (start: number | null) => ({
  registered: start !== null,
  start_ms: start,
  registered_at: null,
  min_trades: 15,
  trades: null,
  available: false,
  missing: 'el servicio no tiene configurada la lectura del forward',
  problems: [],
})

export function exampleRow(
  patch: Partial<InventoryStrategy> & Pick<InventoryStrategy, 'id' | 'name'>,
): InventoryStrategy {
  return {
    version: 1,
    description: 'Descripción de ejemplo',
    kind: 'rules',
    spec_hash: 'abcdef0123456789',
    operational: {
      state: 'active',
      basis: 'registry',
      since_ms: null,
      reason: null,
    },
    frozen: true,
    research: {
      state: 'unmeasured',
      evidence_of_edge: false,
      investigating: true,
      backtest: null,
    },
    forward: forward(null),
    market: { products: 8, horizon_minutes: 1440, exit_by: 'rules' },
    note: null,
    no_backtest: false,
    ...patch,
  }
}
