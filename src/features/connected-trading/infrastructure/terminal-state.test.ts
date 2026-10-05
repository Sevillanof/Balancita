import { describe, expect, it } from 'vitest'
import { applyTerminalEvent } from './terminal-state.ts'

describe('terminal state event projection', () => {
  it('applies the nested durable command result version and tick analyses', () => {
    const first = applyTerminalEvent(
      { state_version: 0 },
      {
        schema_version: 1,
        event_id: 'command-result',
        stream_id: 'stream',
        run_id: 'run',
        seq: 1,
        type: 'command.result',
        instrument_id: 'kraken-futures:PF_XBTUSD',
        event_time: 1,
        published_at: 1,
        data: {
          result: {
            result: { applied_state_version: 1 },
          },
        },
      },
    )
    expect(first.state_version).toBe(1)

    const advanced = applyTerminalEvent(first, {
      schema_version: 1,
      event_id: 'scheduled-analysis',
      stream_id: 'stream',
      run_id: 'run',
      seq: 2,
      type: 'analysis.completed',
      instrument_id: 'kraken-futures:PF_XBTUSD',
      event_time: 1_791_197_302_785,
      published_at: 1_791_197_302_785,
      data: {
        analysis: {
          analysis_id: 'analysis',
          reason_codes: ['position_owned'],
          decision_time_ms: 21_600_000,
        },
      },
    })
    expect(advanced.state_version).toBe(2)
    expect(advanced.analyses).toEqual([
      {
        analysis_id: 'analysis',
        reason_codes: ['position_owned'],
        decision_time_ms: 21_600_000,
      },
    ])
  })

  it('projects incremental forming candle and feed quality without losing history', () => {
    const initial = {
      terminal_market: {
        schema_version: 'futures-terminal-market.v1',
        as_of_ms: 60_000,
        interval_ms: 60_000,
        candles: [
          {
            time_ms: 0,
            open: '100',
            high: '110',
            low: '90',
            close: '105',
            volume_btc: '1',
            closed: true,
          },
        ],
      },
    }
    const updated = applyTerminalEvent(initial, {
      schema_version: 1,
      event_id: 'trade-candle-update',
      stream_id: 'stream',
      run_id: 'run',
      seq: 1,
      type: 'market.updated',
      instrument_id: 'kraken-futures:PF_XBTUSD',
      event_time: 90_000,
      published_at: 90_000,
      data: {
        market_status: 'live',
        last_received_at: 90_000,
        book_quality: { source_guarantee: 'undocumented' },
        candle: {
          bucket_start_ms: 60_000,
          interval_ms: 60_000,
          known_at_ms: 90_000,
          open: '100',
          high: '115',
          low: '90',
          close: '112',
          volume_btc: '1.5',
          closed: false,
        },
      },
    })
    expect(updated.terminal_market).toMatchObject({
      as_of_ms: 90_000,
      candles: [
        {
          time_ms: 0,
          closed: true,
        },
        {
          time_ms: 60_000,
          high: '115',
          close: '112',
          volume_btc: '1.5',
          closed: false,
        },
      ],
    })
    expect(updated.market).toMatchObject({
      market_status: 'live',
      book_quality: { source_guarantee: 'undocumented' },
    })
  })

  it('retains WAIT history and de-duplicates immutable fills by fill ID', () => {
    const fillEvent = (eventId: string, seq: number) => ({
      schema_version: 1 as const,
      event_id: eventId,
      stream_id: 'stream',
      run_id: 'run',
      seq,
      type: 'fill.created',
      instrument_id: 'kraken-futures:PF_XBTUSD',
      event_time: seq,
      published_at: seq,
      data: { fill: { fill_id: 'fill-1', quantity_btc: '0.01' } },
    })
    const first = applyTerminalEvent(null, fillEvent('fill-event-1', 1))
    const waiting = applyTerminalEvent(first, {
      schema_version: 1,
      event_id: 'wait-analysis',
      stream_id: 'stream',
      run_id: 'run',
      seq: 2,
      type: 'analysis.completed',
      instrument_id: 'kraken-futures:PF_XBTUSD',
      event_time: 2,
      published_at: 2,
      data: {
        analysis: {
          analysis_id: 'analysis-wait',
          action: 'WAIT',
          decision_time_ms: 21_600_123,
        },
      },
    })
    const retried = applyTerminalEvent(
      waiting,
      fillEvent('fill-event-republished', 3),
    )
    expect(retried.fills).toEqual([{ fill_id: 'fill-1', quantity_btc: '0.01' }])
    expect(retried.analyses).toEqual([
      {
        analysis_id: 'analysis-wait',
        action: 'WAIT',
        decision_time_ms: 21_600_123,
      },
    ])
  })

  it('upserts order status by immutable order ID without duplicating its history row', () => {
    const orderEvent = (eventId: string, seq: number, status: string) => ({
      schema_version: 1 as const,
      event_id: eventId,
      stream_id: 'stream',
      run_id: 'run',
      seq,
      type: 'order.updated',
      instrument_id: 'kraken-futures:PF_XBTUSD',
      event_time: seq,
      published_at: seq,
      data: { order: { order_id: 'order-1', status } },
    })
    const accepted = applyTerminalEvent(
      null,
      orderEvent('order-accepted', 1, 'accepted'),
    )
    const filled = applyTerminalEvent(
      accepted,
      orderEvent('order-filled', 2, 'filled'),
    )
    expect(filled.orders).toEqual([{ order_id: 'order-1', status: 'filled' }])
  })
})
