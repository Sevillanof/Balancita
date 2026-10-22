import type {
  VbtComparison,
  VbtExploration,
  VbtReport,
  VbtState,
  VbtVariant,
  VectorbtApi,
} from '../infrastructure/vectorbt-api.ts'
import type { StrategySpec } from '../domain/strategy-spec.ts'

/**
 * DATOS DE EJEMPLO: explorations, reports and a spec invented for unit tests
 * (never shown in the app). Real ones come from `/api-strategies/.../vectorbt`.
 */
export const exampleSpec = (): StrategySpec => ({
  schema: 'balancita-strategy.v1',
  id: 'x2',
  version: 1,
  name: 'X2 Ejemplo',
  params: {
    volume_multiplier: '1.25',
    stop_atr: '1.5',
    target_stop_ratio: '2',
    sqrt_bars: '8.485281',
  },
  rules: {
    checks: [
      {
        node: {
          available: 'donchian_high_available',
          operand: '1m.donchian_high20',
        },
      },
      {
        name: 'rsi_ok',
        node: {
          cmp: 'rsi_above_50',
          left: '1m.rsi14',
          op: '>',
          right: '50',
        },
      },
      {
        name: 'volume_ok',
        node: {
          cmp: 'volume_above_prior_mean',
          left: '1m.candidate_volume',
          op: '>',
          right: { mul: ['1m.prior_volume_mean20', '$volume_multiplier'] },
        },
      },
    ],
    sides: {},
    exit: {
      LONG: { cmp: 'never', left: '0', op: '>', right: '1' },
      SHORT: { cmp: 'never', left: '0', op: '>', right: '1' },
    },
    risk: { stop_atr: '$stop_atr', target_stop_ratio: '$target_stop_ratio' },
    horizon_minutes: 30,
  },
})

const totals = {
  trades: 143,
  entries_per_day: 1.2,
  gross_bp_mean: 12.4,
  net_bp_mean: -4.2,
  hit_rate: 0.46,
  funding_complete_share: 0.9,
}

export const variantRow = (
  rank: number,
  value: string,
  patch: Partial<VbtVariant> = {},
): VbtVariant => ({
  rank,
  value,
  label: `stop_atr = ${value}`,
  is_base: false,
  trades: 120 - rank * 10,
  entries_per_day: 1.5 - rank * 0.1,
  net_bp_mean: 8 - rank * 3,
  gross_bp_mean: 20,
  hit_rate: 0.5,
  status: 'ok',
  error: null,
  trial_id: rank,
  ...patch,
})

export const exampleReport = (patch: Partial<VbtReport> = {}): VbtReport => ({
  schema: 'balancita.vectorbt-exploration.v1',
  exploration_id: 'x2-20261022-101500',
  mode: 'diagnostic',
  status: 'ok',
  strategy_id: 'x2',
  strategy_name: 'X2 Ejemplo',
  family: 'x2',
  window: { from: '2025-10-16T00:00:00Z', to: '2026-04-19T00:00:00Z' },
  products: ['PF_XBTUSD', 'PF_ETHUSD'],
  generated_at: '2026-10-22T10:20:00Z',
  warning:
    'Esto es una hipótesis sobre datos de práctica, no un PASA: el veredicto lo da la compuerta.',
  unsupported: null,
  attempts_in_family: 4,
  diagnostic: {
    totals,
    by_product: [
      {
        product: 'PF_XBTUSD',
        days: 185,
        trades: 90,
        entries_per_day: 0.5,
        gross_bp_mean: 14,
        net_bp_mean: -2.5,
        hit_rate: 0.47,
        funding_complete_share: 0.9,
      },
      {
        product: 'PF_ETHUSD',
        days: 185,
        trades: 53,
        entries_per_day: 0.3,
        gross_bp_mean: 9,
        net_bp_mean: -7,
        hit_rate: 0.4,
        funding_complete_share: 0.9,
      },
    ],
    by_exit: [
      {
        reason: 'target',
        label: 'Objetivo',
        trades: 34,
        share: 0.24,
        gross_bp_mean: 70,
        net_bp_mean: 55.5,
        hit_rate: 1,
        funding_complete_share: 0.9,
      },
      {
        reason: 'stop',
        label: 'Stop',
        trades: 60,
        share: 0.42,
        gross_bp_mean: -40,
        net_bp_mean: -52,
        hit_rate: 0,
        funding_complete_share: 0.9,
      },
    ],
    signals: { raw: 200, skipped_by_cost: 57 },
    open_at_end: 0,
    works: ['Los cierres por objetivo ganan +70 pb en promedio.'],
    fails: ['En total pierde 4,2 pb por operación, en 143 operaciones.'],
    notes: ['Los datos de funding están incompletos.'],
  },
  ...patch,
})

