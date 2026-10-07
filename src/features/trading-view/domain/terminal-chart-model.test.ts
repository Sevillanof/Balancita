import { describe, expect, it } from 'vitest'
import {
  exitMarkers,
  positionLines,
  timeframeCandles,
} from './terminal-chart-model.ts'
import { parseTerminalChart } from '../infrastructure/terminal-chart-client.ts'

const candle = (time: number, close: number, volume = 1) => ({
  time,
  open: close - 1,
  high: close + 2,
  low: close - 2,
  close,
  volume,
})
const colors = { entry: 'blue', stop: 'red', target: 'green' }

describe('terminal chart model', () => {
  it('turns filled reduce-only orders into labelled exit markers', () => {
    expect(
      exitMarkers([
        {
          order_id: 'a',
          state: 'filled',
          reduce_only: true,
          reason_code: 'protective_stop',
          closed_at_ms: 1_800_000_061_500,
        },
        {
          order_id: 'b',
          state: 'filled',
          reduce_only: true,
          reason_code: 'strategy_exit',
          closed_at_ms: 1_800_000_120_000,
        },
        { order_id: 'c', state: 'filled', reduce_only: false, closed_at_ms: 1 },
        { order_id: 'd', state: 'open', reduce_only: true, closed_at_ms: 1 },
      ]),
    ).toEqual([
      { id: 'exit:a', time: 1_800_000_061, type: 'exit', label: 'STOP' },
      { id: 'exit:b', time: 1_800_000_120, type: 'exit', label: 'SALIDA' },
    ])
  })

  it('draws entry, stop and target of an open position only', () => {
    expect(
      positionLines(
        {
          side: 'short',
          entry_price_usd_per_btc: '84161.5',
          stop: '84500',
          target: '83400',
        },
        colors,
      ),
    ).toEqual([
      {
        id: 'entry',
        price: 84161.5,
        title: 'ENTRADA CORTO',
        color: 'blue',
        dashed: false,
      },
      { id: 'stop', price: 84500, title: 'STOP', color: 'red', dashed: true },
      {
        id: 'target',
        price: 83400,
        title: 'OBJETIVO',
        color: 'green',
        dashed: true,
      },
    ])
    expect(positionLines({}, colors)).toEqual([])
    expect(
      positionLines({ side: 'long', entry_price_usd_per_btc: null }, colors),
    ).toEqual([])
  })

  it('keeps the server timeframe and moves its last bucket with the live minutes', () => {
    const remote = [candle(0, 100, 10), candle(300, 105, 10)]
    const minutes = [candle(300, 104), candle(360, 110), candle(600, 108, 2)]
    expect(timeframeCandles(minutes, 300, remote)).toEqual([
      candle(0, 100, 10),
      { ...candle(300, 110, 10), open: 104, low: 102 },
      { time: 600, open: 107, high: 110, low: 106, close: 108, volume: 2 },
    ])
    // No server series: the minutes are folded locally.
    expect(
      timeframeCandles(minutes, 300, null).map((item) => item.time),
    ).toEqual([300, 600])
    expect(timeframeCandles(minutes, 60, remote)).toEqual(minutes)
  })

  it('accepts only a well-formed chart body', () => {
    expect(parseTerminalChart({ schema_version: 'other' })).toBeNull()
    const parsed = parseTerminalChart({
      schema_version: 'futures-terminal-chart.v1',
      interval_ms: 3_600_000,
      candles: [
        {
          time_ms: 3_600_000,
          open: '1',
          high: '2',
          low: '0.5',
          close: '1.5',
          volume_btc: '3',
          closed: true,
        },
        { time_ms: 'x', open: '1' },
      ],
      flow: [{ time_ms: 3_600_000, buy_volume: 2, sell_volume: 'x' }],
      depth: null,
      ticker: { mark: 1 },
    })!
    expect(parsed.candles).toEqual([
      {
        time: 3600,
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 3,
        closed: true,
      },
    ])
    expect(parsed.flow[0]).toMatchObject({ buy_volume: 2, sell_volume: null })
    expect(parsed.depth).toBeNull()
    expect(parsed.ticker).toEqual({ mark: 1 })
  })
})
