import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useStrategyAnalytics } from './useStrategyAnalytics.ts'

const summary: unknown[] = []
const positions: unknown[] = []
const status = {
  stream_state: 'connected',
  last_processed_event_time: '2026-09-26T12:00:00.000Z',
}

function response(payload: unknown, ok = true) {
  return { ok, json: async () => payload } as Response
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useStrategyAnalytics heartbeat', () => {
  it('records successful receipt time and upstream state separately, retaining metadata on failure and refreshing on recovery', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-26T12:00:00.000Z'))
    let fail = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/status')) {
          if (fail) throw new Error('offline')
          return response(status)
        }
        if (String(input).includes('strategies-summary'))
          return response(summary)
        if (String(input).includes('/positions?')) return response(positions)
        return response({ runs: [] })
      }),
    )
    const { result, unmount } = renderHook(() => useStrategyAnalytics('open'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.lastSuccessfulPollAt).toBe('2026-09-26T12:00:00.000Z')
    expect(result.current.streamState).toBe('connected')
    expect(result.current.lastProcessedEventTime).toBe(
      '2026-09-26T12:00:00.000Z',
    )

    fail = true
    vi.setSystemTime(new Date('2026-09-26T12:00:05.000Z'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(result.current.error).toBe('offline')
    expect(result.current.lastSuccessfulPollAt).toBe('2026-09-26T12:00:00.000Z')

    fail = false
    vi.setSystemTime(new Date('2026-09-26T12:00:10.000Z'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(result.current.error).toBeNull()
    expect(result.current.lastSuccessfulPollAt).toBe('2026-09-26T12:00:15.000Z')
    unmount()
  })

  it('does not accept invalid timestamps and ignores stale responses after a tab switch', async () => {
    let resolveOld!: (value: Response) => void
    let statusRequest = 0
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/paper-trading/status')) {
        statusRequest += 1
        return Promise.resolve(
          response({
            stream_state:
              statusRequest === 1 ? 'old-tab-state' : 'new-tab-state',
            last_processed_event_time: null,
          }),
        )
      }
      if (url.includes('strategies-summary'))
        return Promise.resolve(response(summary))
      if (url.includes('status=open'))
        return new Promise<Response>((resolve) => {
          resolveOld = resolve
        })
      if (url.includes('status=closed'))
        return Promise.resolve(response([{ id: 2 }]))
      return Promise.resolve(response({ runs: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result, rerender, unmount } = renderHook(
      ({ tab }: { tab: 'open' | 'closed' }) => useStrategyAnalytics(tab),
      { initialProps: { tab: 'open' as 'open' | 'closed' } },
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    rerender({ tab: 'closed' })
    expect(result.current.loading).toBe(true)
    expect(result.current.positions).toEqual([])
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.positions).toEqual([{ id: 2 }])
    expect(result.current.streamState).toBe('new-tab-state')
    await act(async () => {
      resolveOld(response([{ id: 1 }]))
    })
    expect(result.current.positions).toEqual([{ id: 2 }])
    expect(result.current.lastProcessedEventTime).toBeNull()
    unmount()
  })

  it('rejects invalid processed-candle timestamps without claiming a successful poll', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes('/status'))
          return response({
            stream_state: 'connected',
            last_processed_event_time: 'not-a-date',
          })
        if (url.includes('strategies-summary')) return response(summary)
        if (url.includes('/positions?')) return response(positions)
        return response({ runs: [] })
      }),
    )
    const { result, unmount } = renderHook(() => useStrategyAnalytics('open'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.error).toBe('La respuesta de auditoría no es válida.')
    expect(result.current.lastSuccessfulPollAt).toBeNull()
    expect(result.current.lastProcessedEventTime).toBeNull()
    unmount()
  })

  it('aborts in-flight requests when unmounted', async () => {
    let observedSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        observedSignal = init?.signal as AbortSignal
        return new Promise<Response>(() => undefined)
      }),
    )
    const { unmount } = renderHook(() => useStrategyAnalytics('open'))
    unmount()
    expect(observedSignal?.aborted).toBe(true)
  })

  it('does not overlap slow polls', async () => {
    vi.useFakeTimers()
    let resolveSummary!: (value: Response) => void
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('strategies-summary'))
        return new Promise<Response>((resolve) => {
          resolveSummary = resolve
        })
      if (String(input).includes('/positions?'))
        return Promise.resolve(response(positions))
      if (String(input).includes('/status'))
        return Promise.resolve(response(status))
      return Promise.resolve(response({ runs: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = renderHook(() => useStrategyAnalytics('open'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    resolveSummary(response(summary))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    unmount()
  })

  it('aborts sibling requests on partial failure and holds the batch lock until ignored aborts settle', async () => {
    vi.useFakeTimers()
    let resolvePositions!: (value: Response) => void
    const signals: AbortSignal[] = []
    let failingPoll = true
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const signal = init?.signal as AbortSignal
      if (url.includes('/api/paper-trading/')) signals.push(signal)
      if (url.includes('strategies-summary') && failingPoll)
        return Promise.resolve(response({}, false))
      if (url.includes('positions?') && failingPoll)
        return new Promise<Response>((resolve) => {
          resolvePositions = resolve
        })
      if (url.includes('strategies-summary'))
        return Promise.resolve(response(summary))
      if (url.includes('/positions?'))
        return Promise.resolve(response(positions))
      if (url.endsWith('/api/paper-trading/status'))
        return Promise.resolve(response(status))
      return Promise.resolve(response({ runs: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { result, unmount } = renderHook(() => useStrategyAnalytics('open'))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.error).toBe(
      'No se pudo cargar la auditoría de estrategias.',
    )
    expect(signals.length).toBe(3)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    const callsWhileSiblingPending = fetchMock.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(callsWhileSiblingPending)

    failingPoll = false
    resolvePositions(response(positions))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(callsWhileSiblingPending + 3)
    unmount()
  })
})
