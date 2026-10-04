import { describe, expect, it } from 'vitest'
import { projectTerminalQuote } from './terminal-market.ts'

describe('terminal market quote projection', () => {
  it('uses the received public trade rather than a stale candle in PAPER_LIVE', () => {
    expect(
      projectTerminalQuote({
        mode: 'paper_live',
        market: {
          feed: 'trade',
          event_time: 1_800_000_000_000,
          received_at: 1_800_000_000_125,
          normalized: { type: 'trade', priceUsd: '100123.45' },
        },
        terminalMarket: {
          candles: [{ close: '99999', time_ms: 1_799_999_940_000 }],
        },
        position: null,
      }),
    ).toEqual({
      price: '100123.45',
      label: 'Último trade público · USD/BTC',
      eventTime: 1_800_000_000_000,
      receivedAt: 1_800_000_000_125,
    })
  })

  it('does not substitute candle or zero when a live quote is absent', () => {
    expect(
      projectTerminalQuote({
        mode: 'paper_live',
        market: {},
        terminalMarket: { candles: [{ close: '99999' }] },
        position: null,
      }).price,
    ).toBeNull()
  })
})
