import type {
  Inventory,
  InventoryStrategy,
} from '../infrastructure/strategy-api.ts'

/**
 * DATOS DE EJEMPLO: a hand-built inventory for unit tests (never shown in the
 * app). Real figures come from `GET /api-strategies/inventory`.
 */
const forward = (start: number | null) => ({
  registered: start !== null,
  start_ms: start,
  registered_at: null,
  min_trades: 100,
  trades: null,
  available: false,
  missing: 'B5',
})

const range = {
  trades: 1,
  mean_net_bp: 1,
  t_stat: 1,
  folds_positive: 1,
  folds_judged: 4,
}

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

const backtest = (
  verdict: string,
  mean: number,
  t: number,
  trades: number,
) => ({
  ...range,
  trades,
  mean_net_bp: mean,
  t_stat: t,
  hit_rate: 0.4,
  median_net_bp: 0,
  pnl_usd: mean * 7,
  deflated_probability: 0,
  selection_trials: 1000,
  verdict,
  ranges: { previous: range, recent: range },
})

export const exampleInventory: Inventory = {
  schema: 'futures-strategy-inventory.v1',
  cost_model: { version: 'kraken-futures-costs.v2', hash: 'af5187f6c6a18826' },
  notional_usd: '100',
  thresholds: { t_tentative: 1.64, t_reliable: 2.58, reliable_trades: 100 },
  forward_min_trades: 100,
  period: {
    ranges: {
      previous: {
        first_bucket_ms: 0,
        last_bucket_ms: 240 * 86_400_000 - 60_000,
      },
    },
  },
  counts: {
    strategies: 5,
    active: 3,
    frozen: 5,
    closed: 1,
    investigating: 3,
    edge_evidence: 1,
  },
  missing: ['B5: forward trades per strategy'],
  strategies: [
    exampleRow({
      id: 'x1',
      name: 'X1 Candidata',
      research: {
        state: 'candidate_edge',
        evidence_of_edge: true,
        investigating: true,
        backtest: backtest('candidate_edge', 58.24, 1.58, 288),
      },
    }),
    exampleRow({
      id: 'x2',
      name: 'X2 Sin ventaja',
      research: {
        state: 'no_edge',
        evidence_of_edge: false,
        investigating: false,
        backtest: backtest('no_edge', 24.02, 0.87, 727),
      },
    }),
    exampleRow({
      id: 'x3',
      name: 'X3 Modelo de Qwen',
      kind: 'qwen_exit',
      no_backtest: true,
      market: { products: 8, horizon_minutes: null, exit_by: 'qwen' },
      operational: {
        state: 'active',
        basis: 'config',
        since_ms: 1,
        reason: null,
      },
    }),
    exampleRow({
      id: 'x4',
      name: 'X4 Modelo sin registro',
      kind: 'model',
      no_backtest: true,
      operational: {
        state: 'unverified',
        basis: 'none',
        since_ms: null,
        reason: null,
      },
    }),
    exampleRow({
      id: 'x5',
      name: 'X5 Cerrada',
      operational: {
        state: 'closed',
        basis: 'config',
        since_ms: null,
        reason: 'closed_with_engine_d',
      },
      research: {
        state: 'negative_edge',
        evidence_of_edge: false,
        investigating: false,
        backtest: backtest('negative_edge', -13.51, -106.67, 223652),
      },
    }),
  ],
}
