import { describe, expect, it } from 'vitest'
import {
  MAX_SINGLE_DISCARDS,
  discardReasonText,
  holdText,
  isDiscardId,
  priceLinesOf,
  toChartCandles,
  toDiscardMarkers,
  toMarkers,
  tradeOfMarker,
  windowAround,
} from './run-chart-model.ts'
import type { RunSignal, RunTrade } from '../infrastructure/run-visual-api.ts'

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
      ['7-3:exit', 'exit', '× stop', 1_790_000_880],
    ])
    expect(markers[1]!.detail).toBe('Salida (Stop)')
    expect(tradeOfMarker('7-3:exit')).toBe('7-3')
    expect(tradeOfMarker(undefined)).toBeNull()
  })

  it('names the exit reason in Spanish and never invents one', () => {
    const exit = (reason: string | null) =>
      toMarkers([{ ...trade, exit_reason: reason }])[1]!
    expect(exit('target')).toMatchObject({
      label: '× objetivo',
      detail: 'Salida (Objetivo)',
    })
    expect(exit('time_stop').detail).toBe('Salida (Tiempo cumplido)')
    expect(exit('strategy_exit').detail).toBe(
      'Salida (Regla de salida de la estrategia)',
    )
    expect(exit(null)).toMatchObject({
      label: '×',
      detail: 'Salida (Sin motivo registrado)',
    })
    expect(exit('algo_nuevo')).toMatchObject({
      label: '×',
      detail: 'Salida (algo_nuevo)',
    })
  })

  it('turns the proposals that were not taken into neutral discard markers inside the window', () => {
    const signal = (minute: number, outcome: string): RunSignal => ({
      bucket_ms: minute * 60_000,
      side: minute % 2 ? 'LONG' : 'SHORT',
      outcome,
      reason_code: null,
    })
    const markers = toDiscardMarkers(
      [
        signal(1, 'accepted'),
        signal(2, 'position_open'),
        signal(3, 'rejected_stale_data'),
        signal(5, 'rejected_target_does_not_clear_cost'),
        signal(7, 'rejected_protective_levels_unavailable'),
        signal(9, 'rejected_unknown'),
        signal(11, 'otra_cosa'),
        signal(500, 'position_open'),
      ],
      { from: 0, to: 100 * 60_000 },
    )
    expect(markers.map((m) => [m.id, m.type, m.direction, m.time])).toEqual([
      ['d:120000', 'wait', 'flat', 120],
      ['d:180000', 'wait', 'flat', 180],
      ['d:300000', 'wait', 'flat', 300],
      ['d:420000', 'wait', 'flat', 420],
      ['d:540000', 'wait', 'flat', 540],
      ['d:660000', 'wait', 'flat', 660],
    ])
    expect(markers.map((m) => m.detail)).toEqual([
      'Descarte SHORT: ya había una posición abierta',
      'Descarte LONG: los datos estaban desactualizados',
      'Descarte LONG: el objetivo no cubría los costes',
      'Descarte LONG: no se pudieron calcular el stop y el objetivo',
      'Descarte LONG: la prueba no guardó el motivo',
      'Descarte LONG: motivo sin traducir («otra_cosa»)',
    ])
    expect(discardReasonText('position_open')).toBe(
      'ya había una posición abierta',
    )
    expect(isDiscardId('d:1')).toBe(true)
    expect(isDiscardId('7-3:entry')).toBe(false)
  })

  it('groups the discards of a crowded window and shows their count', () => {
    const signals: RunSignal[] = Array.from({ length: 400 }, (_, i) => ({
      bucket_ms: i * 60_000,
      side: 'LONG',
      outcome: i % 4 === 0 ? 'rejected_stale_data' : 'position_open',
      reason_code: null,
    }))
    const markers = toDiscardMarkers(signals, { from: 0, to: 400 * 60_000 })
    expect(markers.length).toBeLessThanOrEqual(40)
    expect(markers.reduce((sum, m) => sum + (m.count ?? 1), 0)).toBe(400)
    const first = markers[0]!
    expect(first.label).toBe(`+${first.count}`)
    expect(first.detail).toContain(`+${first.count} descartes:`)
    expect(first.detail).toContain('porque ya había una posición abierta')
    expect(first.memberIds).toHaveLength(first.count!)
    // exactly at the limit nothing is grouped
    expect(
      toDiscardMarkers(signals.slice(0, MAX_SINGLE_DISCARDS), {
        from: 0,
        to: 400 * 60_000,
      }),
    ).toHaveLength(MAX_SINGLE_DISCARDS)
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
