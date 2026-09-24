import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Instrument } from '../../market-data/domain/market-data.ts'
import { moneyFromString } from '../../../shared/finance/money.ts'
import type {
  OrderExecutionProvider,
  OrderPreview,
  OrderReceipt,
} from '../domain/orders.ts'
import { BUY, SELL } from '../domain/orders.ts'
import type { PaperTradingAccount } from '../infrastructure/local-paper-trading-provider'
import {
  BTC_EUR,
  FakeMarketDataProvider,
  TTWO,
  makeQuote,
} from '../../../shared/testing/fake-market-data-provider'
import { useTrading } from './useTrading.ts'
import { LocalStoragePortfolioRepository } from '../../portfolio/infrastructure/local-storage-portfolio-repository.ts'
import { LocalPaperTradingProvider } from '../infrastructure/local-paper-trading-provider'
import {
  calculateMomentumIndicators,
  evaluateMomentumSignal,
  SIMULATED_BTC_EUR_FEE_POLICY,
} from '../domain/ema-macd-momentum'

class FakeExecutionProvider implements OrderExecutionProvider {
  previewCall =
    vi.fn<
      (
        order: Parameters<OrderExecutionProvider['preview']>[0],
      ) => Promise<OrderPreview>
    >()
  submitCall =
    vi.fn<
      (
        order: Parameters<OrderExecutionProvider['submit']>[0],
      ) => Promise<OrderReceipt>
    >()
  accountCall = vi.fn<() => Promise<PaperTradingAccount>>()

  preview = this.previewCall
  submit = this.submitCall
  account = this.accountCall
}

const instruments: readonly Instrument[] = [BTC_EUR, TTWO]

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 24; index += 1) await Promise.resolve()
}

function seededReceipt(): OrderReceipt {
  return {
    id: 'R1',
    instrumentId: 'BTC-EUR',
    side: BUY,
    quantity: moneyFromString('0.2'),
    executedPrice: moneyFromString('60000'),
    commission: moneyFromString('0'),
    total: moneyFromString('12000'),
    status: 'executed',
    executedAt: 1_700_000_000_000,
    idempotencyKey: 'kuuid-1',
  }
}

function seededPreview(): OrderPreview {
  return {
    reference: 'P1',
    instrumentId: 'BTC-EUR',
    side: BUY,
    quantity: moneyFromString('0.2'),
    marketPrice: moneyFromString('60000'),
    slippageApplied: moneyFromString('0'),
    slippedPrice: moneyFromString('60000'),
    commission: moneyFromString('0'),
    subtotal: moneyFromString('12000'),
    estimatedTotal: moneyFromString('12000'),
    currency: 'EUR',
  }
}

async function startEnabledStrategy(market: FakeMarketDataProvider) {
  localStorage.removeItem('balancita:simulator')
  localStorage.removeItem('balancita:portfolio')
  const portfolioRepository = new LocalStoragePortfolioRepository()
  const start = Date.parse('2024-01-01T00:00:00.000Z')
  const strategySeed = Array.from({ length: 100 }, (_, index) => {
    const close = 100 + index * index
    return {
      time: new Date(start + index * 900_000).toISOString(),
      open: close,
      high: close,
      low: close,
      close,
      volume: 10,
      isClosed: true,
    }
  })
  const options = {
    portfolioRepository,
    strategySeed,
    simulatorOptions: { feePolicy: SIMULATED_BTC_EUR_FEE_POLICY },
  }
  const preview = vi.spyOn(LocalPaperTradingProvider.prototype, 'preview')
  const submit = vi.spyOn(LocalPaperTradingProvider.prototype, 'submit')
  const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const hook = renderHook(() => useTrading(market, options))
  await waitFor(() => expect(hook.result.current.instruments).toHaveLength(2))
  await act(async () => {
    market.emit(
      makeQuote({
        status: 'live',
        price: 10_100,
        tradeQuantity: 100,
        eventTime: new Date(start + 100 * 900_000 + 5 * 60_000).toISOString(),
      }),
    )
    await flushMicrotasks()
  })
  await waitFor(() => expect(hook.result.current.strategyReady).toBe(true))
  act(() => hook.result.current.setAutoTrading(true))
  return { ...hook, start, preview, submit, log }
}

