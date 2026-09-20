import { describe, expect, it } from 'vitest'
import {
  ANALYSIS_CLASSIFICATIONS,
  type AnalysisInput,
  type AnalysisResult,
} from '../domain/analysis'
import { moneyFromString } from '../domain/money'
import {
  BTC_EUR,
  SPCX,
  makeCandle,
  makeQuote,
} from '../test/fake-market-data-provider'
import { MockAnalysisProvider } from './mock-analysis-provider'

const provider = new MockAnalysisProvider()

function input(overrides: Partial<AnalysisInput> = {}): AnalysisInput {
  return {
    instrumentId: 'BTC-EUR',
    symbol: 'BTC-EUR',
    assetClass: 'crypto',
    currency: 'EUR',
    quote: makeQuote(),
    candles: [
      makeCandle({
        time: '2024-01-01T00:00:00.000Z',
        open: 100,
        high: 101,
        low: 99,
        close: 100,
      }),
      makeCandle({
        time: '2024-01-02T00:00:00.000Z',
        open: 100,
        high: 101,
        low: 99,
        close: 100,
      }),
    ],
    holding: null,
    ...overrides,
  }
}

function holdingAtCost(averageCost: string) {
  return {
    quantity: moneyFromString('1'),
    averageCost: moneyFromString(averageCost),
  }
}

async function classificationOf(value: AnalysisInput): Promise<string> {
  return (await provider.analyze(value)).classification
}

