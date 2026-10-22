import { STRATEGIES_API_BASE } from './strategy-api.ts'

/**
 * «Explorar con VectorBT» through the registry S (`docs/strategy-registry-api.md`,
 * report format in `docs/vectorbt-exploration-api.md`). Everything this client
 * returns is a HYPOTHESIS about practice data: it approves nothing and touches
 * neither the exam nor the paper. The server writes; this client reads and asks.
 */
export type VbtMode = 'diagnostic' | 'variants'
export type VbtStatus =
  'running' | 'done' | 'failed' | 'unsupported' | 'cancelled'

/** Averages are in basis points (pb): 1 pb = 0,01 % of the traded amount. `null`: the datum does not exist. */
export type VbtTotals = {
  trades: number
  entries_per_day: number | null
  gross_bp_mean: number | null
  net_bp_mean: number | null
  hit_rate: number | null
  funding_complete_share: number | null
  funding_bp_mean?: number | null
}

export type VbtByProduct = {
  product: string
  days: number
  trades: number
  entries_per_day: number | null
  gross_bp_mean: number | null
  net_bp_mean: number | null
  hit_rate: number | null
  funding_complete_share: number | null
}

export type VbtByExit = {
  reason: string
  label: string
  trades: number
  share: number | null
  gross_bp_mean: number | null
  net_bp_mean: number | null
  hit_rate: number | null
  funding_complete_share: number | null
}

export type VbtDiagnostic = {
  totals: VbtTotals
  by_product: VbtByProduct[]
  by_exit: VbtByExit[]
  by_side?: Array<
    Omit<VbtByExit, 'reason' | 'label'> & { side: string; label: string }
  >
  signals: { raw: number; skipped_by_cost: number }
  open_at_end: number
  works: string[]
  fails: string[]
  notes: string[]
}

export type VbtVariant = {
  rank: number
  value: string
  label: string
  is_base: boolean
  trades: number
  entries_per_day: number | null
  net_bp_mean: number | null
  gross_bp_mean: number | null
  hit_rate: number | null
  status: 'ok' | 'no_trades' | 'error'
  error: string | null
  trial_id?: number | null
}

export type VbtReport = {
  schema: string
  exploration_id: string
  mode: VbtMode
  status: 'ok' | 'unsupported'
  strategy_id: string
  strategy_name: string
  family: string
  window: { from: string; to: string }
  products: string[]
  generated_at: string
  warning: string
  glossary?: Record<string, string>
  unsupported: { reason: string } | null
  diagnostic: VbtDiagnostic | null
  vary?: {
    kind: 'param' | 'condition'
    name: string
    label: string
    base_value: string
  }
  variants?: VbtVariant[]
  variants_headline?: string
  attempts_in_family: number | null
}

export type VbtExploration = {
  id: string
  strategy_id: string
  mode: VbtMode
  vary: string | null
  values: string[] | null
  status: VbtStatus
  /** 0 to 100, real work done (never moves back). */
  progress: number
  phase: string
  detail: string
  /** Seconds left, `null` when it cannot be estimated. */
  eta: number | null
  created_at: number
  finished_at: number | null
  report: VbtReport | null
  /** Variant value → id of the draft strategy created with `confirm`. */
  confirmed: Record<string, string>
}

export type VbtState = {
  strategy_id: string
  available: boolean
  /** Why it is not available (with the install commands). */
  reason: string | null
  running: VbtExploration | null
  busy_with: { exploration_id: string; strategy_id: string } | null
  explorations: VbtExploration[]
  attempts_in_family: number | null
}

export type VbtRequest =
  { mode: 'diagnostic' } | { mode: 'variants'; vary: string; values: string[] }

export type VbtConfirmed = {
  strategy_id: string
  version: number
  title: string
  state: 'draft'
  already: boolean
}

export type VbtSide = {
  trades: number | null
  entries_per_day: number | null
  gross_bp_mean: number | null
  net_bp_mean: number | null
  cost_bp_mean: number | null
  funding_bp_mean: number | null
  hit_rate: number | null
  funding_complete_share?: number | null
  stop_share?: number | null
  raw_signals?: number | null
  skipped_by_cost?: number | null
}

export type VbtComparison = {
  exploration_id: string
  strategy_id: string
  run_id: number
  value: string
  label: string
  is_base: boolean
  products: string[]
  cost_model_version: string
  window: {
    vectorbt: { from: string; to: string }
    simulator: { from: string; to: string }
  }
  vectorbt: VbtSide
  simulator: VbtSide
  difference: Omit<VbtSide, 'funding_complete_share' | 'stop_share'>
  explanation: string[]
  warning: string | null
}

export type VectorbtApi = {
  status: (strategyId: string) => Promise<VbtState>
  launch: (
    strategyId: string,
    request: VbtRequest,
  ) => Promise<{ exploration_id: string; pid: number | null }>
  cancel: (strategyId: string, explorationId: string) => Promise<void>
  confirm: (
    strategyId: string,
    explorationId: string,
    value: string,
  ) => Promise<VbtConfirmed>
  compare: (
    strategyId: string,
    explorationId: string,
    value: string,
    runId?: number,
  ) => Promise<VbtComparison>
}

/** `{error, detail}` of the server: `code` is `busy`, `vectorbt_unavailable`, `unsupported_kind`, `run_not_found`… */
export class VectorbtError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, status: number, detail: string) {
    super(detail)
    this.name = 'VectorbtError'
    this.code = code
    this.status = status
  }
}

async function failure(response: Response): Promise<VectorbtError> {
  try {
    const body = (await response.json()) as { error?: string; detail?: string }
    return new VectorbtError(
      body.error ?? 'error',
      response.status,
      body.detail || `El registro respondió ${response.status}.`,
    )
  } catch {
    return new VectorbtError(
      'error',
      response.status,
      `El registro respondió ${response.status}.`,
    )
  }
}

const base = (strategyId: string) =>
  `${STRATEGIES_API_BASE}/strategies/${encodeURIComponent(strategyId)}/vectorbt`

const post = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

export const vectorbtApi: VectorbtApi = {
  async status(strategyId) {
    const response = await fetch(base(strategyId))
    if (!response.ok) throw await failure(response)
    return (await response.json()) as VbtState
  },
  async launch(strategyId, request) {
    const response = await post(base(strategyId), request)
    if (!response.ok) throw await failure(response)
    return (await response.json()) as {
      exploration_id: string
      pid: number | null
    }
  },
  async cancel(strategyId, explorationId) {
    const response = await post(
      `${base(strategyId)}/${encodeURIComponent(explorationId)}/cancel`,
      {},
    )
    if (!response.ok) throw await failure(response)
  },
  async confirm(strategyId, explorationId, value) {
    const response = await post(
      `${base(strategyId)}/${encodeURIComponent(explorationId)}/confirm`,
      { value },
    )
    if (!response.ok) throw await failure(response)
    return (await response.json()) as VbtConfirmed
  },
  async compare(strategyId, explorationId, value, runId) {
    const query = new URLSearchParams({ value })
    if (runId !== undefined) query.set('run_id', String(runId))
    const response = await fetch(
      `${base(strategyId)}/${encodeURIComponent(explorationId)}/compare?${query}`,
    )
    if (!response.ok) throw await failure(response)
    return (await response.json()) as VbtComparison
  },
}
