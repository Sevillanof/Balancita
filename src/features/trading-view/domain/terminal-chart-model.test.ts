import { describe, expect, it } from 'vitest'
import {
  exitMarkers,
  fillMarkers,
  groupWaitMarkers,
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

describe('strategy markers', () => {
  it('codes and colours a strategy id', async () => {
    const { strategyCode, strategyMarkerColor } =
      await import('./terminal-chart-model.ts')
    expect(strategyCode('c27-breakout-perp-v1')).toBe('C27')
    expect(strategyCode(null)).toBeNull()
    expect(strategyMarkerColor('c25-pullback-perp-v1')).toBeTruthy()
    expect(strategyMarkerColor('x')).toBeUndefined()
  })
  it('tags exit markers with the order strategy', async () => {
    const { exitMarkers } = await import('./terminal-chart-model.ts')
    const [marker] = exitMarkers([
      {
        state: 'filled',
        reduce_only: true,
        order_id: 'o1',
        closed_at_ms: 5000,
        reason_code: 'protective_stop',
        strategy_id: 'c26-reversion-perp-v1',
      },
    ])
    expect(marker).toMatchObject({
      label: 'C26 STOP',
      strategyId: 'c26-reversion-perp-v1',
    })
  })
})

describe('lines per strategy book', () => {
  const colors = { entry: 'a', stop: 'b', target: 'c' }
  it('names and separates the lines of each book', async () => {
    const { positionLines } = await import('./terminal-chart-model.ts')
    const lines = positionLines(
      {
        side: 'long',
        entry_price_usd_per_btc: '100',
        stop: '90',
        target: '120',
      },
      colors,
      { id: 'c25-0', code: 'C25' },
    )
    expect(lines.map((line) => line.id)).toEqual([
      'c25-0:entry',
      'c25-0:stop',
      'c25-0:target',
    ])
    expect(lines[1]!.title).toBe('C25 STOP')
  })
  it('uses the gateway list, BTC only, else the single position', async () => {
    const { chartPositions } = await import('./terminal-chart-model.ts')
    const btc = { side: 'long', product_id: 'PF_XBTUSD' }
    const eth = { side: 'short', product_id: 'PF_ETHUSD' }
    expect(chartPositions([btc, eth, { side: null }], {})).toEqual([btc])
    expect(chartPositions([], { side: 'long' })).toEqual([])
    expect(chartPositions(undefined, { side: 'long' })).toEqual([
      { side: 'long' },
    ])
    expect(chartPositions(undefined, {})).toEqual([])
  })
  it('keeps the positions of the product asked, not only BTC', async () => {
    const { chartPositions } = await import('./terminal-chart-model.ts')
    const btc = { side: 'long', product_id: 'PF_XBTUSD' }
    const eth = { side: 'short', product_id: 'PF_ETHUSD' }
    expect(chartPositions([btc, eth], {}, 'PF_ETHUSD')).toEqual([eth])
    expect(chartPositions([btc, eth], {}, 'PF_SOLUSD')).toEqual([])
  })
  it('limits exit markers to the visible period and names their source', async () => {
    const { exitMarkers } = await import('./terminal-chart-model.ts')
    const order = (id: string, closed_at_ms: number) => ({
      order_id: id,
      state: 'filled',
      reduce_only: true,
      reason_code: 'profit_target',
      closed_at_ms,
    })
    const orders = [
      order('early', 9_000),
      order('inside', 20_000),
      order('late', 40_000),
    ]
    expect(exitMarkers(orders).map((m) => m.id)).toHaveLength(3)
    const bounded = exitMarkers(orders, {
      from: 10,
      to: 30,
      prefix: 'Histórico · Gateway D',
    })
    expect(bounded.map((m) => m.id)).toEqual(['exit:inside'])
    expect(bounded[0]!.label).toBe('Histórico · Gateway D · OBJETIVO')
  })
})

describe('executed-operation and WAIT markers', () => {
  const filled = (extra: Record<string, unknown> = {}) => ({
    order_id: 'o1',
    state: 'filled',
    side: 'buy',
    reduce_only: false,
    closed_at_ms: 120_000,
    strategy_id: 'c25-pullback-perp-v1',
    ...extra,
  })

  it('draws only filled, non-reduce-only orders with a known side, from the order alone', () => {
    const markers = fillMarkers([
      filled(),
      filled({ order_id: 'o2', side: 'sell', strategy_id: undefined }),
      filled({ order_id: 'o3', reduce_only: true }),
      filled({ order_id: 'o4', state: 'open' }),
      filled({ order_id: 'o5', side: 'hold' }),
      filled({ order_id: 'o6', closed_at_ms: undefined }),
    ])
    expect(markers).toEqual([
      {
        id: 'fill:o1',
        time: 120,
        type: 'fill',
        direction: 'long',
        label: 'C25 EJEC. LONG',
        strategyId: 'c25-pullback-perp-v1',
      },
      {
        id: 'fill:o2',
        time: 120,
        type: 'fill',
        direction: 'short',
        label: 'EJEC. SHORT',
      },
    ])
  })

  it('keeps fills inside the period and names the history source', () => {
    expect(fillMarkers([filled()], { from: 200 })).toEqual([])
    expect(
      fillMarkers([filled()], { prefix: 'Histórico · Gateway D' })[0]?.label,
    ).toBe('Histórico · Gateway D · C25 EJEC. LONG')
  })

  it('groups WAIT markers per window and leaves the rest untouched', () => {
    const wait = (id: string, time: number) => ({
      id,
      time,
      type: 'wait' as const,
      label: 'WAIT',
    })
    const proposal = {
      id: 'p',
      time: 60,
      type: 'proposal' as const,
      direction: 'long' as const,
      label: 'LONG prop.',
    }
    const out = groupWaitMarkers(
      [wait('a', 0), wait('b', 60), wait('c', 120), wait('d', 1_000), proposal],
      900,
    )
    expect(out).toContainEqual(proposal)
    const grouped = out.find((marker) => marker.id === 'c')
    expect(grouped).toMatchObject({
      label: 'WAIT ×3',
      count: 3,
      memberIds: ['a', 'b', 'c'],
    })
    expect(out.find((marker) => marker.id === 'd')?.label).toBe('WAIT')
    expect(out).toHaveLength(3)
  })
})
