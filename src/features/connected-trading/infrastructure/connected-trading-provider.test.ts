import { describe, expect, it, vi } from 'vitest'
import {
  loadConnectedSnapshot,
  loadPaperDecisions,
} from './connected-trading-provider.ts'

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

describe('connected trading provider', () => {
  it('validates and normalizes backend timestamps without changing ledger identity', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/market/ohlc'))
        return response({
          candles: [
            {
              timestamp: 1_700_000_000_000,
              open: 2,
              high: 3,
              low: 1,
              close: 2.5,
              volume: 4,
            },
          ],
        })
      if (url.includes('/market/collector/status'))
        return response({
          enabled: true,
          running: true,
          newest_candle_iso: '2023-11-14T22:13:20.000Z',
          last_sync_timestamp: 1_700_000_000,
        })
      if (url.includes('/paper-trading/status'))
        return response({
          enabled: true,
          running: true,
          stream_state: 'connected',
          last_processed_event_time: 1_700_000_060_000,
          account: { balance_eur: 8, btc_balance: 1, total_equity_eur: 10 },
          execution_summary: {
            total_signals: 2,
            gate_rejections: 1,
            executed_trades: 1,
            closed_pnl_eur: 0,
          },
          active_positions: [],
        })
      if (url.includes('/paper-trading/orders'))
        return response({
          orders: [
            {
              id: 42,
              strategyId: 'micro-trend-pullback',
              signalTimestamp: 1_700_000_000,
              action: 'BUY',
              gatePassed: true,
              executionTimestamp: 1_700_000_000,
              amountEur: 2,
            },
          ],
        })
      if (url.includes('/paper-trading/positions'))
        return response([
          {
            id: 42,
            strategy_id: 'micro-trend-pullback',
            status: 'OPEN',
            entry_time: '2023-11-14T22:13:20.000Z',
            exit_time: null,
            entry_price: 2,
            exit_price: null,
            amount_eur: 2,
            fee_eur: 0.1,
            net_pnl_eur: null,
            current_price: 2.5,
            unrealized_net_pnl_eur: 0.4,
          },
        ])
      return response({ strategies: [] })
    })

    const data = await loadConnectedSnapshot({
      fetcher,
      now: 1_700_000_100_000,
    })
    expect(data.candles[0]?.timestamp).toBe(1_700_000_000_000)
    expect(data.orders[0]?.id).toBe(42)
    expect(data.positions.open[0]?.id).toBe(42)
    expect(data.paper.account.total_equity_eur).toBe(10)
    expect(fetcher).toHaveBeenCalledTimes(7)
  })

  it('rejects malformed candles instead of exposing partial or invented market data', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/market/ohlc'))
        return response({
          candles: [
            { timestamp: 1, open: 1, high: 0, low: 1, close: 1, volume: 1 },
          ],
        })
      if (url.includes('/market/collector/status'))
        return response({
          enabled: true,
          running: false,
          newest_candle_iso: null,
        })
      if (url.includes('/paper-trading/status'))
        return response({
          enabled: true,
          running: true,
          account: {},
          execution_summary: {},
        })
      if (url.includes('/paper-trading/orders')) return response({ orders: [] })
      if (url.includes('/positions')) return response([])
      if (url.includes('/strategies-summary')) return response([])
      return response({})
    })
    await expect(
      loadConnectedSnapshot({ fetcher, now: 1_700_000_100_000 }),
    ).rejects.toThrow('OHLC')
  })

  it('validates actual decision events and preserves backend IDs and unavailable rationale', async () => {
    const event = {
      id: 'session-a:strategy:1',
      instrumentId: 'BTC-EUR',
      eventTime: 1_700_000_000_000,
      receivedAt: 1_700_000_000_100,
      strategyId: 'micro-trend-pullback',
      strategyVersion: 'strategy-rule.v2',
      direction: 'flat',
      outcome: 'gate-rejected',
      reasonCode: 'entry_gate_rejected',
      sessionId: 'runtime-1',
      reason: null,
      conditions: [
        {
          code: 'entry_gate_distance',
          value: 0.004,
          operator: '>=',
          threshold: 0.006,
          passed: false,
        },
      ],
    }
    const fetcher = vi.fn(async () => response({ decisions: [event] }))
    const decisions = await loadPaperDecisions({ fetcher })
    expect(decisions).toEqual([event])
    expect(fetcher).toHaveBeenCalledWith(
      '/api/paper-trading/decisions?limit=200',
      expect.any(Object),
    )
    await expect(
      loadPaperDecisions({
        fetcher: vi.fn(async () =>
          response({ decisions: [{ ...event, direction: 'short' }] }),
        ),
      }),
    ).rejects.toThrow('decisiones paper')
  })
})
