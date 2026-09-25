import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useOhlcCollectorTelemetry } from './useOhlcCollectorTelemetry.ts'

afterEach(() => vi.restoreAllMocks())

describe('useOhlcCollectorTelemetry', () => {
  it('validates and independently polls collector status, then aborts and cleans up', async () => {
    let tick: (() => void) | undefined
    const clear = vi.spyOn(window, 'clearInterval')
    vi.spyOn(window, 'setInterval').mockImplementation(((
      callback: TimerHandler,
    ) => {
      tick = callback as () => void
      return 1
    }) as typeof window.setInterval)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        running: true,
        total_candles: 12,
        coverage_hours: 0.2,
        gaps_detected: 1,
        newest_candle_iso: '2026-09-25T07:47:00.000Z',
      }),
    } as Response)
    const { result, unmount } = renderHook(() => useOhlcCollectorTelemetry())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(result.current.status?.candleCount).toBe(12)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/market/collector/status',
      expect.any(Object),
    )
    await act(async () => {
      tick?.()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    unmount()
    expect(clear).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls.at(-1)?.[1]?.signal?.aborted).toBe(true)
  })
})
