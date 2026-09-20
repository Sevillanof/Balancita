import { describe, expect, it } from 'vitest'
import { AnalysisInvalidRequestError } from './analysis-errors.ts'
import { isAnalysisResultJson, parseAnalysisInputRequest } from './wire.ts'

const validRequest = {
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

const validResult = {
  instrumentId: 'BTC-EUR',
  classification: 'watch',
  reasons: ['Latest quote moved up 0.50%; noteworthy move.'],
  warnings: [
    'No position held; this assessment covers instrument surveillance only.',
  ],
  volatility: {
    lookbackCandles: 1,
    averageTrueRangePercent: 2.5,
    level: 'low',
  },
}

describe('parseAnalysisInputRequest', () => {
  it('accepts a well-formed analysis input', () => {
    const parsed = parseAnalysisInputRequest(validRequest)
    expect(parsed.instrumentId).toBe('BTC-EUR')
    expect(parsed.quote.price).toBe(60_000)
    expect(parsed.candles).toHaveLength(1)
    expect(parsed.holding).toEqual({ quantity: '0.5', averageCost: '50000' })
  })

  it('accepts a request without a portfolio holding', () => {
    const parsed = parseAnalysisInputRequest({ ...validRequest, holding: null })
    expect(parsed.holding).toBeNull()
  })

  it('trims candle history to the configured cap', () => {
    const candles = Array.from({ length: 10 }, (_, index) => ({
      time: `2024-01-0${(index % 9) + 1}T00:00:00.000Z`,
      open: 100,
      high: 105,
      low: 99,
      close: 104,
      volume: 1000,
    }))
    const parsed = parseAnalysisInputRequest({ ...validRequest, candles }, 5)
    expect(parsed.candles).toHaveLength(5)
    expect(parsed.candles[0]!.close).toBe(104)
  })

  it.each([
    ['non-object payload', null],
    ['missing symbol', { ...validRequest, symbol: undefined }],
    ['missing quote', { ...validRequest, quote: undefined }],
    [
      'quote without finite price',
      { ...validRequest, quote: { ...validRequest.quote, price: Number.NaN } },
    ],
    ['candles not an array', { ...validRequest, candles: 'nope' }],
    [
      'candle with bad high',
      { ...validRequest, candles: [{ ...validRequest.candles[0], high: 'x' }] },
    ],
    [
      'holding with non-decimal quantity',
      { ...validRequest, holding: { quantity: '0,5', averageCost: '50000' } },
    ],
  ])('rejects %s', (_label, body) => {
    expect(() => parseAnalysisInputRequest(body)).toThrow(
      AnalysisInvalidRequestError,
    )
  })
})

describe('isAnalysisResultJson', () => {
  it('accepts a well-formed structured result', () => {
    expect(isAnalysisResultJson(validResult)).toBe(true)
  })

  it('ignores extra unknown fields from the model', () => {
    expect(
      isAnalysisResultJson({ ...validResult, extra: { model: 'thinking' } }),
    ).toBe(true)
  })

  it.each([
    [
      'classification outside the enum',
      { ...validResult, classification: 'buy' },
    ],
    ['reasons not a string array', { ...validResult, reasons: 'nope' }],
    ['missing volatility', { ...validResult, volatility: undefined }],
    [
      'volatility level outside the enum',
      {
        ...validResult,
        volatility: { ...validResult.volatility, level: 'huge' },
      },
    ],
    [
      'negative volatility percent',
      {
        ...validResult,
        volatility: { ...validResult.volatility, averageTrueRangePercent: -1 },
      },
    ],
    ['missing instrument id', { ...validResult, instrumentId: '' }],
  ])('rejects %s', (_label, value) => {
    expect(isAnalysisResultJson(value)).toBe(false)
  })
})
