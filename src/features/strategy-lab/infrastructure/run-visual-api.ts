import { STRATEGIES_API_BASE } from './strategy-api.ts'

/**
 * Stored trades and candles of a FINISHED gate run, read-only through the
 * registry S. Nothing here recomputes a result: the figures, the trades and
 * the candles are what the run itself saved.
 */
export type RunSummary = {
  verdict: 'PASA' | 'NO PASA' | 'INCONCLUSO'
  verdict_note: string | null
  inconclusive_reasons: string[]
  trades: number
  min_trades: number
  mean_bp: number | null
  ci: [number | null, number | null]
  positive_folds: number
  folds: number
  min_positive_fold_share: number
  percentile: number | null
  min_percentile: number
  funding_share: number | null
  funding_status: Record<string, number>
  open_at_end: number | null
  contaminated: boolean
}

export type RunVisualSummary = {
  run_id: number
  strategy_id: string
  kind: 'practice' | 'exam'
  spec_hash: string
  products: string[]
  trades_by_product: Record<string, number>
  range_start_ms: number
  range_end_ms: number
  source: string
  resolution: string
  decision_evidence: string
  contaminated: boolean
  cost_model_version: string
  summary: RunSummary | null
  label: string
}

export type RunCandle = {
  time_ms: number
  open: string
  high: string
  low: string
  close: string
  volume: string
}

export type RunCandles = {
  run_id: number
  product: string
  resolution: string
  from_ms: number
  to_ms: number
  range_start_ms: number
  range_end_ms: number
  candles: RunCandle[]
  missing_minutes: number
}

export type RunTrade = {
  trade_id: string
  product_id: string
  side: 'LONG' | 'SHORT'
  entry_time_ms: number
  entry_bucket_ms: number | null
  entry_price: string | null
  exit_time_ms: number
  exit_bucket_ms: number | null
  exit_price: string | null
  exit_reason: string | null
  reason_code: string | null
  net_bp: number
  pnl_usd: number | null
  funding_usd: number | null
  funding_status: string
  notional_usd: string | null
  signal_time_ms: number | null
}

export type RunTrades = {
  run_id: number
  product: string
  total: number
  trades: RunTrade[]
  next_cursor: string | null
}

/** The server's error code (`artifact_not_ready`, `exam_not_unlocked`…) travels with the message. */
export class RunVisualError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export type RunWindow = { from?: number; to?: number }

export type RunVisualApi = {
  summary: (runId: number) => Promise<RunVisualSummary>
  candles: (
    runId: number,
    product: string,
    window?: RunWindow,
  ) => Promise<RunCandles>
  trades: (
    runId: number,
    product: string,
    options?: RunWindow & { cursor?: string; limit?: number },
  ) => Promise<RunTrades>
}

async function read<T>(response: Response): Promise<T> {
  if (response.ok) return (await response.json()) as T
  let code = 'http_error'
  let detail = `El registro respondió ${response.status}.`
  try {
    const body = (await response.json()) as { error?: string; detail?: string }
    if (body.error) code = body.error
    if (body.detail) detail = body.detail
  } catch {
    /* no JSON body */
  }
  throw new RunVisualError(code, detail)
}

function query(values: Record<string, string | number | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) params.set(key, String(value))
  return params.toString()
}

const base = (runId: number) => `${STRATEGIES_API_BASE}/gate/runs/${runId}`

export const runVisualApi: RunVisualApi = {
  async summary(runId) {
    return read(await fetch(`${base(runId)}/visual-summary`))
  },
  async candles(runId, product, window = {}) {
    return read(
      await fetch(
        `${base(runId)}/candles?${query({ product, from: window.from, to: window.to })}`,
      ),
    )
  },
  async trades(runId, product, options = {}) {
    return read(
      await fetch(
        `${base(runId)}/trades?${query({
          product,
          from: options.from,
          to: options.to,
          cursor: options.cursor,
          limit: options.limit,
        })}`,
      ),
    )
  },
}
