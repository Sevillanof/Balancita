import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Holding } from '../../domain/portfolio'
import { PortfolioCorruptError } from '../../domain/portfolio'
import { LocalStoragePortfolioRepository } from '../../portfolio/local-storage-portfolio-repository'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeQuote,
} from '../../test/fake-market-data-provider'
import { usePortfolio } from './usePortfolio'

const BTC: Holding = {
  instrumentId: 'BTC-EUR',
  quantity: 0.5,
  averageCost: 50_000,
}

const TTWO: Holding = {
  instrumentId: 'TTWO',
  quantity: 10,
  averageCost: 140,
}

function makeProvider() {
  return new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
}

beforeEach(() => {
  localStorage.clear()
})

describe('usePortfolio', () => {
  it('starts loading and reaches ready with holdings and instruments', async () => {
    const provider = makeProvider()
    const repo = new LocalStoragePortfolioRepository()
    await repo.add(BTC)
    await repo.add(TTWO)

    const { result } = renderHook(() => usePortfolio(provider, repo))

    expect(result.current.status).toBe('loading')

    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.holdings).toEqual([BTC, TTWO])
    expect(result.current.instruments.get('BTC-EUR')?.symbol).toBe('BTC-EUR')
    expect(result.current.instruments.size).toBe(3)
    expect(provider.subscribeCalls).toEqual([['BTC-EUR', 'TTWO']])
  })

  it('reaches empty when the repository has no holdings and does not subscribe', async () => {
    const provider = makeProvider()
    const repo = new LocalStoragePortfolioRepository()

    const { result } = renderHook(() => usePortfolio(provider, repo))

    await waitFor(() => expect(result.current.status).toBe('empty'))
    expect(result.current.holdings).toEqual([])
    expect(provider.subscribeCalls).toHaveLength(0)
  })

  it('reaches error with corrupt flag when stored data is unreadable', async () => {
    const provider = makeProvider()
    const repo = new LocalStoragePortfolioRepository()
    localStorage.setItem('balancita:portfolio', '{not json')

    const { result } = renderHook(() => usePortfolio(provider, repo))

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.loadError).toBe('corrupt')
  })

  it('reaches error with general flag when reading fails and recovers on retry', async () => {
    const provider = makeProvider()
    const repo = new LocalStoragePortfolioRepository()
    vi.spyOn(repo, 'list').mockRejectedValueOnce(new Error('disk down'))

    const { result } = renderHook(() => usePortfolio(provider, repo))

    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.loadError).toBe('general')

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe('empty'))
  })

  it('applies an incoming quote only to a held instrument', async () => {
    const provider = makeProvider()
    const repo = new LocalStoragePortfolioRepository()
    await repo.add(BTC)

    const { result } = renderHook(() => usePortfolio(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() =>
      provider.emit(
        makeQuote({ instrumentId: 'BTC-EUR', price: 54_250, change: 250 }),
      ),
    )
    act(() =>
      provider.emit(
        makeQuote({ instrumentId: 'TTWO', price: 151.25, change: 0.5 }),
      ),
    )

    expect(result.current.quotes.get('BTC-EUR')?.price).toBe(54_250)
    expect(result.current.quotes.get('TTWO')).toBeUndefined()
  })

  it('adds a holding through the repository and resubscribes to it', async () => {
    const provider = makeProvider()
    const repo = new LocalStoragePortfolioRepository()

    const { result } = renderHook(() => usePortfolio(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('empty'))

    let added = false
    await act(async () => {
      added = await result.current.add(BTC)
    })

    expect(added).toBe(true)
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.holdings).toEqual([BTC])
    expect(provider.subscribeCalls).toEqual([['BTC-EUR']])

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 50_000 })),
    )
    expect(result.current.quotes.get('BTC-EUR')?.price).toBe(50_000)
  })

  it('edits a holding by re-adding it with the same instrument', async () => {
    const provider = makeProvider()
    const repo = new LocalStoragePortfolioRepository()
    await repo.add(BTC)

    const { result } = renderHook(() => usePortfolio(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    const edited: Holding = { ...BTC, quantity: 1, averageCost: 55_000 }
    let ok = false
    await act(async () => {
      ok = await result.current.add(edited)
    })
    expect(ok).toBe(true)
    await waitFor(() => expect(result.current.holdings).toEqual([edited]))
  })

  it('removes a holding and resubscribes without it', async () => {
    const provider = makeProvider()
    const repo = new LocalStoragePortfolioRepository()
    await repo.add(BTC)
    await repo.add(TTWO)

    const { result } = renderHook(() => usePortfolio(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(provider.unsubscribeCalls).toBe(0)

    let removed = false
    await act(async () => {
      removed = await result.current.remove('BTC-EUR')
    })

    expect(removed).toBe(true)
    await waitFor(() => expect(result.current.holdings).toEqual([TTWO]))
    expect(provider.subscribeCalls).toEqual([['BTC-EUR', 'TTWO'], ['TTWO']])
    expect(provider.unsubscribeCalls).toBe(1)
  })

  it('returns false and surfaces an operation error when a write fails', async () => {
    const provider = makeProvider()
    const repo = new LocalStoragePortfolioRepository()
    vi.spyOn(repo, 'add').mockRejectedValueOnce(
      new PortfolioCorruptError('write failed'),
    )

    const { result } = renderHook(() => usePortfolio(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('empty'))

    let ok = true
    await act(async () => {
      ok = await result.current.add(BTC)
    })
    expect(ok).toBe(false)
    expect(result.current.operationError).toMatch(/write failed/i)
  })

  it('resets corrupted storage and returns to a usable empty state', async () => {
    const provider = makeProvider()
    const repo = new LocalStoragePortfolioRepository()
    localStorage.setItem('balancita:portfolio', '{not json')

    const { result } = renderHook(() => usePortfolio(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.loadError).toBe('corrupt')

    await act(async () => {
      await result.current.reset()
    })

    await waitFor(() => expect(result.current.status).toBe('empty'))
    expect(result.current.loadError).toBeNull()
    const listed = await new LocalStoragePortfolioRepository().list()
    expect(listed).toEqual([])
  })

  it('releases the subscription exactly once on unmount', async () => {
    const provider = makeProvider()
    const repo = new LocalStoragePortfolioRepository()
    await repo.add(BTC)

    const { result, unmount } = renderHook(() => usePortfolio(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(provider.listenerCount).toBe(1)

    unmount()

    expect(provider.unsubscribeCalls).toBe(1)
    expect(provider.listenerCount).toBe(0)
  })
})
