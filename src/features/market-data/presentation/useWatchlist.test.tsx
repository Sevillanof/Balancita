import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeQuote,
} from '../../../shared/testing/fake-market-data-provider'
import { useWatchlist } from './useWatchlist.ts'

describe('useWatchlist', () => {
  it('starts in loading and reaches ready with the instruments', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const { result } = renderHook(() => useWatchlist(provider))

    expect(result.current.status).toBe('loading')

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(
      result.current.instruments.map((instrument) => instrument.id),
    ).toEqual(['BTC-EUR', 'TTWO', 'SPCX'])
    expect(provider.subscribeCalls).toEqual([['BTC-EUR', 'TTWO', 'SPCX']])
  })

  it('reaches empty when the provider returns no instruments', async () => {
    const provider = new FakeMarketDataProvider([])
    const { result } = renderHook(() => useWatchlist(provider))

    await waitFor(() => expect(result.current.status).toBe('empty'))
    expect(result.current.connectionStatus).toBe('unavailable')
    expect(result.current.instruments).toEqual([])
    expect(provider.subscribeCalls).toHaveLength(0)
  })

  it('reaches error when getInstruments rejects and recovers on retry', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      getInstrumentsError: new Error('market down'),
    })
    const { result } = renderHook(() => useWatchlist(provider))

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.connectionStatus).toBe('error')
    expect(result.current.instruments).toEqual([])
    expect(provider.subscribeCalls).toHaveLength(0)

    provider.getInstrumentsError = undefined
    act(() => result.current.retry())

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(provider.getInstrumentsCalls).toBe(2)
    expect(provider.subscribeCalls).toHaveLength(1)
  })

  it('reaches error when the subscription throws', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    vi.spyOn(provider, 'subscribe').mockImplementation(() => {
      throw new Error('subscribe failed')
    })

    const { result } = renderHook(() => useWatchlist(provider))

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.instruments).toEqual([])
    expect(result.current.connectionStatus).toBe('error')
  })

  it('applies an incoming quote only to its matching instrument', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const { result } = renderHook(() => useWatchlist(provider))

    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() =>
      provider.emit(
        makeQuote({
          instrumentId: 'TTWO',
          price: 151.25,
          change: 1.25,
          changePercent: 0.83,
        }),
      ),
    )

    expect(result.current.quotes.get('TTWO')?.price).toBe(151.25)
    expect(result.current.quotes.get('TTWO')?.changePercent).toBe(0.83)
    expect(result.current.quotes.get('BTC-EUR')).toBeUndefined()
    expect(result.current.quotes.get('SPCX')).toBeUndefined()
  })

  it('releases the subscription exactly once on unmount', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const { result, unmount } = renderHook(() => useWatchlist(provider))

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(provider.listenerCount).toBe(1)
    expect(result.current.connectionStatus).toBe('mock')

    act(() => unmount())

    expect(provider.unsubscribeCalls).toBe(1)
    expect(provider.listenerCount).toBe(0)
    expect(result.current.connectionStatus).toBe('mock')
  })

  it('does not react to quotes emitted after unmount', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const { result, unmount } = renderHook(() => useWatchlist(provider))

    await waitFor(() => expect(result.current.status).toBe('ready'))
    unmount()

    const callbacksBefore = provider.listenerCount
    expect(() =>
      act(() => provider.emit(makeQuote({ instrumentId: 'TTWO' }))),
    ).not.toThrow()
    expect(provider.listenerCount).toBe(callbacksBefore)
  })

  it('keeps quotes stable between unrelated updates', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const { result } = renderHook(() => useWatchlist(provider))

    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() =>
      provider.emit(
        makeQuote({ instrumentId: 'BTC-EUR', price: 60_100, change: 40 }),
      ),
    )
    act(() =>
      provider.emit(
        makeQuote({ instrumentId: 'TTWO', price: 151.25, change: 1.25 }),
      ),
    )

    expect(result.current.quotes.get('BTC-EUR')?.price).toBe(60_100)
    expect(result.current.quotes.get('TTWO')?.price).toBe(151.25)
  })
})
