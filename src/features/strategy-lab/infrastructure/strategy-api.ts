import type { StrategySpec } from '../domain/strategy-spec.ts'

/**
 * Client of the strategy registry S (`docs/strategy-registry-api.md`): in dev
 * Vite proxies `/api-strategies` to the `strategies` child on 127.0.0.1:8790.
 */
export const STRATEGIES_API_BASE = '/api-strategies'

export type StrategyState = 'draft' | 'shadow' | 'active' | 'retired'
export type PeriodDays = 7 | 30 | 90

export type StrategyEntry = {
  id: string
  version: number
  name: string
  description: string
  kind?: string
  state: StrategyState
  active_version: number | null
  spec_hash?: string
  origin?: string
  parent?: { id: string; version: number } | null
  created_at?: number
}

export type RankingRow = StrategyEntry & {
  return_pct: number | null
  pnl_usd: number | null
  hit_rate: number | null
  trades: number
  wins: number
  few_trades: boolean
  deflated_sharpe_probability: number | null
}

export type Ranking = {
  product_id: string
  days: number
  buy_and_hold_pct: number | null
  min_trades: number
  verdicts_available: boolean
  detail?: string
  strategies: RankingRow[]
}

export type StrategyEvent = {
  version: number
  state: StrategyState
  reason: string
  known_at: number
}

export type StrategyDetail = StrategyEntry & {
  spec: StrategySpec
  versions: StrategyEntry[]
  events: StrategyEvent[]
}

export type BacktestSummary = {
  trades: number
  wins: number
  hit_rate: number | null
  mean_net_bp: number | null
  pnl_usd: number
  return_pct: number
  avg_win_usd: number | null
  avg_loss_usd: number | null
}

export type BacktestTrade = {
  side: 'LONG' | 'SHORT'
  entry_time_ms: number
  entry_price: string
  exit_time_ms: number
  exit_price: string
  exit_reason: string
  net_bp: number
  pnl_usd: number
}

export type Backtest = {
  period?: {
    first_bucket_ms: number | null
    last_bucket_ms: number | null
    verdicts: number
  }
  all: BacktestSummary
  in_sample: BacktestSummary
  out_of_sample: BacktestSummary
  max_drawdown: { pct: number | null; at_ms: number | null }
  buy_and_hold_pct: number | null
  vs_buy_and_hold_pts: number | null
  deflated_sharpe_probability: number | null
  trials: number
  min_trades: number
  trades: BacktestTrade[]
}

export type Evaluation = {
  bucket_start_ms: number
  regime: string | null
  proposal: {
    action: string
    reason_code: string
    conditions: Array<{ code: string; passed: boolean | null }>
  }
}

/** The same plan for every strategy (`futures_strategy_plan.py`), read-only. */
export type StrategyPlan = {
  id: string
  version: number
  signal: { type: string; model?: string }
  entry: { sides: string[]; checks: Array<string | null> }
  exit: {
    stop_atr: string | null
    target_stop_ratio: string | null
    volatility: string | null
    time_minutes: number | null
    rule: Record<string, string>
  }
  size: { mode: string; notional_usd: string }
  products: string
  costs: { model: string; scope: string }
  params: Record<string, string>
  branches?: Record<
    string,
    Pick<StrategyPlan, 'entry' | 'exit'> & { id: string }
  >
}

/** `GET /api-strategies/inventory` (docs/strategy-inventory-api.md): read-only. */
export type InventoryRange = {
  trades: number | null
  mean_net_bp: number | null
  t_stat: number | null
  folds_positive: number | null
  folds_judged: number | null
}

export type InventoryBacktest = InventoryRange & {
  hit_rate: number | null
  median_net_bp: number | null
  pnl_usd: number | null
  deflated_probability: number | null
  selection_trials: number | null
  verdict: string | null
  ranges: Record<string, InventoryRange>
}

/** `GET /api-strategies/forward` (docs/forward-result-api.md): read-only. */
export type ForwardProblem = { code: string; reason: string }

export type ForwardSide = {
  /** Open positions classified by their entry (an exit on late data can still make a live one recovered). */
  open: ForwardOpen
  closed: number
  net_usd: number
  mean_net_bp: number | null
  hit_rate: number | null
  funding_incomplete: number
  net_is_definitive: boolean
}

