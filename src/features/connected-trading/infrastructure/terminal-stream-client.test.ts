import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadTerminalBootstrap,
  parseTerminalEnvelope,
  terminalApiBase,
  terminalWebSocketUrl,
} from './terminal-stream-client.ts'

describe('terminal API base selection', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('maps each source to its proxy prefix', () => {
    expect(terminalApiBase('mock')).toBe('/api-mock')
    expect(terminalApiBase('live')).toBe('/api-live')
  })

  it('builds the websocket URL from the selected base and defaults to /api', () => {
    expect(terminalWebSocketUrl('/api-live')).toBe(
      `ws://${location.host}/api-live/terminal/stream`,
    )
    expect(terminalWebSocketUrl()).toBe(
      `ws://${location.host}/api/terminal/stream`,
    )
  })

  it('loads the bootstrap from the selected base', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        schema_version: 1,
        mode: 'mock',
        source: null,
        active_run_id: 'r',
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    await loadTerminalBootstrap('/api-mock')
    expect(fetchMock).toHaveBeenCalledWith(
      '/api-mock/terminal/bootstrap',
      expect.anything(),
    )
  })

  it('aborts a hung bootstrap after the timeout instead of waiting forever', async () => {
    vi.useFakeTimers()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_url: string, init: RequestInit) =>
            new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              )
            }),
        ),
      )
      const outcome = loadTerminalBootstrap('/api-mock').then(
        () => 'resolved',
        (error: unknown) => (error as Error).name,
      )
      await vi.advanceTimersByTimeAsync(8_001)
      await expect(outcome).resolves.toBe('AbortError')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('parseTerminalEnvelope', () => {
  it('rejects malformed and financially incomplete envelopes', () => {
    expect(parseTerminalEnvelope({ type: 'snapshot' })).toBeNull()
    expect(
      parseTerminalEnvelope({
        schema_version: 1,
        event_id: 'event-1',
        stream_id: 'stream-1',
        run_id: 'run-1',
        seq: 1,
        type: 'snapshot',
        instrument_id: 'kraken-futures:PF_XBTUSD',
        event_time: 1,
        published_at: 1,
        data: { state: [] },
      }),
    ).toBeNull()
  })

  it('accepts the actual versioned snapshot envelope shape', () => {
    const envelope = {
      schema_version: 1,
      event_id: 'event-1',
      stream_id: 'stream-1',
      run_id: 'run-1',
      seq: 0,
      type: 'snapshot',
      instrument_id: 'kraken-futures:PF_XBTUSD',
      event_time: 1,
      published_at: 1,
      data: { watermark: 0, state: { account: {} } },
    }
    expect(parseTerminalEnvelope(envelope)).toEqual(envelope)
  })

  it('validates the versioned closed-candle fixture included with a snapshot', () => {
    const envelope = {
      schema_version: 1,
      event_id: 'event-candles',
      stream_id: 'stream-1',
      run_id: 'run-1',
      seq: 0,
      type: 'snapshot',
      instrument_id: 'kraken-futures:PF_XBTUSD',
      event_time: 1,
      published_at: 1,
      data: {
        watermark: 0,
        state: { account: {} },
        market: {
          schema_version: 'mock-terminal-market.v1',
          as_of_ms: 120_000,
          interval_ms: 60_000,
          candles: [
            {
              time_ms: 60_000,
              open: '100000',
              high: '100050',
              low: '99950',
              close: '100000',
              volume_btc: '1',
              closed: true,
            },
          ],
        },
      },
    }
    expect(parseTerminalEnvelope(envelope)).toEqual(envelope)
    const malformed = structuredClone(envelope)
    malformed.data.market.candles[0].close = 'NaN'
    expect(parseTerminalEnvelope(malformed)).toBeNull()
  })

  it('accepts recorded REPLAY candles without relabeling them as MOCK fixtures', () => {
    const envelope = {
      schema_version: 1,
      event_id: 'event-replay',
      stream_id: 'stream-1',
      run_id: 'run-1',
      seq: 0,
      type: 'snapshot',
      instrument_id: 'kraken-futures:PF_XBTUSD',
      event_time: 1,
      published_at: 1,
      data: {
        watermark: 0,
        state: { account: {} },
        market: {
          schema_version: 'futures-terminal-market.v1',
          as_of_ms: 120_000,
          interval_ms: 60_000,
          candles: [
            {
              time_ms: 60_000,
              open: '100000',
              high: '100050',
              low: '99950',
              close: '100000',
              volume_btc: '1',
              closed: true,
            },
          ],
        },
      },
    }
    expect(parseTerminalEnvelope(envelope)).toEqual(envelope)
  })

  it('accepts a public forming candle before its interval closes', () => {
    const envelope = {
      schema_version: 1,
      event_id: 'event-forming-candle',
      stream_id: 'stream-1',
      run_id: 'run-1',
      seq: 1,
      type: 'market.updated',
      instrument_id: 'kraken-futures:PF_XBTUSD',
      event_time: 90_000,
      published_at: 90_000,
      data: {
        market_status: 'live',
        last_received_at: 90_000,
        candle: {
          interval_ms: 60_000,
          bucket_start_ms: 60_000,
          known_at_ms: 90_000,
          open: '100000',
          high: '100050',
          low: '99950',
          close: '100025',
          volume_btc: '0.2',
          closed: false,
        },
      },
    }
    expect(parseTerminalEnvelope(envelope)).toEqual(envelope)
    const malformed = structuredClone(envelope)
    malformed.data.candle.volume_btc = '-1'
    expect(parseTerminalEnvelope(malformed)).toBeNull()
  })
})

describe('productQuery', () => {
  it('is empty for the default product and encodes others', async () => {
    const { productQuery } = await import('./terminal-stream-client.ts')
    expect(productQuery()).toBe('')
    expect(productQuery('PF_ETHUSD')).toBe('?product=PF_ETHUSD')
    expect(productQuery('PF_ETHUSD', false)).toBe('&product=PF_ETHUSD')
  })
})
