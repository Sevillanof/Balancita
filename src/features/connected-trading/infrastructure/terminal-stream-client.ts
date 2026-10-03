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
  mode: 'mock' | 'paper_live' | 'replay'
  source: string | null
  active_run_id: string
  instrument_id?: string
  quote_currency?: string
  market?: Record<string, unknown>
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
    closed: true
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
      market.schema_version !== 'mock-terminal-market.v1' ||
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
        (candle.time_ms as number) + Number(market.interval_ms) >
          (market.as_of_ms as number) ||
        candle.closed !== true ||
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
  return value as unknown as TerminalEnvelope
}

export async function loadTerminalBootstrap(): Promise<TerminalBootstrap> {
  const response = await fetch('/api/terminal/bootstrap', {
    headers: { accept: 'application/json' },
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
    !['mock', 'paper_live', 'replay'].includes(String(value.mode)) ||
    typeof value.active_run_id !== 'string' ||
    !(typeof value.source === 'string' || value.source === null)
  )
    throw new Error('El servidor devolvió un modo de futuros inválido.')
  return value as unknown as TerminalBootstrap
}

export function terminalWebSocketUrl(): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${location.host}/api/terminal/stream`
}