export type ForwardOpen = {
  count: number
  label: string
  pnl_usd: number
  positions: ForwardOpenPosition[]
}

export type ForwardOpenPosition = {
  product_id: string
  side: string
  entry_price: string
  opened_at_ms: number
  label: string
  recovered: boolean
  classification: string
  mark_price: string | null
  mark_bucket_ms: number | null
  pnl_usd: number | null
  net_bp: number | null
}

export type FundingState = {
  usable: boolean
  code: string
  reason: string
  checked_ms: number
}

export type ForwardResult = {
  state: { code: string; reason: string; since_ms: number | null }
  problems: ForwardProblem[]
  available: boolean
  live: ForwardSide
  recovered: ForwardSide
  open: {
    count: number
    label: string
    pnl_usd: number
    positions: ForwardOpenPosition[]
  }
  progress: {
    live_trades: number
    min_trades: number | null
    remaining: number | null
    reached: boolean
  }
  last_run_ms: number | null
  late: boolean | null
  funding_state: Record<string, FundingState>
}

export type QSkip = {
  product_id: string
  bucket_start: number
  question_id: string
  code: string
  reason: string
  written_at: number
}

export type QSkips = {
  available: boolean
  reason: string | null
  windows: Record<string, { total: number; by_code: Record<string, number> }>
  latest: QSkip[]
}

export type ForwardHealth = {
  generated_ms: number
  cadence_s: number
  late_after_s: number
  summary_updated_ms: number | null
  summary_available: boolean
  funding: Record<string, FundingState>
  q_skips: QSkips
}

export type InventoryStrategy = {
  id: string
  version: number
  name: string
  description: string
  kind: 'rules' | 'qwen_exit' | 'model' | 'carry'
  spec_hash: string | null
  operational: {
    state: string
    basis: string
    since_ms: number | null
    reason: string | null
  }
  frozen: boolean
  research: {
    state: string
    evidence_of_edge: boolean
    reliable?: boolean
    investigating: boolean
    backtest: InventoryBacktest | null
    text?: string
  }
  forward: {
    registered: boolean
    start_ms: number | null
    registered_at: string | null
    min_trades: number | null
    /** The forward result; `null` with `missing` (the reason) when none applies. */
    trades: ForwardResult | null
    available: boolean
    missing: string | null
    problems: ForwardProblem[]
  }
  market: {
    products: number | null
    horizon_minutes: number | null
    exit_by: 'rules' | 'qwen' | 'time' | null
  }
  note: string | null
  no_backtest: boolean
}

export type Inventory = {
  schema: string
  cost_model: { version: string; hash: string } | null
  notional_usd: string
  thresholds: {
    t_tentative?: number
    t_reliable?: number
    reliable_trades?: number
  }
  forward_min_trades: number | null
  period: {
    ranges?: Record<string, { first_bucket_ms: number; last_bucket_ms: number }>
  } | null
  counts: {
    strategies: number
    active: number
    frozen: number
    closed: number
    investigating: number
    edge_evidence: number
  }
  strategies: InventoryStrategy[]
  /** Funding per product and Q's skips; `null` when the service reads no forward. */
  forward_health: ForwardHealth | null
  missing: string[]
}

export type Gate = {
  code: string
  passed: boolean
  value: unknown
  threshold: unknown
}

export type Translation = {
  spec: StrategySpec | null
  untranslatable: string[] | null
  valid: boolean
  error: string | null
}

export type SpecRef = { id: string; version?: number } | { spec: StrategySpec }

export class StrategyApiError extends Error {
  readonly code: string
  readonly status: number
  readonly gates: Gate[]

  constructor(
    code: string,
    detail: string,
    status: number,
    gates: Gate[] = [],
  ) {
    super(detail)
    this.code = code
    this.status = status
    this.gates = gates
  }
}

