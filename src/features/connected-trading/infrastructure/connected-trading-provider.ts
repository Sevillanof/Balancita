export type ConnectedCandle = {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type ConnectedSnapshot = {
  receivedAt: number
  candles: ConnectedCandle[]
  collector: Record<string, unknown>
  paper: {
    enabled: boolean
    running: boolean
    stream_state?: string
    last_processed_event_time?: number | null
    account: Record<string, unknown>
    execution_summary: Record<string, unknown>
  }
  orders: Record<string, unknown>[]
  positions: {
    open: Record<string, unknown>[]
    closed: Record<string, unknown>[]
  }
  summary: Record<string, unknown>[]
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function requiredRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!record(value)) throw new Error(`La respuesta de ${label} no es válida.`)
  return value
}

function numberField(value: unknown, label: string): number {
  if (!finite(value)) throw new Error(`La respuesta de ${label} no es válida.`)
  return value
}

async function getJson(
  fetcher: Fetcher,
  url: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(url, {
    signal,
    headers: { Accept: 'application/json' },
  })
  if (!response.ok)
    throw new Error(`No se pudo cargar ${url} (${response.status}).`)
  return response.json()
}

function candlesFrom(value: unknown): ConnectedCandle[] {
  const payload = requiredRecord(value, 'OHLC')
  if (!Array.isArray(payload.candles))
    throw new Error('La respuesta OHLC no contiene velas válidas.')
  return payload.candles.map((item): ConnectedCandle => {
    const candle = requiredRecord(item, 'OHLC')
    const result = {
      timestamp: numberField(candle.timestamp, 'OHLC'),
      open: numberField(candle.open, 'OHLC'),
      high: numberField(candle.high, 'OHLC'),
      low: numberField(candle.low, 'OHLC'),
      close: numberField(candle.close, 'OHLC'),
      volume: numberField(candle.volume, 'OHLC'),
    }
    if (
      !Number.isSafeInteger(result.timestamp) ||
      result.timestamp < 100_000_000_000 ||
      result.low > result.high ||
      result.open < result.low ||
      result.open > result.high ||
      result.close < result.low ||
      result.close > result.high ||
      result.volume < 0
    )
      throw new Error('La respuesta OHLC contiene una vela inconsistente.')
    return result
  })
}

function recordArray(
  value: unknown,
  key: string,
  label: string,
): Record<string, unknown>[] {
  const rows = Array.isArray(value) ? value : requiredRecord(value, label)[key]
  if (!Array.isArray(rows) || !rows.every(record))
    throw new Error(`La respuesta de ${label} no es válida.`)
  return rows
}

function validateOrders(rows: Record<string, unknown>[]): void {
  if (
    !rows.every(
      (row) =>
        Number.isSafeInteger(row.id) &&
        typeof row.strategyId === 'string' &&
        Number.isSafeInteger(row.signalTimestamp) &&
        (row.action === 'BUY' || row.action === 'SELL') &&
        typeof row.gatePassed === 'boolean' &&
        (row.executionTimestamp === null ||
          Number.isSafeInteger(row.executionTimestamp)) &&
        finite(row.amountEur),
    )
  )
    throw new Error('La respuesta de las órdenes no es válida.')
}

function validatePositions(rows: Record<string, unknown>[]): void {
  if (
    !rows.every(
      (row) =>
        Number.isSafeInteger(row.id) &&
        typeof row.strategy_id === 'string' &&
        (row.status === 'OPEN' || row.status === 'CLOSED') &&
        typeof row.entry_time === 'string' &&
        Number.isFinite(Date.parse(row.entry_time)) &&
        finite(row.entry_price) &&
        finite(row.amount_eur) &&
        (row.fee_eur === undefined || finite(row.fee_eur)) &&
        (row.current_price === null ||
          row.current_price === undefined ||
          finite(row.current_price)) &&
        (row.unrealized_net_pnl_eur === null ||
          row.unrealized_net_pnl_eur === undefined ||
          finite(row.unrealized_net_pnl_eur)) &&
        (row.net_pnl_eur === null ||
          row.net_pnl_eur === undefined ||
          finite(row.net_pnl_eur)),
    )
  )
    throw new Error('La respuesta de las posiciones no es válida.')
}

