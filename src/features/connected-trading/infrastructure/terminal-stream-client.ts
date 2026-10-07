export type TerminalEnvelope = {
  schema_version: 1
  event_id: string
  stream_id: string
  run_id: string
  seq: number
  type: string
  instrument_id: string
  event_time: number
  published_at: number
  data: Record<string, unknown>
}

export type TerminalBootstrap = {
  schema_version: 1
  mode: 'mock' | 'paper_live'
  source: string | null
  active_run_id: string
  instrument_id?: string
  quote_currency?: string
  market?: Record<string, unknown>
  terminal_market?: Record<string, unknown>
  source_manifest?: Record<string, unknown>
  engine?: Record<string, unknown>
}

export type MockTerminalMarket = {
  schema_version: 'mock-terminal-market.v1'
  as_of_ms: number
  interval_ms: number
  candles: Array<{
    time_ms: number
    open: string
    high: string
    low: string
    close: string
    volume_btc: string
    closed: boolean
  }>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function parseTerminalEnvelope(value: unknown): TerminalEnvelope | null {
  if (!isRecord(value) || !isRecord(value.data)) return null
  if (
    value.schema_version !== 1 ||
    typeof value.event_id !== 'string' ||
    typeof value.stream_id !== 'string' ||
    typeof value.run_id !== 'string' ||
    !Number.isSafeInteger(value.seq) ||
    (value.seq as number) < 0 ||
    typeof value.type !== 'string' ||
    typeof value.instrument_id !== 'string' ||
    !Number.isFinite(value.event_time) ||
    !Number.isFinite(value.published_at)
  )
    return null
  if (
    value.type === 'snapshot' &&
    (!Number.isSafeInteger(value.data.watermark) || !isRecord(value.data.state))
  )
    return null
  if (value.type === 'snapshot' && value.data.market !== undefined) {
    const market = value.data.market
    if (
      !isRecord(market) ||
      !['mock-terminal-market.v1', 'futures-terminal-market.v1'].includes(
        String(market.schema_version),
      ) ||
      !Number.isSafeInteger(market.as_of_ms) ||
      ![60_000, 300_000, 900_000, 3_600_000].includes(
        Number(market.interval_ms),
      ) ||
      !Array.isArray(market.candles) ||
      market.candles.length > 500
    )
      return null
    let previousTime = -1
    for (const candle of market.candles) {
      if (
        !isRecord(candle) ||
        !Number.isSafeInteger(candle.time_ms) ||
        (candle.time_ms as number) <= previousTime ||
        (candle.closed === true &&
          (candle.time_ms as number) + Number(market.interval_ms) >
            (market.as_of_ms as number)) ||
        typeof candle.closed !== 'boolean' ||
        !['open', 'high', 'low', 'close', 'volume_btc'].every(
          (key) =>
            typeof candle[key] === 'string' &&
            /^\d+(?:\.\d+)?$/.test(candle[key] as string),
        )
      )
        return null
      previousTime = candle.time_ms as number
    }
  }
  if (value.type === 'market.updated' && value.data.candle !== undefined) {
    const candle = value.data.candle
    if (
      !isRecord(candle) ||
      !Number.isSafeInteger(candle.bucket_start_ms) ||
      ![60_000, 300_000, 900_000, 3_600_000].includes(
        Number(candle.interval_ms),
      ) ||
      !Number.isSafeInteger(candle.known_at_ms) ||
      typeof candle.closed !== 'boolean' ||
      (candle.closed === true &&
        Number(candle.known_at_ms) <
          Number(candle.bucket_start_ms) + Number(candle.interval_ms)) ||
      !['open', 'high', 'low', 'close', 'volume_btc'].every(
        (key) =>
          typeof candle[key] === 'string' &&
          /^\d+(?:\.\d+)?$/.test(candle[key] as string),
      )
    )
      return null
  }
  if (
    value.type === 'market.updated' &&
    value.data.book_quality !== undefined &&
    (!isRecord(value.data.book_quality) ||
      value.data.book_quality.source_guarantee !== 'undocumented' ||
      !['observed_contiguous', 'invalid_or_unproven'].includes(
        String(value.data.book_quality.book_sequence_integrity),
      ))
  )
    return null
  return value as unknown as TerminalEnvelope
}

/** Data source behind the terminal: the scripted MOCK API or the live gateway. */
export type TerminalSource = 'mock' | 'live'

export function terminalApiBase(source: TerminalSource): string {
  return source === 'mock' ? '/api-mock' : '/api-live'
}

/** A hung backend must surface as an explicit error, never an endless spinner. */
export const TERMINAL_BOOTSTRAP_TIMEOUT_MS = 8_000

export async function loadTerminalBootstrap(
  apiBase = '/api',
): Promise<TerminalBootstrap> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    TERMINAL_BOOTSTRAP_TIMEOUT_MS,
  )
  try {
    return await fetchTerminalBootstrap(apiBase, controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

async function fetchTerminalBootstrap(
  apiBase: string,
  signal: AbortSignal,
): Promise<TerminalBootstrap> {
  const response = await fetch(`${apiBase}/terminal/bootstrap`, {
    headers: { accept: 'application/json' },
    signal,
  })
  if (!response.ok) {
    const failure = new Error(`Terminal bootstrap failed (${response.status}).`)
    Object.assign(failure, { status: response.status })
    throw failure
  }
  const value: unknown = await response.json()
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    !['mock', 'paper_live'].includes(String(value.mode)) ||
    typeof value.active_run_id !== 'string' ||
    !(typeof value.source === 'string' || value.source === null)
  )
    throw new Error('El servidor devolvió un modo de futuros inválido.')
  return value as unknown as TerminalBootstrap
}

export function terminalWebSocketUrl(apiBase = '/api'): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}${apiBase}/terminal/stream`
}