describe('MockAnalysisProvider', () => {
  it('always classifies within watch, neutral or review for a matrix of inputs', async () => {
    const variations = [-7, -5, -2.5, 0, 2.5, 5, 12]
    const assetClasses = ['crypto', 'equity', 'unknown'] as const
    for (const variation of variations) {
      for (const assetClass of assetClasses) {
        const result = await provider.analyze(
          input({ quote: makeQuote({ changePercent: variation }), assetClass }),
        )
        expect(ANALYSIS_CLASSIFICATIONS).toContain(result.classification)
      }
    }
  })

  it('is deterministic: identical inputs produce identical results', async () => {
    const audit: AnalysisInput = input({
      quote: makeQuote({ changePercent: 2.5 }),
    })
    const first = await provider.analyze(audit)
    const second = await provider.analyze(audit)
    expect(second).toEqual(first)
  })

  it('classifies as neutral when nothing is noteworthy', async () => {
    const result = await provider.analyze(input())
    expect(result.classification).toBe('neutral')
    expect(result.reasons).toContain(
      'No significant variation, volatility or position risk detected.',
    )
    expect(result.volatility.lookbackCandles).toBe(2)
  })

  it('treats variant quotes at the 2% and 5% boundaries inclusively', async () => {
    expect(
      await classificationOf(
        input({ quote: makeQuote({ changePercent: 1.99 }) }),
      ),
    ).toBe('neutral')
    expect(
      await classificationOf(
        input({ quote: makeQuote({ changePercent: 2.0 }) }),
      ),
    ).toBe('watch')
    expect(
      await classificationOf(
        input({ quote: makeQuote({ changePercent: 4.99 }) }),
      ),
    ).toBe('watch')
    expect(
      await classificationOf(
        input({ quote: makeQuote({ changePercent: 5.0 }) }),
      ),
    ).toBe('review')
    expect(
      await classificationOf(
        input({ quote: makeQuote({ changePercent: -5.0 }) }),
      ),
    ).toBe('review')
  })

  it('ratchets volatility into watch (moderate) and review (high)', async () => {
    const calm: AnalysisInput = input({
      candles: [
        makeCandle({ open: 100, high: 100.5, low: 99.5, close: 100 }),
        makeCandle({ open: 100, high: 100.5, low: 99.5, close: 100 }),
      ],
    })
    const swingy: AnalysisInput = input({
      candles: [
        makeCandle({ open: 100, high: 120, low: 85, close: 100 }),
        makeCandle({ open: 100, high: 125, low: 80, close: 100 }),
      ],
    })
    expect(await classificationOf(calm)).toBe('neutral')
    expect(await classificationOf(swingy)).toBe('review')
    const swingyResult = await provider.analyze(swingy)
    expect(swingyResult.volatility.level).toBe('high')
  })

  it('uses 3% and 8% ATR boundaries for volatility inclusively', async () => {
    const atRange = (range: number) =>
      input({
        candles: [
          makeCandle({ open: 100, high: 100 + range, low: 100, close: 100 }),
        ],
      })
    expect(await classificationOf(atRange(2))).toBe('neutral')
    expect(await classificationOf(atRange(3))).toBe('watch')
    expect(await classificationOf(atRange(8))).toBe('review')
  })

  it('reports elevated but not extreme volatility as watch', async () => {
    const input7 = input({
      candles: [makeCandle({ open: 100, high: 103.5, low: 96.5, close: 100 })],
    })
    expect(await classificationOf(input7)).toBe('watch')
  })

  it('falls back to a warning when no candle history is provided', async () => {
    const result = await provider.analyze(
      input({ candles: [], quote: makeQuote({ changePercent: 5 }) }),
    )
    expect(result.classification).toBe('review')
    expect(result.warnings.some((w) => /candle history/i.test(w))).toBe(true)
  })

  it('uses decimal portfolio math at the 10% and 30% P/L boundaries', async () => {
    const atCost = (cost: string, price: number) =>
      input({
        holding: holdingAtCost(cost),
        quote: makeQuote({ price }),
      })
    expect(await classificationOf(atCost('100', 105))).toBe('neutral')
    expect(await classificationOf(atCost('100', 110))).toBe('watch')
    expect(await classificationOf(atCost('100', 129))).toBe('watch')
    expect(await classificationOf(atCost('100', 130))).toBe('review')
    expect(await classificationOf(atCost('100', 70))).toBe('review')
  })

  it('combines watch-level signals into watch and three watch-levels into review', async () => {
    const moderateCandles = [
      makeCandle({ open: 100, high: 102, low: 98, close: 100 }),
    ]
    const twoWatches = input({
      quote: makeQuote({ changePercent: 2.5 }),
      candles: moderateCandles,
    })
    expect(await classificationOf(twoWatches)).toBe('watch')

    const threeWatches = input({
      quote: makeQuote({ changePercent: 2.5, price: 110 }),
      candles: moderateCandles,
      holding: holdingAtCost('100'),
    })
    expect(await classificationOf(threeWatches)).toBe('review')
  })

  it('warns when no position exists on a noticed instrument', async () => {
    const result = await provider.analyze(
      input({ quote: makeQuote({ changePercent: 2.5 }) }),
    )
    expect(result.classification).toBe('watch')
    expect(result.warnings.some((w) => /no position held/i.test(w))).toBe(true)
  })

  it('warns on an unconfirmed instrument identity', async () => {
    const result = await provider.analyze(
      input({
        instrumentId: 'SPCX',
        symbol: 'SPCX',
        assetClass: 'unknown',
        quote: makeQuote({ instrumentId: 'SPCX' }),
      }),
    )
    expect(result.warnings.some((w) => /unconfirmed/i.test(w))).toBe(true)
  })

  it('warns on a stale quote', async () => {
    const result = await provider.analyze(
      input({ quote: makeQuote({ status: 'stale', changePercent: 0 }) }),
    )
    expect(result.warnings.some((w) => /stale/i.test(w))).toBe(true)
  })

  it('never emits buy, sell or investment instructions', async () => {
    const seeds: Array<Partial<AnalysisInput>> = [
      {},
      { quote: makeQuote({ changePercent: 9 }) },
      { quote: makeQuote({ changePercent: -9 }) },
      { holding: holdingAtCost('50'), quote: makeQuote({ price: 100 }) },
      {
        candles: [
          makeCandle({ open: 100, high: 130, low: 70, close: 100 }),
          makeCandle({ open: 100, high: 130, low: 70, close: 100 }),
        ],
      },
      { assetClass: 'unknown', instrumentId: 'SPCX', symbol: 'SPCX' },
    ]
    for (const seed of seeds) {
      const result: AnalysisResult = await provider.analyze(input(seed))
      const text = [...result.reasons, ...result.warnings]
        .join(' ')
        .toLowerCase()
      expect(text).not.toMatch(/\b(buy|sell|purchase|recommend|invest)\b/)
    }
  })

  it('formats reasons with the measured numbers', async () => {
    const result = await provider.analyze(
      input({ quote: makeQuote({ changePercent: 2.0 }) }),
    )
    expect(result.reasons.join(' ')).toMatch(/2\.00/)
  })

  it('exposes only the analyze surface and never subscribes or executes', () => {
    const surface = provider as unknown as Record<string, unknown>
    expect(typeof provider.analyze).toBe('function')
    expect('subscribe' in surface).toBe(false)
    expect('preview' in surface).toBe(false)
    expect('submit' in surface).toBe(false)
  })
})

describe('mock provider / orders separation (source)', () => {
  it('never imports orders and uses no randomness or clock for answers', async () => {
    const rawModules = import.meta.glob('./mock-analysis-provider.ts', {
      query: '?raw',
      import: 'default',
    })
    const source = (await rawModules['./mock-analysis-provider.ts']()) as string
    expect(source).not.toMatch(
      /\borders\.ts\b|domain\/orders|OrderExecutionProvider/i,
    )
    expect(source).not.toMatch(/\bpreview\s*\(|\.submit\s*\(/i)
    expect(source).not.toMatch(/Math\.random|Date\.now|crypto\.randomUUID/i)
  })
})
