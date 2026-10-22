import { describe, expect, it } from 'vitest'
import {
  MAX_OVERVIEW_MARKS,
  MAX_SINGLE_DISCARDS,
  discardReasonText,
  fullViewText,
  holdText,
  isDiscardId,
  priceLinesOf,
  resolutionFor,
  resolutionSeconds,
  toChartCandles,
  toDiscardMarkers,
  toMarkers,
  toOverviewMarkers,
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

describe('whole stretch of a run', () => {
  const DAY = 24 * 60 * 60_000
  const START = Date.UTC(2026, 0, 1)
  const END = Date.UTC(2026, 3, 18)

  it('picks a resolution that keeps the stretch under about 2.700 candles', () => {
    expect(resolutionFor(6 * 60 * 60_000)).toBe('1m')
    expect(resolutionFor(2 * DAY)).toBe('5m')
    expect(resolutionFor(7 * DAY)).toBe('5m')
    expect(resolutionFor(20 * DAY)).toBe('15m')
    expect(resolutionFor(90 * DAY)).toBe('1h')
    expect(resolutionFor(END - START)).toBe('1h')
    expect(resolutionFor(365 * DAY)).toBe('4h')
    expect(resolutionFor(3 * 365 * DAY)).toBe('1d')
    expect(resolutionSeconds('4h')).toBe(14_400)
    expect(resolutionSeconds('raro')).toBe(60)
  })

  it('says what the chart shows, with the last day of the stretch', () => {
    expect(fullViewText('1h', START, END)).toBe(
      'Velas de 1 hora · tramo completo (1-ene-2026 a 17-abr-2026)',
    )
  })

  const many = (n: number): RunTrade[] =>
    Array.from({ length: n }, (_, i) => {
      const entry = START + Math.floor((i / n) * (END - START - DAY))
      return {
        ...trade,
        trade_id: `9-${i}`,
        side: i % 2 === 0 ? 'LONG' : 'SHORT',
        entry_time_ms: entry,
        entry_bucket_ms: entry,
        exit_time_ms: entry + 30 * 60_000,
        exit_bucket_ms: entry + 29 * 60_000,
        exit_reason: i % 3 === 0 ? 'stop' : 'target',
      }
    })

  it('draws one mark per entry and exit while there are few', () => {
    const markers = toOverviewMarkers(many(20), [], { from: START, to: END })
    expect(markers).toHaveLength(40)
    expect(markers.some((m) => m.label === 'L')).toBe(true)
    expect(markers.some((m) => m.label === '× stop')).toBe(true)
  })

  it('groups 1.400 trades with their discards under the limit the chart can paint, losing none', () => {
    const trades = many(1400)
    const signals: RunSignal[] = Array.from({ length: 300 }, (_, i) => ({
      bucket_ms: START + i * 8 * 60 * 60_000,
      side: 'LONG',
      outcome: 'rejected_stale_data',
      reason_code: null,
    }))
    const markers = toOverviewMarkers(trades, signals, { from: START, to: END })
    expect(markers.length).toBeGreaterThan(0)
    expect(markers.length).toBeLessThanOrEqual(MAX_OVERVIEW_MARKS)
    const count = (match: (id: string) => boolean) =>
      markers
        .filter((m) => match(m.id))
        .reduce((sum, m) => sum + (m.count ?? 1), 0)
    expect(count((id) => id.startsWith('g:entry'))).toBe(1400)
    expect(count((id) => id.startsWith('g:exit'))).toBe(1400)
    expect(count(isDiscardId)).toBe(300)
    expect(new Set(markers.map((m) => m.id)).size).toBe(markers.length)
    const longs = markers.find((m) => m.id.startsWith('g:entry-long'))!
    expect(longs.label).toMatch(/^L\+\d+$/)
    expect(longs.memberIds!.length).toBe(longs.count)
    expect(markers.find((m) => m.id.startsWith('g:exit'))!.detail).toMatch(
      /^\+\d+ salidas: .*(Stop|Objetivo)/,
    )
  })

  it('leaves out the signals ignored for an open position and the accepted ones', () => {
    const signals: RunSignal[] = [
      {
        bucket_ms: START + 1,
        side: 'LONG',
        outcome: 'position_open',
        reason_code: null,
      },
      {
        bucket_ms: START + 2,
        side: 'LONG',
        outcome: 'accepted',
        reason_code: null,
      },
    ]
    expect(toOverviewMarkers([], signals, { from: START, to: END })).toEqual([])
  })
})
