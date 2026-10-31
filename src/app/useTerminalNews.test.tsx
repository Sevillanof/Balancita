// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeNewsBriefing, useTerminalNews } from './useTerminalNews.ts'

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

const briefing = {
  status: 'ok',
  product: 'PF_ETHUSD',
  text: 'Síntesis de prueba del modelo local basada exclusivamente en noticias.',
  known_at_ms: 1200,
  checked_at_ms: 1300,
  expires_at_ms: 2000,
  source_count: 1,
  sources: [
    {
      id: 'one',
      source: 'Fixture',
      url: item.url,
      published_at_ms: 900,
      received_at_ms: 1000,
      license_status: 'unknown',
    },
  ],
  reason: null,
}

describe('news briefing decoding', () => {
  it('preserves real text, timestamps and unknown source permissions', () => {
    const decoded = decodeNewsBriefing({ briefing })
    expect(decoded?.text).toBe(briefing.text)
    expect(decoded?.knownAtMs).toBe(1200)
    expect(decoded?.expiresAtMs).toBe(2000)
    expect(decoded?.sources[0]?.licenseStatus).toBe('unknown')
  })

  it('does not manufacture a Qwen summary for a legacy response', () => {
    expect(decodeNewsBriefing({ status: 'ok', items: [item] })).toBeNull()
  })

  it('rejects an unsupported status or an ok summary without provenance', () => {
    expect(() =>
      decodeNewsBriefing({
        briefing: { ...briefing, status: 'unexpected' },
      }),
    ).toThrow(/briefing/i)
    expect(() =>
      decodeNewsBriefing({
        briefing: { ...briefing, source_count: 0, sources: [] },
      }),
    ).toThrow(/briefing/i)
  })
})

describe('useTerminalNews', () => {
  it('retains the last news but explicitly marks it unconfirmed when the next read fails', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ok', items: [item], briefing }),
    })
    vi.stubGlobal('fetch', fetcher)
    const { result } = renderHook(() => useTerminalNews())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.items).toHaveLength(1)
    expect(result.current.source.state).toBe('ok')
    expect(result.current.briefing?.text).toBe(briefing.text)
    fetcher.mockRejectedValue(new Error('Connection lost'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(result.current.items).toHaveLength(1)
    expect(result.current.source.state).toBe('error')
    expect(result.current.briefing?.text).toBe(briefing.text)
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
