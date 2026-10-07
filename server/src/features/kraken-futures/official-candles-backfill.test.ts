import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FuturesMarketStore } from './futures-market-store.ts'
import { backfillOfficialCandles } from './official-candles-backfill.ts'
import {
  OFFICIAL_CANDLES_PER_REQUEST,
  parseOfficialCandles,
} from './official-candles.ts'

const MINUTE = 60_000
const T0 = 1_791_281_220_000 - (1_791_281_220_000 % (MINUTE * 5))
const NOW = T0 + 10_000 * MINUTE

function fakeClient() {
  const calls: Array<[string, number, number, number]> = []
  return {
    calls,
    async fetch(productId: string, intervalMs: number, from: number, to: number) {
      calls.push([productId, intervalMs, from, to])
      const candles = []
      for (let t = from; t < to; t += intervalMs)
        candles.push({
          time: t,
          open: '100',
          high: '101',
          low: '99',
          close: '100',
          volume: '1',
        })
      return parseOfficialCandles(
        JSON.stringify({ candles, more_candles: false }),
        { productId, intervalMs, fromMs: from, toMs: to, receivedAtMs: NOW },
      )
    },
  }
}

function newStore() {
  return new FuturesMarketStore(
    join(mkdtempSync(join(tmpdir(), 'backfill-')), 'market.sqlite'),
  )
}

describe('official candle backfill', () => {
  it('pages the range in 1800-candle requests and is resumable', async () => {
    const store = newStore()
    const client = fakeClient()
    const span = 4_000 * MINUTE
    const run = () =>
      backfillOfficialCandles({
        store,
        client,
        productId: 'PF_ETHUSD',
        intervalMs: MINUTE,
        fromMs: T0,
        toMs: T0 + span,
        requestGapMs: 0,
      })
    const first = await run()
    expect(first.requests).toBe(Math.ceil(4_000 / OFFICIAL_CANDLES_PER_REQUEST))
    expect(first.inserted).toBe(4_000)
    expect(store.countOfficialBuckets('PF_ETHUSD', MINUTE, T0, T0 + span)).toBe(4_000)
    const second = await run()
    expect(second.requests).toBe(0)
    expect(second.skippedWindows).toBe(first.requests)
    store.close()
  })

  it('only asks for the window that has a hole', async () => {
    const store = newStore()
    const client = fakeClient()
    const base = {
      store,
      client,
      productId: 'PF_XBTUSD',
      intervalMs: MINUTE,
      requestGapMs: 0,
    }
    await backfillOfficialCandles({ ...base, fromMs: T0, toMs: T0 + 1_800 * MINUTE })
    client.calls.length = 0
    const result = await backfillOfficialCandles({
      ...base,
      fromMs: T0,
      toMs: T0 + 3_600 * MINUTE,
    })
    expect(result.skippedWindows).toBe(1)
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]![2]).toBe(T0 + 1_800 * MINUTE)
    store.close()
  })
})
