import { describe, expect, it } from 'vitest'
import { qwenTrades } from './useQwenTrades.ts'

const row = (extra: Record<string, unknown>) => ({
  product: 'PF_XBTUSD',
  trade_no: 1,
  status: 'closed',
  side: 'LONG',
  entry_ms: 1_000,
  exit_ms: 9_000,
  entry_price: '100.5',
  net_usd: '-0.35',
  funding_status: 'complete',
  closed_by: 'qwen',
  hold_min: 120,
  ...extra,
})

describe('qwenTrades', () => {
  it('shapes open and closed trades and keeps the exact signs', () => {
    const out = qwenTrades({
      status: 'ok',
      trades: [
        row({
          trade_no: 2,
          status: 'open',
          exit_ms: null,
          net_usd: '0.12',
          mark_price: 101,
        }),
        row({}),
      ],
    })
    expect(out.map((t) => [t.tradeNo, t.open, t.netUsd])).toEqual([
      [2, true, 0.12],
      [1, false, -0.35],
    ])
    expect(out[0]!.markPrice).toBe(101)
    expect(out[1]!.closedBy).toBe('qwen')
    expect(out[1]!.fundingComplete).toBe(true)
  })

  it('leaves out malformed rows and gives nothing when the source is off', () => {
    expect(qwenTrades({ status: 'off', reason: 'file_not_found' })).toEqual([])
    expect(qwenTrades(null)).toEqual([])
    expect(
      qwenTrades({
        status: 'ok',
        trades: [
          row({ side: 'SIDEWAYS' }),
          row({ entry_ms: null }),
          row({ status: 'unexpected' }),
        ],
      }),
    ).toEqual([])
  })
})
