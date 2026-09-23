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
