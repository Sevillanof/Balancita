// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalNews } from './useTerminalNews.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const item = {
  id: 'one',
  source: 'Fixture',
  url: 'https://example.invalid/news',
  title: 'Ethereum fixture',
  received_at_ms: 1000,
  published_at_ms: 900,
  relevance: 'high',
  direction: 'bearish',
  analysis_status: 'done',
}

describe('useTerminalNews', () => {
  it('retains the last news but explicitly marks it unconfirmed when the next read fails', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', items: [item] }),
    })
    vi.stubGlobal('fetch', fetcher)
    const { result } = renderHook(() => useTerminalNews())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.items).toHaveLength(1)
    expect(result.current.source.state).toBe('ok')
    fetcher.mockRejectedValue(new Error('Connection lost'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(result.current.items).toHaveLength(1)
    expect(result.current.source.state).toBe('error')
  })

  it('does not turn malformed successful data into a healthy empty news list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          status: 'ok',
          items: [{ ...item, analysis_status: 'unexpected' }],
        }),
      }),
    )
    const { result } = renderHook(() => useTerminalNews())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.source.state).toBe('error')
  })
})
