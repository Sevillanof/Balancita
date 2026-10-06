import { describe, expect, it } from 'vitest'
import {
  createOfficialCandlesClient,
  officialCandlesUrl,
  parseOfficialCandles,
} from './official-candles.ts'

const MINUTE = 60_000
const T0 = 1_791_281_220_000 // a minute boundary

function body(candles: unknown[], more = false): string {
  return JSON.stringify({ candles, more_candles: more })
}

function candle(
  time: number,
  values: Partial<
    Record<'open' | 'high' | 'low' | 'close' | 'volume', string>
  > = {},
) {
  return {
    time,
    open: '85979',
    high: '86009',
    low: '85969',
    close: '85996',
    volume: '0.48930000',
    ...values,
  }
}

describe('official Kraken candles', () => {
  it('builds the public charts URL in seconds for 1m and 5m', () => {
    expect(officialCandlesUrl(MINUTE, T0, T0 + 600_000)).toBe(
      `https://futures.kraken.com/api/charts/v1/trade/PF_XBTUSD/1m?from=${T0 / 1000}&to=${(T0 + 600_000) / 1000}`,
    )
    expect(officialCandlesUrl(300_000, T0, T0)).toContain('/PF_XBTUSD/5m?')
    expect(() => officialCandlesUrl(900_000, T0, T0)).toThrow(/interval/)
  })

  it('keeps only settled closed candles and normalizes decimals', () => {
    const raw = body([
      candle(T0),
      candle(T0 + MINUTE, {
        volume: '0',
        open: '85996',
        high: '85996',
        low: '85996',
        close: '85996',
      }),
      candle(T0 + 2 * MINUTE), // closes at T0+3m, not settled yet
    ])
    const parsed = parseOfficialCandles(raw, {
      intervalMs: MINUTE,
      fromMs: T0,
      toMs: T0 + 3 * MINUTE,
      receivedAtMs: T0 + 3 * MINUTE + 1_000,
      settleMs: 2_000,
    })
    expect(parsed.candles.map((item) => item.bucketStart)).toEqual([
      T0,
      T0 + MINUTE,
    ])
    expect(parsed.candles[0]).toEqual({
      intervalMs: MINUTE,
      bucketStart: T0,
      open: '85979',
      high: '86009',
      low: '85969',
      close: '85996',
      volumeBtc: '0.4893',
    })
    expect(parsed.candles[1]!.volumeBtc).toBe('0')
    expect(parsed.rawResponse).toBe(raw)
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.receivedAtMs).toBe(T0 + 3 * MINUTE + 1_000)
  })

  it('rejects malformed, misaligned, duplicate or inconsistent candles', () => {
    const options = {
      intervalMs: MINUTE,
      fromMs: T0,
      toMs: T0 + 10 * MINUTE,
      receivedAtMs: T0 + 10 * MINUTE,
    }
    expect(() => parseOfficialCandles('{"candles":1}', options)).toThrow()
    expect(() => parseOfficialCandles(body([candle(T0 + 1)]), options)).toThrow(
      /aligned/,
    )
    expect(() =>
      parseOfficialCandles(body([candle(T0), candle(T0)]), options),
    ).toThrow(/duplicate/)
    expect(() =>
      parseOfficialCandles(body([candle(T0, { high: '1' })]), options),
    ).toThrow(/OHLC/)
    expect(() =>
      parseOfficialCandles(body([candle(T0, { volume: '-1' })]), options),
    ).toThrow(/decimal/)
    expect(() =>
      parseOfficialCandles(body([candle(T0, { close: '1e5' })]), options),
    ).toThrow(/decimal/)
  })

  it('fetches with a timeout and stamps receipt time from the clock', async () => {
    const requests: string[] = []
    const client = createOfficialCandlesClient({
      clock: () => T0 + 5 * MINUTE,
      fetch: async (input) => {
        requests.push(String(input))
        return new Response(body([candle(T0), candle(T0 + MINUTE)]))
      },
    })
    const response = await client.fetch(MINUTE, T0, T0 + 5 * MINUTE)
    expect(requests).toEqual([officialCandlesUrl(MINUTE, T0, T0 + 5 * MINUTE)])
    expect(response.candles).toHaveLength(2)
    expect(response.receivedAtMs).toBe(T0 + 5 * MINUTE)
    expect(response.fromMs).toBe(T0)
    expect(response.toMs).toBe(T0 + 5 * MINUTE)

    const failing = createOfficialCandlesClient({
      clock: () => T0,
      fetch: async () => new Response('busy', { status: 429 }),
    })
    await expect(failing.fetch(MINUTE, T0, T0)).rejects.toThrow(/HTTP 429/)
  })
})
