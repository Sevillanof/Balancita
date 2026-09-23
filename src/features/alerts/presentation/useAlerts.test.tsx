import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Alert } from '../domain/alerts.ts'
import { AlertCorruptError } from '../domain/alerts.ts'
import { LocalStorageAlertRepository } from '../infrastructure/local-storage-alert-repository'
import {
  FakeMarketDataProvider,
  WATCHLIST_INSTRUMENTS,
  makeQuote,
} from '../../../shared/testing/fake-market-data-provider'
import { useAlerts } from './useAlerts.ts'

const BTC_ABOVE: Alert = {
  id: 'a1',
  instrumentId: 'BTC-EUR',
  direction: 'above',
  thresholdPrice: 60_000,
  status: 'active',
  createdAt: '2026-09-20T12:00:00.000Z',
}

const TTWO_BELOW: Alert = {
  id: 'a2',
  instrumentId: 'TTWO',
  direction: 'below',
  thresholdPrice: 140,
  status: 'active',
  createdAt: '2026-09-20T12:00:01.000Z',
}

function makeProvider() {
  return new FakeMarketDataProvider(WATCHLIST_INSTRUMENTS)
}

function harness(alerts: readonly Alert[] = []) {
  const provider = makeProvider()
  const repo = new LocalStorageAlertRepository()
  return {
    provider,
    repo,
    alerts,
    async mount() {
      /* noop */
    },
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('useAlerts', () => {
  it('starts loading and reaches empty without subscribing when there are no alerts', async () => {
    const { provider, repo } = harness()
    const { result } = renderHook(() => useAlerts(provider, repo))

    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('empty'))
    expect(result.current.alerts).toEqual([])
    expect(provider.subscribeCalls).toHaveLength(0)
  })

  it('reaches ready and subscribes only to instruments with armed alerts', async () => {
    const { provider, repo } = harness()
    await repo.add(BTC_ABOVE)
    await repo.add({ ...TTWO_BELOW, status: 'triggered' })

    const { result } = renderHook(() => useAlerts(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.alerts).toHaveLength(2)
    expect(result.current.instruments.get('BTC-EUR')?.symbol).toBe('BTC-EUR')
    expect(provider.subscribeCalls).toEqual([['BTC-EUR']])
  })

  it('does not subscribe to a catalog entry that has no armed alerts', async () => {
    const { provider, repo } = harness()
    await repo.add({ ...BTC_ABOVE, status: 'acknowledged' })
    renderHook(() => useAlerts(provider, repo))

    await waitFor(() => expect(provider.subscribeCalls).toEqual([['BTC-EUR']]))
  })

  it('raises a notification when an alert crosses its threshold', async () => {
    const { provider, repo } = harness()
    await repo.add(BTC_ABOVE)

    const { result } = renderHook(() => useAlerts(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 59_000 })),
    )
    expect(result.current.triggered).toHaveLength(0)

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 61_000 })),
    )

    await waitFor(() => expect(result.current.triggered).toHaveLength(1))
    expect(result.current.triggered[0].alert.id).toBe('a1')
    expect(result.current.triggered[0].instrument.symbol).toBe('BTC-EUR')
  })

  it('does not duplicate the notification while the alert stays triggered', async () => {
    const { provider, repo } = harness()
    await repo.add(BTC_ABOVE)

    const { result } = renderHook(() => useAlerts(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 59_000 })),
    )
    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 61_000 })),
    )
    await waitFor(() => expect(result.current.triggered).toHaveLength(1))

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 62_000 })),
    )
    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 65_000 })),
    )
    await waitFor(() => expect(result.current.triggered).toHaveLength(1))
  })

  it('acknowledging re-arms the alert so only the next real crossing fires', async () => {
    const { provider, repo } = harness()
    await repo.add(BTC_ABOVE)

    const { result } = renderHook(() => useAlerts(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 59_000 })),
    )
    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 61_000 })),
    )
    await waitFor(() => expect(result.current.triggered).toHaveLength(1))

    let acknowledged = false
    await act(async () => {
      acknowledged = await result.current.acknowledge('a1')
    })
    expect(acknowledged).toBe(true)
    await waitFor(() => expect(result.current.triggered).toHaveLength(0))
    expect(
      result.current.alerts.find((alert) => alert.id === 'a1')?.status,
    ).toBe('acknowledged')

    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 59_000 })),
    )
    act(() =>
      provider.emit(makeQuote({ instrumentId: 'BTC-EUR', price: 61_000 })),
    )
    await waitFor(() => expect(result.current.triggered).toHaveLength(1))
  })

  it('creates an alert through the repository and it appears as active', async () => {
    const { provider, repo } = harness()
    const { result } = renderHook(() => useAlerts(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('empty'))

    let created = false
    await act(async () => {
      created = await result.current.create({
        instrumentId: 'TTWO',
        direction: 'below',
        thresholdPrice: 140,
      })
    })
    expect(created).toBe(true)

    await waitFor(() => expect(result.current.status).toBe('ready'))
    const stored = await repo.list()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      instrumentId: 'TTWO',
      direction: 'below',
      thresholdPrice: 140,
      status: 'active',
    })
    expect(stored[0].id.length).toBeGreaterThan(0)
  })

  it('removes an alert and resubscribes without it', async () => {
    const { provider, repo } = harness()
    await repo.add(BTC_ABOVE)

    const { result } = renderHook(() => useAlerts(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(provider.subscribeCalls).toEqual([['BTC-EUR']])

    let removed = false
    await act(async () => {
      removed = await result.current.remove('a1')
    })
    expect(removed).toBe(true)

    await waitFor(() => expect(result.current.status).toBe('empty'))
    expect(await repo.list()).toEqual([])
  })

  it('reaches error with corrupt flag on unreadable storage and resets to empty', async () => {
    const { provider, repo } = harness()
    localStorage.setItem('balancita:alerts', '{not json')

    const { result } = renderHook(() => useAlerts(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.loadError).toBe('corrupt')

    await act(async () => {
      await result.current.reset()
    })
    await waitFor(() => expect(result.current.status).toBe('empty'))
    expect(result.current.loadError).toBeNull()
    expect(await repo.list()).toEqual([])
  })

  it('reaches error with general flag on read failure and recovers on retry', async () => {
    const { provider, repo } = harness()
    vi.spyOn(repo, 'list').mockRejectedValueOnce(new Error('disk down'))

    const { result } = renderHook(() => useAlerts(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.loadError).toBe('general')

    act(() => result.current.retry())
    await waitFor(() => expect(result.current.status).toBe('empty'))
  })

  it('surfaces an operation error when a write fails', async () => {
    const { provider, repo } = harness()
    vi.spyOn(repo, 'add').mockRejectedValueOnce(
      new AlertCorruptError('write failed'),
    )

    const { result } = renderHook(() => useAlerts(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('empty'))

    let created = true
    await act(async () => {
      created = await result.current.create({
        instrumentId: 'TTWO',
        direction: 'below',
        thresholdPrice: 140,
      })
    })
    expect(created).toBe(false)
    expect(result.current.operationError).toMatch(/write failed/i)
  })

  it('releases the subscription exactly once on unmount', async () => {
    const { provider, repo } = harness()
    await repo.add(BTC_ABOVE)

    const { result, unmount } = renderHook(() => useAlerts(provider, repo))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(provider.listenerCount).toBe(1)

    unmount()

    expect(provider.unsubscribeCalls).toBe(1)
    expect(provider.listenerCount).toBe(0)
  })

  it('persists alerts across remounts', async () => {
    const { provider, repo } = harness()

    const first = renderHook(() => useAlerts(provider, repo))
    await waitFor(() => expect(first.result.current.status).toBe('empty'))
    await act(async () => {
      await first.result.current.create({
        instrumentId: 'BTC-EUR',
        direction: 'above',
        thresholdPrice: 60_000,
      })
    })
    await waitFor(() => expect(first.result.current.status).toBe('ready'))
    first.unmount()

    const second = renderHook(() => useAlerts(provider, repo))
    await waitFor(() => expect(second.result.current.status).toBe('ready'))
    expect(second.result.current.alerts).toHaveLength(1)
    expect(second.result.current.alerts[0]).toMatchObject({
      instrumentId: 'BTC-EUR',
      direction: 'above',
      thresholdPrice: 60_000,
      status: 'active',
    })
  })
})
