import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AnalysisInput,
  AnalysisProvider,
  AnalysisResult,
} from '../../domain/analysis'
import { moneyFromString } from '../../domain/money'
import type { Holding, PortfolioRepository } from '../../domain/portfolio'
import type { Candle } from '../../domain/market-data'
import {
  BTC_EUR,
  makeCandle,
  makeQuote,
} from '../../test/fake-market-data-provider'
import { useAnalysis } from './useAnalysis'

class FakeAnalysisProvider implements AnalysisProvider {
  analyzeCall = vi.fn<(input: AnalysisInput) => Promise<AnalysisResult>>()
  analyze = this.analyzeCall
}

function resultFor(overrides: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    instrumentId: 'BTC-EUR',
    classification: 'watch',
    reasons: ['Latest quote moved up 2.50%; noteworthy move.'],
    warnings: [
      'No position held; this assessment covers instrument surveillance only.',
    ],
    volatility: {
      lookbackCandles: 2,
      averageTrueRangePercent: 2,
      level: 'low',
    },
    ...overrides,
  }
}

const CANDLES: readonly Candle[] = [
  makeCandle({ time: '2024-01-01T00:00:00.000Z' }),
  makeCandle({ time: '2024-01-02T00:00:00.000Z' }),
]

describe('useAnalysis', () => {
  let analysis: FakeAnalysisProvider
  let repository: PortfolioRepository

  beforeEach(() => {
    analysis = new FakeAnalysisProvider()
    repository = {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn(),
      remove: vi.fn(),
      clear: vi.fn(),
    }
  })

  function render() {
    return renderHook(() =>
      useAnalysis({
        analysis,
        portfolioRepository: repository,
        instrument: BTC_EUR,
        quote: makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 }),
        candles: CANDLES,
      }),
    )
  }

  it('stays idle and touches nothing before the user asks', async () => {
    const { result } = render()
    expect(result.current.status).toBe('idle')
    expect(result.current.result).toBeNull()
    expect(result.current.error).toBeNull()
    expect(analysis.analyzeCall).not.toHaveBeenCalled()
    expect(repository.list).not.toHaveBeenCalled()
  })

  it('turns loading while the analysis request is in flight', async () => {
    const { result } = render()
    let resolveList: (holdings: Holding[]) => void = () => {}
    repository.list = vi.fn(
      () =>
        new Promise<Holding[]>((resolve) => {
          resolveList = resolve
        }),
    )

    act(() => {
      void result.current.analyze()
    })

    expect(result.current.status).toBe('loading')
    expect(result.current.result).toBeNull()

    await act(async () => resolveList([]))
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })

  it('reaches ready with the provider result and portfolio context', async () => {
    analysis.analyzeCall.mockResolvedValue(resultFor())
    repository.list = vi.fn().mockResolvedValue([
      {
        instrumentId: 'BTC-EUR',
        quantity: moneyFromString('0.5'),
        averageCost: moneyFromString('50000'),
      },
    ])
    const { result } = render()

    await act(async () => {
      await result.current.analyze()
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.error).toBeNull()
    expect(result.current.result).toEqual(resultFor())
    expect(analysis.analyzeCall).toHaveBeenCalledTimes(1)
    const input = analysis.analyzeCall.mock.calls[0]![0]
    expect(input.holding).toEqual({
      quantity: moneyFromString('0.5'),
      averageCost: moneyFromString('50000'),
    })
    expect(input.quote.price).toBe(60_000)
    expect(input.candles).toEqual(CANDLES)
  })

  it('reaches error when the provider rejects and keeps the message', async () => {
    analysis.analyzeCall.mockRejectedValue(new Error('analysis backend down'))
    const { result } = render()

    await act(async () => {
      await result.current.analyze()
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('analysis backend down')
    expect(result.current.result).toBeNull()
  })

  it('reaches error when the portfolio cannot be read', async () => {
    repository.list = vi.fn().mockRejectedValue(new Error('portfolio corrupt'))
    const { result } = render()

    await act(async () => {
      await result.current.analyze()
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error).toBe('portfolio corrupt')
    expect(analysis.analyzeCall).not.toHaveBeenCalled()
  })

  it('does nothing when no quote is available yet', async () => {
    const { result } = renderHook(() =>
      useAnalysis({
        analysis,
        portfolioRepository: repository,
        instrument: BTC_EUR,
        quote: undefined,
        candles: CANDLES,
      }),
    )

    await act(async () => {
      await result.current.analyze()
    })

    expect(result.current.status).toBe('idle')
    expect(repository.list).not.toHaveBeenCalled()
    expect(analysis.analyzeCall).not.toHaveBeenCalled()
  })

  it('ignores a stale response from a previous instrument', async () => {
    analysis.analyzeCall.mockResolvedValue(resultFor())
    repository.list = vi.fn().mockResolvedValue([])
    const { result, rerender } = renderHook(
      ({ id, quote }) =>
        useAnalysis({
          analysis,
          portfolioRepository: repository,
          instrument: { ...BTC_EUR, id, symbol: id },
          quote,
          candles: CANDLES,
        }),
      {
        initialProps: {
          id: 'BTC-EUR',
          quote: makeQuote({ instrumentId: 'BTC-EUR' }),
        },
      },
    )

    rerender({ id: 'TTWO', quote: makeQuote({ instrumentId: 'TTWO' }) })

    await act(async () => {
      await result.current.analyze()
    })

    expect(result.current.status).toBe('ready')
    expect(analysis.analyzeCall.mock.calls[0]![0].instrumentId).toBe('TTWO')
  })

  it('can analyze again with the same inputs', async () => {
    analysis.analyzeCall.mockResolvedValue(resultFor())
    const { result } = render()

    await act(async () => {
      await result.current.analyze()
    })
    await act(async () => {
      await result.current.analyze()
    })

    expect(analysis.analyzeCall).toHaveBeenCalledTimes(2)
    expect(result.current.status).toBe('ready')
  })
})

describe('useAnalysis fallback', () => {
  let analysis: FakeAnalysisProvider
  let fallback: FakeAnalysisProvider
  let repository: PortfolioRepository

  beforeEach(() => {
    analysis = new FakeAnalysisProvider()
    fallback = new FakeAnalysisProvider()
    repository = {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn(),
      remove: vi.fn(),
      clear: vi.fn(),
    }
  })

  function render() {
    return renderHook(() =>
      useAnalysis({
        analysis,
        fallback,
        portfolioRepository: repository,
        instrument: BTC_EUR,
        quote: makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 }),
        candles: CANDLES,
      }),
    )
  }

  it('reports a preferred source when the primary provider succeeds', async () => {
    analysis.analyzeCall.mockResolvedValue(resultFor())
    const { result } = render()

    await act(async () => {
      await result.current.analyze()
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.source).toBe('preferred')
    expect(result.current.warning).toBeNull()
    expect(fallback.analyzeCall).not.toHaveBeenCalled()
  })

  it('falls back to the local provider when the primary rejects', async () => {
    analysis.analyzeCall.mockRejectedValue(new Error('gemini rate limited'))
    fallback.analyzeCall.mockResolvedValue(resultFor())
    const { result } = render()

    await act(async () => {
      await result.current.analyze()
    })

    expect(result.current.status).toBe('ready')
    expect(result.current.source).toBe('fallback')
    expect(result.current.warning).toContain('gemini rate limited')
    expect(result.current.result).toEqual(resultFor())
  })

  it('reports the fallback error when both providers fail', async () => {
    analysis.analyzeCall.mockRejectedValue(new Error('gemini down'))
    fallback.analyzeCall.mockRejectedValue(new Error('local engine broken'))
    const { result } = render()

    await act(async () => {
      await result.current.analyze()
    })

    expect(result.current.status).toBe('error')
    expect(result.current.source).toBeNull()
    expect(result.current.warning).toBeNull()
    expect(result.current.error).toBe('local engine broken')
  })

  it('stays idle with a null source before the user asks', () => {
    const { result } = render()
    expect(result.current.status).toBe('idle')
    expect(result.current.source).toBeNull()
    expect(result.current.warning).toBeNull()
  })
})
