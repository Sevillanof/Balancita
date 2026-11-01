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
  it('preserves frozen execution provenance and does not accept a missing entry receipt', () => {
    const entry = {
      receipt_id: 'a'.repeat(64),
      cost_model_hash: 'b'.repeat(64),
      price: '101',
      quantity: '1',
      fee_usd: '0.0505',
      fee_rate: '0.0005',
      source:
        'https://futures.kraken.com/derivatives/api/v3/orderbook?symbol=PF_ETHUSD',
      signal_at_ms: 1000,
      decision_at_ms: 1100,
      requested_at_ms: 1100,
      received_at_ms: 1200,
      server_at_ms: 1190,
      executed_at_ms: 1300,
    }
    const execution = {
      model: 'kraken-futures-book.v1',
      entry,
      exit: null,
      mark: null,
      funding_receipt_id: null,
      error: 'libro_no_disponible',
    }
    const valid = row({
      product: 'PF_ETHUSD',
      entry_ms: 1300,
      entry_price: '101',
      status: 'open',
      exit_ms: null,
      net_usd: null,
      execution,
    })
    const out = qwenTrades({ status: 'ok', trades: [valid] })
    expect(out[0]).toMatchObject({
      execution: {
        model: execution.model,
        error: execution.error,
        entry: {
          receiptId: entry.receipt_id,
          feeRate: 0.0005,
          receivedMs: 1200,
          executedMs: 1300,
        },
      },
    })
    expect(
      qwenTrades({
        status: 'ok',
        trades: [{ ...valid, execution: { ...execution, entry: null } }],
      }),
    ).toEqual([])
    for (const broken of [
      { ...execution, error: 42 },
      { ...execution, entry: { ...entry, fee_rate: '-0.5' } },
      { ...execution, entry: { ...entry, decision_at_ms: 1400 } },
    ]) {
      expect(
        qwenTrades({
          status: 'ok',
          trades: [{ ...valid, execution: broken }],
        }),
      ).toEqual([])
    }
  })

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
