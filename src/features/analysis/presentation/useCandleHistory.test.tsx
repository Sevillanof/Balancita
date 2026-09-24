import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeCandle,
} from '../../../shared/testing/fake-market-data-provider'
import type { Candle } from '../../market-data/domain/market-data.ts'
import { useCandleHistory } from './useCandleHistory.ts'

const HISTORY = [
  makeCandle({ time: '2024-01-01T00:00:00.000Z' }),
  makeCandle({ time: '2024-01-02T00:00:00.000Z', open: 104, close: 106 }),
]

describe('useCandleHistory', () => {
  it('starts in loading and reaches ready with the candles', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument: { 'BTC-EUR': HISTORY },
    })
    const { result } = renderHook(() => useCandleHistory(provider, 'BTC-EUR'))

    expect(result.current.status).toBe('loading')

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.candles).toEqual(HISTORY)
    expect(provider.getHistoryCalls).toEqual(['BTC-EUR'])
  })

  it('records the successful history receipt time separately from candle time', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument: { 'BTC-EUR': HISTORY },
    })
    const { result } = renderHook(() =>
      useCandleHistory(provider, 'BTC-EUR', { now: () => 1_800_000_000_000 }),
    )

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.historyReceivedAtMs).toBe(1_800_000_000_000)
    expect(result.current.candles.at(-1)?.time).toBe(HISTORY.at(-1)?.time)
  })

  it('retains the last successful REST time when a later retry fails', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument: { 'BTC-EUR': HISTORY },
    })
    const { result } = renderHook(() =>
      useCandleHistory(provider, 'BTC-EUR', { now: () => 1_800_000_000_000 }),
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    provider.getHistoryError = new Error('REST unavailable')

    act(() => result.current.retry())

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.historyReceivedAtMs).toBe(1_800_000_000_000)
  })

  it('reaches empty when the provider returns no candles', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const { result } = renderHook(() => useCandleHistory(provider, 'TTWO'))

    await waitFor(() => expect(result.current.status).toBe('empty'))
    expect(result.current.candles).toEqual([])
  })

  it('reaches error when getHistory rejects and recovers on retry', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument: { 'BTC-EUR': HISTORY },
      getHistoryError: new Error('history down'),
    })
    const { result } = renderHook(() => useCandleHistory(provider, 'BTC-EUR'))

    await waitFor(() => expect(result.current.status).toBe('error'))

    provider.getHistoryError = undefined
    act(() => result.current.retry())

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.candles).toEqual(HISTORY)
  })

  it('ignores a stale response from a previous instrument', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    const resolveByCall: Array<(candles: Candle[]) => void> = []

    const getHistory = vi.fn(
      () =>
        new Promise<Candle[]>((resolve) => {
          resolveByCall.push(resolve)
        }),
    )
    provider.getHistory = getHistory as FakeMarketDataProvider['getHistory']

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useCandleHistory(provider, id),
      { initialProps: { id: 'BTC-EUR' } },
    )

    rerender({ id: 'TTWO' })

    await act(async () => {
      resolveByCall[1]?.(HISTORY)
    })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.candles).toEqual(HISTORY)
    expect(getHistory).toHaveBeenCalledTimes(2)
    expect(getHistory).toHaveBeenNthCalledWith(1, 'BTC-EUR')
    expect(getHistory).toHaveBeenNthCalledWith(2, 'TTWO')

    await act(async () => {
      resolveByCall[0]?.([
        makeCandle({ time: '2020-01-01T00:00:00.000Z', close: 1 }),
      ])
    })

    expect(result.current.candles).toEqual(HISTORY)
  })

  it('loads history again when the instrument changes', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS, {
      historyByInstrument: {
        'BTC-EUR': HISTORY,
        TTWO: [
          makeCandle({ time: '2024-03-01T00:00:00.000Z', open: 50, close: 51 }),
        ],
      },
    })
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useCandleHistory(provider, id),
      { initialProps: { id: 'BTC-EUR' } },
    )

    await waitFor(() => expect(result.current.status).toBe('ready'))

    rerender({ id: 'TTWO' })

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.candles).toHaveLength(1)
    expect(provider.getHistoryCalls).toEqual(['BTC-EUR', 'TTWO'])
  })

  it('does not apply a response to an unmounted hook', async () => {
    const provider = new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
    let resolvePromise: (candles: Candle[]) => void = () => {}
    const getHistory = vi.fn(
      () =>
        new Promise<Candle[]>((resolve) => {
          resolvePromise = resolve
        }),
    )
    provider.getHistory = getHistory as FakeMarketDataProvider['getHistory']

    const { result, unmount } = renderHook(() =>
      useCandleHistory(provider, 'BTC-EUR'),
    )
    unmount()

    await act(async () => resolvePromise(HISTORY))

    expect(result.current.status).toBe('loading')
  })
})
