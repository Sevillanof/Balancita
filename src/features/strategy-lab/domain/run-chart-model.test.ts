import { describe, expect, it } from 'vitest'
import {
  holdText,
  priceLinesOf,
  toChartCandles,
  toMarkers,
  tradeOfMarker,
  windowAround,
} from './run-chart-model.ts'
import type { RunTrade } from '../infrastructure/run-visual-api.ts'

/* DATOS DE EJEMPLO: una operación inventada solo para estas pruebas. */
const trade: RunTrade = {
  trade_id: '7-3',
  product_id: 'PF_XBTUSD',
  side: 'SHORT',
  entry_time_ms: 1_790_000_040_000,
  entry_bucket_ms: 1_790_000_040_000,
  entry_price: '100.5',
  exit_time_ms: 1_790_000_940_000,
  exit_bucket_ms: 1_790_000_880_000,
  exit_price: null,
  exit_reason: 'stop',
  reason_code: null,
  net_bp: -3,
  pnl_usd: -0.03,
  funding_usd: null,
  funding_status: 'unknown',
  notional_usd: '100',
  signal_time_ms: null,
}

describe('run chart model', () => {
  it('turns a closed trade into one entry and one exit marker on their own candles', () => {
    const markers = toMarkers([trade])
    expect(markers.map((m) => [m.id, m.type, m.label, m.time])).toEqual([
      ['7-3:entry', 'entry', 'S', 1_790_000_040],
      ['7-3:exit', 'exit', '×', 1_790_000_880],
    ])
    expect(tradeOfMarker('7-3:exit')).toBe('7-3')
    expect(tradeOfMarker(undefined)).toBeNull()
  })

  it('draws only the prices the run saved', () => {
    expect(priceLinesOf(null)).toEqual([])
    const lines = priceLinesOf(trade)
    expect(lines.map((l) => l.price)).toEqual([100.5])
  })

  it('drops candles with non-numeric values instead of inventing them', () => {
    const good = {
      time_ms: 60_000,
      open: '1',
      high: '2',
      low: '0.5',
      close: '1.5',
      volume: '3',
    }
    expect(toChartCandles([good, { ...good, close: 'x' }])).toHaveLength(1)
    expect(toChartCandles([good])[0]!.time).toBe(60)
  })

  it('frames a trade with two hours of context on each side', () => {
    expect(windowAround(trade)).toEqual({
      from: trade.entry_time_ms - 7_200_000,
      to: trade.exit_time_ms + 7_200_000,
    })
    expect(holdText(75 * 60_000)).toBe('1 h 15 min')
    expect(holdText(12 * 60_000)).toBe('12 min')
  })
})
