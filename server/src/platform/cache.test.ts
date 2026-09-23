import { describe, expect, it } from 'vitest'
import { AnalysisCache, hashAnalysisInput } from './cache.ts'
import type {
  AnalysisInputRequest,
  AnalysisResultJson,
} from '../features/analysis/wire.ts'

const input: AnalysisInputRequest = {
  instrumentId: 'BTC-EUR',
  symbol: 'BTC-EUR',
  assetClass: 'crypto',
  currency: 'EUR',
  quote: {
    price: 60_000,
    change: 300,
    changePercent: 0.5,
    timestamp: '2026-09-20T12:00:00.000Z',
    status: 'mock',
  },
  candles: [
    {
      time: '2024-01-01T00:00:00.000Z',
      open: 50_000,
      high: 51_000,
      low: 49_000,
      close: 50_500,
      volume: 1000,
    },
  ],
  holding: { quantity: '0.5', averageCost: '50000' },
}

const result: AnalysisResultJson = {
  instrumentId: 'BTC-EUR',
  classification: 'watch',
  recommendation: 'hold',
  reasons: ['Latest quote moved up 0.50%; noteworthy move.'],
  warnings: [],
  volatility: { lookbackCandles: 1, averageTrueRangePercent: 2, level: 'low' },
  disclaimer:
    'Recomendación educativa e informativa: no es asesoramiento financiero y no ejecuta órdenes.',
}

describe('hashAnalysisInput', () => {
  it('is deterministic for the same input', () => {
    expect(hashAnalysisInput(input)).toBe(hashAnalysisInput(input))
  })

  it('changes when a meaningful field changes', () => {
    expect(
      hashAnalysisInput({ ...input, quote: { ...input.quote, price: 61_000 } }),
    ).not.toBe(hashAnalysisInput(input))
  })

  it('changes when the holding changes', () => {
    expect(
      hashAnalysisInput({
        ...input,
        holding: { quantity: '1', averageCost: '50000' },
      }),
    ).not.toBe(hashAnalysisInput(input))
  })
})

describe('AnalysisCache', () => {
  it('stores and returns a copy of the result', () => {
    const cache = new AnalysisCache(10)
    cache.set('a', result)
    const hit = cache.get('a')
    expect(hit).toEqual(result)
    expect(hit).not.toBe(result)
    expect(cache.size).toBe(1)
  })

  it('returns undefined for a missing key', () => {
    const cache = new AnalysisCache(10)
    expect(cache.get('missing')).toBeUndefined()
  })

  it('evicts the oldest entry when full', () => {
    const cache = new AnalysisCache(2)
    cache.set('a', result)
    cache.set('b', result)
    cache.set('c', result)
    expect(cache.size).toBe(2)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toEqual(result)
    expect(cache.get('c')).toEqual(result)
  })

  it('rejects an invalid capacity', () => {
    expect(() => new AnalysisCache(0)).toThrow(RangeError)
  })

  it('expires entries after the temporary TTL', () => {
    let now = 1_000
    const cache = new AnalysisCache(10, 100, () => now)
    cache.set('a', result)
    expect(cache.get('a')).toEqual(result)

    now += 100
    expect(cache.get('a')).toBeUndefined()
  })

  it('rejects an invalid TTL', () => {
    expect(() => new AnalysisCache(10, 0)).toThrow(RangeError)
  })
})
