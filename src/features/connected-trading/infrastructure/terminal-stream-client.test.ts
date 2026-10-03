import { describe, expect, it } from 'vitest'
import { parseTerminalEnvelope } from './terminal-stream-client.ts'

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
})