export const variantsReport = (): VbtReport =>
  exampleReport({
    mode: 'variants',
    vary: {
      kind: 'param',
      name: 'stop_atr',
      label: 'stop_atr',
      base_value: '1.5',
    },
    variants_headline: 'La mejor variante gana 5 pb más que la actual.',
    variants: [
      variantRow(1, '2'),
      variantRow(2, '2.5'),
      variantRow(3, '1.5', { is_base: true }),
      variantRow(4, '1'),
      variantRow(5, '3', {
        status: 'error',
        error: 'valor no admitido',
        trades: 0,
        net_bp_mean: null,
      }),
    ],
  })

export const exploration = (
  patch: Partial<VbtExploration> = {},
): VbtExploration => ({
  id: 'x2-20261022-101500',
  strategy_id: 'x2',
  mode: 'diagnostic',
  vary: null,
  values: null,
  status: 'done',
  progress: 100,
  phase: 'Listo',
  detail: 'Exploración terminada',
  eta: null,
  created_at: Date.UTC(2026, 9, 22, 10, 15),
  finished_at: Date.UTC(2026, 9, 22, 10, 20),
  report: exampleReport(),
  confirmed: {},
  ...patch,
})

export const vbtState = (patch: Partial<VbtState> = {}): VbtState => ({
  strategy_id: 'x2',
  available: true,
  reason: null,
  running: null,
  busy_with: null,
  explorations: [],
  attempts_in_family: 4,
  ...patch,
})

export const comparison = (
  patch: Partial<VbtComparison> = {},
): VbtComparison => ({
  exploration_id: 'x2-20261022-101500',
  strategy_id: 'x2',
  run_id: 12,
  value: '2',
  label: 'stop_atr = 2',
  is_base: false,
  products: ['PF_XBTUSD'],
  cost_model_version: 'v1',
  window: {
    vectorbt: { from: '2025-10-16T00:00:00Z', to: '2026-04-19T00:00:00Z' },
    simulator: { from: '2025-10-16', to: '2026-04-19' },
  },
  vectorbt: {
    trades: 120,
    entries_per_day: 0.7,
    gross_bp_mean: 20,
    net_bp_mean: 5,
    cost_bp_mean: 12,
    funding_bp_mean: 3,
    hit_rate: 0.5,
  },
  simulator: {
    trades: 110,
    entries_per_day: 0.6,
    gross_bp_mean: 18,
    net_bp_mean: 1,
    cost_bp_mean: 14,
    funding_bp_mean: 3,
    hit_rate: 0.45,
  },
  difference: {
    trades: 10,
    entries_per_day: 0.1,
    gross_bp_mean: 2,
    net_bp_mean: 4,
    cost_bp_mean: -2,
    funding_bp_mean: 0,
    hit_rate: 0.05,
  },
  explanation: ['El simulador paga 2 pb más de costos por operación.'],
  warning: 'Sigue siendo una hipótesis: el veredicto lo da la compuerta.',
  ...patch,
})

export const fakeVectorbt = (
  state: VbtState,
  patch: Partial<VectorbtApi> = {},
): VectorbtApi => ({
  status: async () => state,
  launch: async () => ({ exploration_id: 'x2-new', pid: 1 }),
  cancel: async () => undefined,
  confirm: async () => ({
    strategy_id: 'x2-v2',
    version: 1,
    title: 'X2 Ejemplo · stop_atr=2',
    state: 'draft',
    already: false,
  }),
  compare: async () => comparison(),
  ...patch,
})
