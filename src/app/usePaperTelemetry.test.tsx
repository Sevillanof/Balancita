import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { usePaperTelemetry } from './usePaperTelemetry.ts'

const status = {
  stream_state: 'connected',
  account: { balance_eur: 100, total_equity_eur: 120 },
  execution_summary: { gate_rejections: 2, executed_trades: 1 },
}
const orders = {
  orders: [
    {
      id: 1,
      action: 'BUY',
      gatePassed: true,
      executionTimestamp: 120,
      signalTimestamp: 60,
      amountEur: 30,
    },
  ],
}
function response(body: unknown) {
  return { ok: true, json: async () => body }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('usePaperTelemetry', () => {
  it('loads status and audit orders immediately, then polls every five seconds and cleans up', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async (input) =>
          response(
            String(input).includes('/orders') ? orders : status,
          ) as Response,
      )
    const { result, unmount } = renderHook(() => usePaperTelemetry())
    await vi.waitFor(() =>
      expect(result.current.status?.stream_state).toBe('connected'),
    )
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
    unmount()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('retains the last good payload and exposes transient failures', async () => {
    let tick: (() => void) | undefined
    vi.spyOn(window, 'setInterval').mockImplementation(((
      callback: TimerHandler,
    ) => {
      tick = callback as () => void
      return 1
    }) as typeof window.setInterval)
    vi.spyOn(window, 'clearInterval').mockImplementation(() => undefined)
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async (input) =>
          response(
            String(input).includes('/orders') ? orders : status,
          ) as Response,
      )
    const { result } = renderHook(() => usePaperTelemetry())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.orders).toHaveLength(1)
    fetchMock.mockRejectedValue(new Error('offline'))
    await act(async () => {
      tick?.()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.error).toBe('offline')
    expect(result.current.orders).toHaveLength(1)
  })
})