async function emitBoundary(
  market: FakeMarketDataProvider,
  start: number,
  bucket: number,
  price: number,
  tradeQuantity?: number,
): Promise<void> {
  await act(async () => {
    market.emit(
      makeQuote({
        status: 'live',
        price,
        ...(tradeQuantity === undefined ? {} : { tradeQuantity }),
        eventTime: new Date(start + bucket * 900_000).toISOString(),
      }),
    )
    await flushMicrotasks()
  })
}

describe('useTrading', () => {
  let market: FakeMarketDataProvider
  let provider: FakeExecutionProvider
  let keySequence: string[]

  beforeEach(() => {
    market = new FakeMarketDataProvider(instruments)
    provider = new FakeExecutionProvider()
    provider.accountCall.mockResolvedValue({
      cash: { EUR: moneyFromString('10000') },
      history: [],
    })
    keySequence = ['k-1', 'k-2', 'k-3']
  })

  it('keeps automation off by default and refuses opt-in with a custom execution provider', async () => {
    const { result } = renderHook(() => useTrading(market, { provider }))
    await waitFor(() => expect(result.current.instruments).toHaveLength(2))
    expect(result.current.autoTradingEnabled).toBe(false)
    act(() => result.current.setAutoTrading(true))
    expect(result.current.autoTradingEnabled).toBe(false)
    expect(provider.previewCall).not.toHaveBeenCalled()
    expect(provider.submitCall).not.toHaveBeenCalled()
  })

  it('skips the first partially observed bucket, then executes a later full bucket once', async () => {
    localStorage.removeItem('balancita:simulator')
    localStorage.removeItem('balancita:portfolio')
    const portfolioRepository = new LocalStoragePortfolioRepository()
    const start = Date.parse('2024-01-01T00:00:00.000Z')
    const strategySeed = Array.from({ length: 100 }, (_, index) => {
      const close = 100 + index * index
      return {
        time: new Date(start + index * 900_000).toISOString(),
        open: close,
        high: close,
        low: close,
        close,
        volume: 10,
        isClosed: true,
      }
    })
    const signalCandle = {
      time: new Date(start + 100 * 900_000).toISOString(),
      open: 10_100,
      high: 10_100,
      low: 10_100,
      close: 10_100,
      volume: 100,
      isClosed: true,
    }
    const signalMetrics = calculateMomentumIndicators([
      ...strategySeed,
      signalCandle,
    ])
    expect(
      evaluateMomentumSignal(
        [...strategySeed, signalCandle],
        {
          ...signalMetrics,
          previous: calculateMomentumIndicators(strategySeed),
        },
        'flat',
      ),
    ).toBe('buy')
    const options = {
      portfolioRepository,
      strategySeed,
      simulatorOptions: { feePolicy: SIMULATED_BTC_EUR_FEE_POLICY },
    }
    const preview = vi.spyOn(LocalPaperTradingProvider.prototype, 'preview')
    const submit = vi.spyOn(LocalPaperTradingProvider.prototype, 'submit')
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const { result } = renderHook(() => useTrading(market, options))
    await waitFor(() => expect(result.current.instruments).toHaveLength(2))

    await act(async () => {
      market.emit(
        makeQuote({
          status: 'live',
          price: 10_100,
          tradeQuantity: 100,
          eventTime: new Date(start + 100 * 900_000 + 5 * 60_000).toISOString(),
        }),
      )
      await flushMicrotasks()
    })
    await waitFor(() => expect(result.current.strategyReady).toBe(true))
    act(() => result.current.setAutoTrading(true))
    expect(result.current.autoTradingEnabled).toBe(true)

    await act(async () => {
      market.emit(
        makeQuote({
          status: 'live',
          price: 10_101,
          tradeQuantity: 100,
          eventTime: new Date(start + 101 * 900_000).toISOString(),
        }),
      )
      await flushMicrotasks()
    })
    expect(preview).not.toHaveBeenCalled()
    expect(submit).not.toHaveBeenCalled()

    act(() =>
      market.emit(
        makeQuote({
          status: 'live',
          price: 10_102,
          eventTime: new Date(start + 102 * 900_000).toISOString(),
        }),
      ),
    )
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(preview).toHaveBeenCalledTimes(1)
    expect(preview.mock.instances[0]).toBe(submit.mock.instances[0])
    expect(submit.mock.calls[0]?.[0].idempotencyKey).toContain(
      'ema-macd-momentum.v1',
    )
    expect(log).toHaveBeenCalledTimes(1)
    expect(
      result.current.account?.history[0]?.commission.units,
    ).toBeGreaterThan(0n)

    act(() =>
      market.emit(
        makeQuote({
          status: 'live',
          price: 10_103,
          eventTime: new Date(start + 103 * 900_000).toISOString(),
        }),
      ),
    )
    expect(submit).toHaveBeenCalledTimes(1)
    preview.mockRestore()
    submit.mockRestore()
    log.mockRestore()
  })

  it('logs a valid signal before a rejected paper fill with the complete signal context', async () => {
    const harness = await startEnabledStrategy(market)
    harness.submit.mockResolvedValueOnce({
      ...seededReceipt(),
      status: 'rejected',
      reason: 'insufficient-cash',
    })

    await emitBoundary(market, harness.start, 101, 10_101, 100)
    expect(harness.log).not.toHaveBeenCalled()
    await emitBoundary(market, harness.start, 102, 10_102)
    await waitFor(() => expect(harness.submit).toHaveBeenCalledTimes(1))

    expect(harness.log).toHaveBeenCalledTimes(1)
    expect(harness.log).toHaveBeenCalledWith(
      '[paper-momentum]',
      expect.objectContaining({
        side: 'buy',
        candleClose: new Date(harness.start + 102 * 900_000).toISOString(),
        price: 10_101,
        ema8: expect.any(Number),
        ema21: expect.any(Number),
        macd: expect.any(Number),
        macdSignal: expect.any(Number),
        histogram: expect.any(Number),
        volume: 100,
        reason: expect.any(String),
      }),
    )
    expect(harness.log.mock.invocationCallOrder[0]).toBeLessThan(
      harness.submit.mock.invocationCallOrder[0]!,
    )
    harness.preview.mockRestore()
    harness.submit.mockRestore()
    harness.log.mockRestore()
  })

  it('does not submit a deferred preview after auto mode is turned off', async () => {
    const harness = await startEnabledStrategy(market)
    let resolvePreview!: (preview: OrderPreview) => void
    const deferredPreview = new Promise<OrderPreview>((resolve) => {
      resolvePreview = resolve
    })
    harness.preview.mockReturnValueOnce(deferredPreview)

    await emitBoundary(market, harness.start, 101, 10_101, 100)
    await emitBoundary(market, harness.start, 102, 10_102)
    await waitFor(() => expect(harness.preview).toHaveBeenCalledTimes(1))
    act(() => harness.result.current.setAutoTrading(false))
    resolvePreview(seededPreview())
    await act(async () => flushMicrotasks())

    expect(harness.submit).not.toHaveBeenCalled()
    harness.preview.mockRestore()
    harness.submit.mockRestore()
    harness.log.mockRestore()
  })

  it('loads instruments, subscribes to quotes and defaults the selection', async () => {
    const { result } = renderHook(() =>
      useTrading(market, {
        provider,
        makeIdempotencyKey: () => keySequence.shift() ?? 'k-fallback',
      }),
    )

    await waitFor(() => expect(result.current.instruments).toHaveLength(2))
    expect(result.current.instruments.map((i) => i.id)).toEqual([
      'BTC-EUR',
      'TTWO',
    ])
    expect(result.current.selectedInstrumentId).toBe('BTC-EUR')
    expect(market.subscribeCalls).toHaveLength(1)
  })

  it('feeds live quotes into the account context', async () => {
    const { result } = renderHook(() =>
      useTrading(market, {
        provider,
        makeIdempotencyKey: () => 'k',
      }),
    )
    await waitFor(() => expect(result.current.instruments).toHaveLength(2))

    act(() => {
      market.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 }))
    })
    expect(result.current.priceOf('BTC-EUR')).toBe(60_000)
    act(() => {
      market.emit(makeQuote({ instrumentId: 'TTWO', price: 140 }))
    })
    expect(result.current.priceOf('TTWO')).toBe(140)
  })

  it('requests a preview for the selected instrument and side', async () => {
    provider.previewCall.mockResolvedValue(seededPreview())
    const { result } = renderHook(() =>
      useTrading(market, {
        provider,
        makeIdempotencyKey: () => keySequence.shift() ?? 'k-fallback',
      }),
    )
    await waitFor(() => expect(result.current.instruments).toHaveLength(2))

    act(() => {
      market.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 }))
    })

    await act(async () => {
      await result.current.requestPreview(moneyFromString('0.2'))
    })

    expect(provider.previewCall).toHaveBeenCalledWith(
      expect.objectContaining({
        instrumentId: 'BTC-EUR',
        side: BUY,
        quantity: moneyFromString('0.2'),
      }),
    )
    expect(result.current.preview).toEqual(seededPreview())
  })

  it('surfaces preview failures without dropping the selection', async () => {
    provider.previewCall.mockRejectedValue(new Error('price unavailable'))
    const { result } = renderHook(() =>
      useTrading(market, {
        provider,
        makeIdempotencyKey: () => 'k',
      }),
    )
    await waitFor(() => expect(result.current.instruments).toHaveLength(2))

    await act(async () => {
      await result.current.requestPreview(moneyFromString('0.2'))
    })

    expect(result.current.preview).toBeNull()
    expect(result.current.previewError).toBe('price unavailable')
  })

  it('confirms a preview and refreshes the account', async () => {
    provider.previewCall.mockResolvedValue(seededPreview())
    provider.submitCall.mockResolvedValue(seededReceipt())
    const { result } = renderHook(() =>
      useTrading(market, {
        provider,
        makeIdempotencyKey: () => 'k',
      }),
    )
    await waitFor(() => expect(result.current.instruments).toHaveLength(2))

    await act(async () => {
      await result.current.requestPreview(moneyFromString('0.2'))
    })
    await act(async () => {
      await result.current.confirmOrder()
    })

    expect(provider.submitCall).toHaveBeenCalledWith({
      previewReference: 'P1',
      idempotencyKey: 'k',
    })
    expect(result.current.receipt?.status).toBe('executed')
    expect(result.current.submitError).toBeNull()
    expect(result.current.account?.cash['EUR']).toEqual(
      moneyFromString('10000'),
    )
  })

  it('keeps the submit state idle when confirmation fails', async () => {
    provider.previewCall.mockResolvedValue(seededPreview())
    provider.submitCall.mockRejectedValue(new Error('market moved'))
    const { result } = renderHook(() =>
      useTrading(market, {
        provider,
        makeIdempotencyKey: () => 'k',
      }),
    )
    await waitFor(() => expect(result.current.instruments).toHaveLength(2))
    await act(async () => {
      await result.current.requestPreview(moneyFromString('0.2'))
    })

    await act(async () => {
      await result.current.confirmOrder()
    })

    expect(result.current.receipt).toBeNull()
    expect(result.current.submitError).toBe('market moved')
  })

  it('selects instruments and sides freely', async () => {
    const { result } = renderHook(() =>
      useTrading(market, {
        provider,
        makeIdempotencyKey: () => 'k',
      }),
    )
    await waitFor(() => expect(result.current.instruments).toHaveLength(2))

    act(() => result.current.selectInstrument('TTWO'))
    act(() => result.current.setSide(SELL))
    expect(result.current.selectedInstrumentId).toBe('TTWO')
    expect(result.current.side).toBe(SELL)
    const instrument = result.current.selectedInstrument
    expect(instrument?.id).toBe('TTWO')
  })

  it('resets the last trade result on demand', async () => {
    provider.previewCall.mockResolvedValue(seededPreview())
    provider.submitCall.mockResolvedValue(seededReceipt())
    const { result } = renderHook(() =>
      useTrading(market, {
        provider,
        makeIdempotencyKey: () => 'k',
      }),
    )
    await waitFor(() => expect(result.current.instruments).toHaveLength(2))
    await act(async () => {
      await result.current.requestPreview(moneyFromString('0.2'))
    })
    await act(async () => {
      await result.current.confirmOrder()
    })
    expect(result.current.receipt).not.toBeNull()

    act(() => result.current.resetTrade())
    expect(result.current.receipt).toBeNull()
    expect(result.current.preview).toBeNull()
    expect(result.current.submitError).toBeNull()
  })
})