function validateSummary(rows: Record<string, unknown>[]): void {
  if (
    !rows.every(
      (row) =>
        typeof row.strategy_id === 'string' &&
        typeof row.name === 'string' &&
        finite(row.total_signals) &&
        finite(row.gate_rejections) &&
        finite(row.net_pnl_eur),
    )
  )
    throw new Error('La respuesta del resumen de estrategias no es válida.')
}

export async function loadConnectedSnapshot(
  options: {
    fetcher?: Fetcher
    signal?: AbortSignal
    now?: number
  } = {},
): Promise<ConnectedSnapshot> {
  const fetcher = options.fetcher ?? fetch
  const now = options.now ?? Date.now()
  const start = Math.max(0, now - 24 * 60 * 60 * 1000)
  const query = `?start_time=${Math.floor(start)}&end_time=${Math.floor(now)}`
  const urls = [
    `/api/market/ohlc${query}`,
    '/api/market/collector/status',
    '/api/paper-trading/status',
    '/api/paper-trading/orders?limit=500',
    '/api/paper-trading/positions?status=open&limit=200',
    '/api/paper-trading/positions?status=closed&limit=200',
    '/api/paper-trading/strategies-summary',
  ]
  const [
    ohlcValue,
    collectorValue,
    paperValue,
    ordersValue,
    openValue,
    closedValue,
    summaryValue,
  ] = await Promise.all(
    urls.map((url) => getJson(fetcher, url, options.signal)),
  )
  const collector = requiredRecord(collectorValue, 'el colector')
  if (
    typeof collector.enabled !== 'boolean' ||
    typeof collector.running !== 'boolean' ||
    (collector.newest_candle_iso !== null &&
      (typeof collector.newest_candle_iso !== 'string' ||
        !Number.isFinite(Date.parse(collector.newest_candle_iso))))
  )
    throw new Error('La respuesta del colector no es válida.')
  const paper = requiredRecord(paperValue, 'paper trading')
  const account = requiredRecord(paper.account, 'la cuenta paper')
  const executionSummary = requiredRecord(
    paper.execution_summary,
    'el resumen paper',
  )
  if (typeof paper.enabled !== 'boolean' || typeof paper.running !== 'boolean')
    throw new Error('El estado de paper trading no es válido.')
  for (const [field, value] of Object.entries(account))
    if (value !== null && !finite(value))
      throw new Error(
        `La respuesta de la cuenta paper no es válida (${field}).`,
      )
  for (const [field, value] of Object.entries(executionSummary))
    if (!finite(value))
      throw new Error(`El resumen paper no es válido (${field}).`)
  const orders = recordArray(ordersValue, 'orders', 'las órdenes')
  const openPositions = recordArray(
    openValue,
    'positions',
    'las posiciones abiertas',
  )
  const closedPositions = recordArray(
    closedValue,
    'positions',
    'las posiciones cerradas',
  )
  const summary = recordArray(
    summaryValue,
    'strategies',
    'el resumen de estrategias',
  )
  validateOrders(orders)
  validatePositions(openPositions)
  validatePositions(closedPositions)
  validateSummary(summary)
  return {
    receivedAt: Date.now(),
    candles: candlesFrom(ohlcValue),
    collector,
    paper: {
      enabled: paper.enabled,
      running: paper.running,
      ...(typeof paper.stream_state === 'string'
        ? { stream_state: paper.stream_state }
        : {}),
      ...(paper.last_processed_event_time === null ||
      finite(paper.last_processed_event_time)
        ? { last_processed_event_time: paper.last_processed_event_time }
        : {}),
      account,
      execution_summary: executionSummary,
    },
    orders,
    positions: {
      open: openPositions,
      closed: closedPositions,
    },
    summary,
  }
}