export interface StrategyApi {
  readonly mode: 'registry' | 'example'
  ranking(days: PeriodDays, product?: string): Promise<Ranking>
  detail(id: string, version?: number): Promise<StrategyDetail>
  /** Inventory of every strategy; absent in the example API (no made-up data). */
  inventory?(): Promise<Inventory>
  /** Plans of every strategy by id; absent in the example API. */
  plans?(): Promise<Record<string, StrategyPlan>>
  backtest(ref: SpecRef, days: PeriodDays, product?: string): Promise<Backtest>
  evaluate(ref: SpecRef, product?: string): Promise<Evaluation>
  save(
    spec: StrategySpec,
    mode: 'modify' | 'new',
    newName?: string,
  ): Promise<StrategyEntry>
  variants(
    id: string,
    version: number,
    param: string,
    values: string[],
  ): Promise<StrategyEntry[]>
  importSpec(spec: StrategySpec, activate?: boolean): Promise<StrategyEntry>
  translate(
    text: string,
    source: 'pine' | 'freqtrade' | 'auto',
  ): Promise<Translation>
  /** `paperNow` skips the promotion gates: paper only, never real orders. */
  setState(
    id: string,
    version: number,
    state: StrategyState,
    paperNow?: boolean,
  ): Promise<StrategyEntry & { gates: Gate[] }>
  /** Hides the strategy and stops it; its history stays. `confirm` is its id typed back. */
  deleteStrategy(id: string, confirm: string): Promise<void>
}

export const DEFAULT_PRODUCT = 'PF_XBTUSD'

export function httpStrategyApi(
  base = STRATEGIES_API_BASE,
  fetcher: typeof fetch = (...args) => fetch(...args),
): StrategyApi {
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await fetcher(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers:
        body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      // A proxy error page is not JSON; the status below explains it.
    }
    if (!response.ok) {
      const error = (payload ?? {}) as {
        error?: string
        detail?: string
        gates?: Gate[]
      }
      throw new StrategyApiError(
        error.error ?? 'http_error',
        error.detail ?? `HTTP ${response.status}`,
        response.status,
        error.gates ?? [],
      )
    }
    return payload as T
  }
  return {
    mode: 'registry',
    ranking: (days, product = DEFAULT_PRODUCT) =>
      request(`/ranking?product=${encodeURIComponent(product)}&days=${days}`),
    detail: (id, version) =>
      request(
        `/strategies/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`,
      ),
    inventory: () => request('/inventory'),
    plans: async () =>
      (await request<{ plans: Record<string, StrategyPlan> }>('/plans')).plans,
    backtest: (ref, days, product = DEFAULT_PRODUCT) =>
      request('/backtest', { ...ref, product, days }),
    evaluate: (ref, product = DEFAULT_PRODUCT) =>
      request('/evaluate', { ...ref, product }),
    save: (spec, mode, newName) =>
      request('/strategies', {
        spec,
        mode,
        ...(newName ? { new_name: newName } : {}),
      }),
    variants: async (id, version, param, values) =>
      (
        await request<{ created: StrategyEntry[] }>(
          `/strategies/${encodeURIComponent(id)}/variants`,
          { version, param, values },
        )
      ).created,
    importSpec: (spec, activate) =>
      request('/import', { spec, ...(activate ? { activate: true } : {}) }),
    translate: (text, source) => request('/translate', { text, source }),
    setState: (id, version, state, paperNow) =>
      request(`/strategies/${encodeURIComponent(id)}/state`, {
        version,
        state,
        ...(paperNow ? { paper_now: true } : {}),
      }),
    deleteStrategy: async (id, confirm) => {
      await request(`/strategies/${encodeURIComponent(id)}/delete`, {
        confirm,
      })
    },
  }
}

/** The registry if it answers; otherwise throws (no made-up data). */
export async function connectStrategyApi(
  fetcher: typeof fetch = (...args) => fetch(...args),
): Promise<StrategyApi> {
  let detail = 'sin respuesta'
  try {
    const response = await fetcher(`${STRATEGIES_API_BASE}/health`)
    const body = (await response.json()) as { status?: string }
    if (response.ok && body.status === 'ok')
      return httpStrategyApi(STRATEGIES_API_BASE, fetcher)
    detail = `estado ${response.status}`
  } catch {
    // Not running.
  }
  throw new Error(
    `Registro de estrategias no disponible: servicio sin iniciar o sin respuesta (${detail}).`,
  )
}
