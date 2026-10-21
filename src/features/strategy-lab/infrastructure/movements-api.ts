/** Movimientos de Qwen y Kronos en el paper (`docs/movimientos-api.md`), solo lectura. */
export const MOVEMENTS_URL = '/api-live/movements'

export type MovementSource = 'qwen' | 'kronos'
export type MovementStatus = 'open' | 'closed'

export type Movement = {
  id: string
  source: MovementSource
  product_id: string
  side: 'LONG' | 'SHORT'
  status: MovementStatus
  opened_at_ms: number
  closed_at_ms: number | null
  entry_price: string | null
  exit_price: string | null
  quantity: string | null
  notional_usd: number
  fees_usd: number | null
  funding_usd: number | null
  funding_status: 'complete' | 'partial' | 'unknown' | 'not_charged'
  net_usd: number | null
  net_pct: number | null
  open_reason: string | null
  close_reason: string | null
  decision: {
    answer: string | null
    probability: number | null
    at_ms: number | null
  } | null
  forecast: { expected_bp: number; threshold_bp: number } | null
}

export type MovementSummary = {
  operations: number
  open: number
  closed: number
  wins: number
  hit_rate: number | null
  net_usd: number
  forecasts_without_trade: number | null
}

export type MovementsReport = {
  status: 'ok' | 'error' | 'unreachable'
  reason?: string
  source: MovementSource
  summary: Record<MovementSource, MovementSummary> | null
  total: number
  items: Movement[]
  sources: Record<MovementSource, 'ok' | 'off'>
  reasons: Record<MovementSource, string | null>
}

export type MovementsQuery = {
  source: MovementSource
  product?: string
  status?: MovementStatus
  from?: string
  to?: string
  limit?: number
  offset?: number
}

const EMPTY = (
  source: MovementSource,
  status: 'error' | 'unreachable',
  reason: string,
): MovementsReport => ({
  status,
  reason,
  source,
  summary: null,
  total: 0,
  items: [],
  sources: { qwen: 'off', kronos: 'off' },
  reasons: { qwen: null, kronos: null },
})

export async function loadMovements(
  query: MovementsQuery,
  fetcher: typeof fetch = (...args) => fetch(...args),
): Promise<MovementsReport> {
  const params = new URLSearchParams({ source: query.source })
  for (const key of ['product', 'status', 'from', 'to'] as const) {
    const value = query[key]
    if (value) params.set(key, value)
  }
  if (query.limit !== undefined) params.set('limit', String(query.limit))
  if (query.offset !== undefined) params.set('offset', String(query.offset))
  try {
    const response = await fetcher(`${MOVEMENTS_URL}?${params}`)
    const body = (await response.json()) as {
      status?: string
      reason?: string
      summary?: MovementsReport['summary']
      page?: { total: number }
      items?: Movement[]
      sources?: MovementsReport['sources']
      reasons?: MovementsReport['reasons']
    }
    if (body.status !== 'ok')
      return EMPTY(
        query.source,
        'error',
        body.reason ?? `HTTP ${response.status}`,
      )
    return {
      status: 'ok',
      source: query.source,
      summary: body.summary ?? null,
      total: body.page?.total ?? 0,
      items: Array.isArray(body.items) ? body.items : [],
      sources: body.sources ?? { qwen: 'off', kronos: 'off' },
      reasons: body.reasons ?? { qwen: null, kronos: null },
    }
  } catch {
    return EMPTY(query.source, 'unreachable', 'gateway_unreachable')
  }
}
