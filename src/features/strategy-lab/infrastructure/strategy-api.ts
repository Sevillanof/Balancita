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
  setState(
    id: string,
    version: number,
    state: StrategyState,
  ): Promise<StrategyEntry & { gates: Gate[] }>
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
    setState: (id, version, state) =>
      request(`/strategies/${encodeURIComponent(id)}/state`, {
        version,
        state,
      }),
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
  throw new Error(`El registro de estrategias no respondió (${detail}).`)
}
