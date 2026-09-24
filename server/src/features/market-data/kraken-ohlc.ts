export interface KrakenOhlcCandle {
  readonly timestamp: number
  readonly open: number
  readonly high: number
  readonly low: number
  readonly close: number
  readonly volume: number
  readonly source: 'kraken_rest_ohlc'
}

export const KRAKEN_OHLC_MAX_CANDLES = 720
export const KRAKEN_OHLC_MAX_HOURS = 12

export async function collectKrakenOhlc(input: {
  readonly baseUrl: string
  readonly hours: number
  readonly nowSeconds?: number
  readonly fetch: (url: string) => Promise<Response>
}): Promise<{ candles: readonly KrakenOhlcCandle[]; gapsDetected: number }> {
  if (
    !Number.isFinite(input.hours) ||
    input.hours <= 0 ||
    input.hours > KRAKEN_OHLC_MAX_HOURS
  )
    throw new Error('hours must be greater than 0 and at most 12.')
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const since = Math.max(0, Math.floor(now - input.hours * 3600))
  const collected = new Map<number, KrakenOhlcCandle>()
  const url = new URL(`${input.baseUrl.replace(/\/+$/, '')}/public/OHLC`)
  url.searchParams.set('pair', 'XBTEUR')
  url.searchParams.set('interval', '1')
  url.searchParams.set('since', String(since))
  const response = await input.fetch(url.toString())
  if (!response.ok)
    throw new Error(`Kraken OHLC returned HTTP ${response.status}.`)
  const body = (await response.json()) as {
    error?: unknown
    result?: Record<string, unknown>
  }
  if (!Array.isArray(body.error) || body.error.length > 0)
    throw new Error('Kraken OHLC response contains an upstream error.')
  const result = body.result
  const rows =
    result === undefined ? undefined : Object.values(result).find(Array.isArray)
  if (
    !Array.isArray(rows) ||
    typeof result?.last !== 'number' ||
    !Number.isSafeInteger(result.last)
  )
    throw new Error('Kraken OHLC response is malformed.')
  for (const raw of rows.slice(0, KRAKEN_OHLC_MAX_CANDLES)) {
    if (!Array.isArray(raw) || raw.length < 7)
      throw new Error('Kraken OHLC candle is malformed.')
    const [timestamp, open, high, low, close, , volume] = raw
    const values = [timestamp, open, high, low, close, volume].map(Number)
    if (
      values.some((value) => !Number.isFinite(value)) ||
      !Number.isSafeInteger(values[0]) ||
      values[0] < 0 ||
      values.slice(1, 5).some((value) => value <= 0) ||
      values[5] < 0
    )
      throw new Error('Kraken OHLC candle contains invalid numeric values.')
    const [time, o, h, l, c, v] = values as [
      number,
      number,
      number,
      number,
      number,
      number,
    ]
    if (time >= since && time + 60 <= now)
      collected.set(time, {
        timestamp: time,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v,
        source: 'kraken_rest_ohlc',
      })
  }
  const candles = [...collected.values()].sort(
    (a, b) => a.timestamp - b.timestamp,
  )
  let gapsDetected = 0
  for (let index = 1; index < candles.length; index += 1)
    if (candles[index]!.timestamp - candles[index - 1]!.timestamp !== 60)
      gapsDetected += 1
  return { candles, gapsDetected }
}
