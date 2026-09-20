import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeQuote,
} from '../../test/fake-market-data-provider'
import { useLatestQuote } from './useLatestQuote'

describe('useLatestQuote', () => {
  it('subscribes to the selected instrument and exposes its latest quote', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const { result } = renderHook(() => useLatestQuote(provider, 'BTC-EUR'))

    expect(provider.subscribeCalls).toEqual([['BTC-EUR']])
    expect(result.current).toBeUndefined()

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_100 })),
    )

    expect(result.current?.price).toBe(60_100)
  })

  it('keeps the latest quote as more arrive', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const { result } = renderHook(() => useLatestQuote(provider, 'BTC-EUR'))

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 59_900 })),
    )
    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_200 })),
    )

    expect(result.current?.price).toBe(60_200)
  })

  it('ignores quotes for other instruments', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const { result } = renderHook(() => useLatestQuote(provider, 'BTC-EUR'))

    act(() => provider.emit(makeQuote({ instrumentId: 'TTWO', price: 150 })))

    expect(result.current).toBeUndefined()
  })

  it('releases the subscription on unmount', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const { unmount } = renderHook(() => useLatestQuote(provider, 'BTC-EUR'))

    expect(provider.listenerCount).toBe(1)

    unmount()

    expect(provider.unsubscribeCalls).toBe(1)
    expect(provider.listenerCount).toBe(0)
  })

  it('re-subscribes and drops the previous quote when instrument changes', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useLatestQuote(provider, id),
      { initialProps: { id: 'BTC-EUR' } },
    )

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 60_100 })),
    )
    expect(result.current?.price).toBe(60_100)

    rerender({ id: 'TTWO' })

    expect(result.current).toBeUndefined()
    expect(provider.subscribeCalls).toEqual([['BTC-EUR'], ['TTWO']])

    act(() => provider.emit(makeQuote({ instrumentId: 'TTWO', price: 151.25 })))

    expect(result.current?.price).toBe(151.25)
  })

  it('survives a provider that refuses to subscribe', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    provider.subscribe = () => {
      throw new Error('subscription unavailable')
    }

    const { result } = renderHook(() => useLatestQuote(provider, 'BTC-EUR'))

    await waitFor(() => expect(result.current).toBeUndefined())
  })
})
