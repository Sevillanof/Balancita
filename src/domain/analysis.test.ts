import { describe, expect, it } from 'vitest'
import type {
  Candle,
  Instrument,
  Quote,
} from '../features/market-data/domain/market-data.ts'
import { money, moneyFromString } from '../shared/finance/money.ts'
import type { Holding } from '../features/portfolio/domain/portfolio.ts'
import { ANALYSIS_CLASSIFICATIONS, analysisInputFrom } from './analysis.ts'
import type {
  AnalysisClassification,
  AnalysisInput,
  AnalysisProvider,
  AnalysisResult,
} from './analysis.ts'

const BTC: Instrument = {
  id: 'BTC-EUR',
  symbol: 'BTC-EUR',
  displayName: 'Bitcoin / Euro',
  assetClass: 'crypto',
  currency: 'EUR',
  exchange: 'Mock',
  providerSymbols: { mock: 'BTC-EUR' },
}

const SPCX: Instrument = {
  id: 'SPCX',
  symbol: 'SPCX',
  displayName: 'SPCX',
  assetClass: 'unknown',
  currency: 'USD',
  providerSymbols: { mock: 'SPCX' },
}

function quote(overrides: Partial<Quote> = {}): Quote {
  return {
    instrumentId: 'BTC-EUR',
    price: 60_000,
    change: 0,
    changePercent: 0,
    timestamp: '2026-09-20T12:00:00.000Z',
    status: 'mock',
    ...overrides,
  }
}

function candle(overrides: Partial<Candle> = {}): Candle {
  return {
    time: '2024-01-01T00:00:00.000Z',
    open: 100,
    high: 105,
    low: 99,
    close: 104,
    volume: 1000,
    ...overrides,
  }
}

function holding(overrides: Partial<Holding> = {}): Holding {
  return {
    instrumentId: 'BTC-EUR',
    quantity: moneyFromString('1'),
    averageCost: moneyFromString('50000'),
    ...overrides,
  }
}

describe('analysis domain contract', () => {
  it('classifies results only as watch, neutral or review', () => {
    expect(ANALYSIS_CLASSIFICATIONS).toEqual([
      'watch',
      'neutral',
      'review',
    ] satisfies AnalysisClassification[])
  })

  it('expresses AnalysisResult with surveillance and educational fields', () => {
    const result: AnalysisResult = {
      instrumentId: 'BTC-EUR',
      classification: 'watch',
      recommendation: 'hold',
      reasons: ['reason'],
      warnings: [],
      volatility: {
        lookbackCandles: 2,
        averageTrueRangePercent: 2.5,
        level: 'moderate',
      },
      disclaimer: 'Recomendación educativa: no ejecuta órdenes.',
    }
    expect(result.classification).toBe('watch')
    expect(result.recommendation).toBe('hold')
    expect(result.reasons.length).toBeGreaterThan(0)
    expect(Array.isArray(result.warnings)).toBe(true)
    expect(result.volatility.averageTrueRangePercent).toBeGreaterThan(0)
  })

  it('exposes a provider contract that is async over AnalysisInput', () => {
    const provider: AnalysisProvider = {
      analyze: stubAnalyze,
    }
    expect(typeof provider.analyze).toBe('function')
    // The provider surface never exposes order execution entry points.
    const surface = provider as unknown as Record<string, unknown>
    expect('preview' in surface).toBe(false)
    expect('submit' in surface).toBe(false)
  })

  it('keeps AnalysisInput portfolio state in decimal Money', () => {
    const input: AnalysisInput = {
      instrumentId: 'BTC-EUR',
      symbol: 'BTC-EUR',
      assetClass: 'crypto',
      currency: 'EUR',
      quote: quote(),
      candles: [candle()],
      holding: { quantity: money(1n), averageCost: money(2n) },
    }
    expect(typeof input.holding?.quantity.units).toBe('bigint')
  })
})

describe('analysisInputFrom', () => {
  it('maps instrument, quote and candles into an AnalysisInput', () => {
    const q = quote({ price: 60_150, changePercent: 0.25 })
    const candles = [candle()]
    const input = analysisInputFrom({ instrument: BTC, quote: q, candles })

    expect(input.instrumentId).toBe('BTC-EUR')
    expect(input.symbol).toBe('BTC-EUR')
    expect(input.assetClass).toBe('crypto')
    expect(input.currency).toBe('EUR')
    expect(input.quote).toEqual(q)
    expect(input.candles).toEqual(candles)
    expect(input.holding).toBeNull()
  })

  it('attaches the holding for the instrument when present', () => {
    const holdings: readonly Holding[] = [
      holding({ instrumentId: 'BTW' }),
      holding({ instrumentId: 'BTC-EUR', quantity: moneyFromString('0.5') }),
    ]
    const input = analysisInputFrom({
      instrument: BTC,
      quote: quote(),
      candles: [],
      holdings,
    })

    expect(input.holding).toEqual({
      quantity: moneyFromString('0.5'),
      averageCost: moneyFromString('50000'),
    })
  })

  it('leaves holding null when the instrument is not in the portfolio', () => {
    const input = analysisInputFrom({
      instrument: SPCX,
      quote: quote({ instrumentId: 'SPCX' }),
      candles: [],
      holdings: [holding({ instrumentId: 'BTC-EUR' })],
    })

    expect(input.holding).toBeNull()
  })
})

describe('analysis/orders separation (domain)', () => {
  it('never imports or references the order execution domain', async () => {
    const rawModules = import.meta.glob('./analysis.ts', {
      query: '?raw',
      import: 'default',
    })
    const source = (await rawModules['./analysis.ts']()) as string
    expect(source).not.toMatch(
      /\borders\.ts\b|domain\/orders|OrderExecutionProvider/i,
    )
    expect(source).not.toMatch(/\bpreview\s*\(|\.submit\s*\(/i)
    expect(source).not.toMatch(
      /\b(OrderIntent|OrderPreview|OrderReceipt|ConfirmedOrder)\b/,
    )
  })
})

function stubAnalyze(input: AnalysisInput): Promise<AnalysisResult> {
  void input
  return Promise.resolve({
    instrumentId: 'BTC-EUR',
    classification: 'neutral',
    reasons: [],
    warnings: [],
    volatility: {
      lookbackCandles: 0,
      averageTrueRangePercent: 0,
      level: 'low',
    },
    recommendation: 'hold',
    disclaimer: 'Recomendación educativa: no ejecuta órdenes.',
  })
}
