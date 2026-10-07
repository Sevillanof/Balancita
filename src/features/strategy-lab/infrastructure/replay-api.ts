import { STRATEGIES_API_BASE } from './strategy-api.ts'
import type { LabCandle } from './lab-candles.ts'

/** Client of the historical replays of the registry (`/api-strategies/replays`). */
export type ReplayStatus = 'running' | 'done' | 'failed'
export type QwenTrigger = 'entry' | '5min' | 'all'

export type ReplaySummary = {
  strategy_id: string
  trades: number
  wins: number
  trade_hit_rate: number | null
  pnl_usd: number
  return_pct_on_notional: number
  decisions: number
  decision_hit_rate: number | null
  skipped: number
}

export type ReplayRun = {
  id: string
  status: ReplayStatus
  product_id: string
  start_ms: number
  end_ms: number
  qwen: { trigger?: QwenTrigger } | null
  error: string | null
  summaries?: ReplaySummary[]
}

export type ReplayTrade = {
  strategy_id: string
  side: 'LONG' | 'SHORT'
  entry_time_ms: number
  exit_time_ms: number
  net_bp: number
  pnl_usd: number
  hit: boolean
}

export type ReplayQwenDecision = {
  bucket_start: number
  chosen: 'buy' | 'hold' | 'sell'
  confidence: number | null
}

export type ReplayDetail = {
  id: string
  status: ReplayStatus
  summaries: ReplaySummary[]
  trades: ReplayTrade[]
  qwen: {
    decisions: ReplayQwenDecision[]
    report: {
      decisions: { hit_rate: number | null; scored: number; points: number }
      trading: {
        trades: number
        wins: number
        hit_rate: number | null
        pnl_usd: number
        return_pct: number
      }
    }
  } | null
}

export type ReplayRequest = {
  product: string
  from: string
  to: string
  qwen?: { trigger: QwenTrigger } | null
}

export interface ReplayApi {
  list(): Promise<ReplayRun[]>
  start(request: ReplayRequest): Promise<ReplayRun>
  detail(id: string): Promise<ReplayDetail>
  candles(id: string): Promise<LabCandle[]>
}

export function httpReplayApi(
  base = STRATEGIES_API_BASE,
  fetcher: typeof fetch = (...args) => fetch(...args),
): ReplayApi {
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
      const error = (payload ?? {}) as { detail?: string }
      throw new Error(error.detail ?? `HTTP ${response.status}`)
    }
    return payload as T
  }
  return {
    list: async () =>
      (await request<{ replays: ReplayRun[] }>('/replays')).replays,
    start: (body) => request('/replays', body),
    detail: (id) => request(`/replays/${encodeURIComponent(id)}`),
    candles: async (id) =>
      (
        await request<{ candles: LabCandle[] }>(
          `/replays/${encodeURIComponent(id)}/candles`,
        )
      ).candles,
  }
}
