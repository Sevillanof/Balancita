import { describe, expect, it } from 'vitest'
import {
  exitMarkers,
  fillDetailRows,
  fillMarkers,
  groupWaitMarkers,
  pickMarkerAt,
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
  it('uses verified remote 1m history so an old open entry does not disappear with the short stream', () => {
    const remote = [candle(0, 100), candle(60, 101), candle(120, 102)]
    const stream = [candle(120, 103), candle(180, 104)]
    expect(timeframeCandles(stream, 60, remote)).toEqual([
      candle(0, 100),
      candle(60, 101),
      candle(120, 103),
      candle(180, 104),
    ])
  })

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
    expect(timeframeCandles(minutes, 60, remote)).toEqual([
      remote[0],
      ...minutes,
    ])
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
  const order = (extra: Record<string, unknown> = {}) => ({
    order_id: 'o1',
    strategy_id: 'c25-pullback-perp-v1',
    ...extra,
  })
  const fill = (extra: Record<string, unknown> = {}) => ({
    fill_id: 'fill:11',
    order_id: 'o1',
    side: 'buy',
    quantity_btc: '0.5',
    price_usd_per_btc: '100000',
    reduce_only: false,
    event_time_ms: 120_000,
    ...extra,
  })

  it('draws one marker per durable fill with its original id, time and quantity', () => {
    const markers = fillMarkers(
      [
        fill(),
        fill({ fill_id: 'fill:12', order_id: 'o2', side: 'sell' }),
        fill({ fill_id: 'fill:13', reduce_only: true }),
        fill({ fill_id: 'fill:14', side: 'hold' }),
        fill({ fill_id: 'fill:15', event_time_ms: undefined }),
        fill({ fill_id: undefined }),
        fill({ fill_id: 'fill:16', quantity_btc: '0' }),
      ],
      [order(), order({ order_id: 'o2', strategy_id: undefined })],
      { unit: 'BTC' },
    )
    expect(markers).toEqual([
      {
        id: 'fill:11',
        time: 120,
        type: 'fill',
        direction: 'long',
        label: 'C25 EJ L',
        detail: 'C25 EJEC. LONG 0.5 BTC',
        strategyId: 'c25-pullback-perp-v1',
      },
      {
        id: 'fill:12',
        time: 120,
        type: 'fill',
        direction: 'short',
        label: 'EJ S',
        detail: 'EJEC. SHORT 0.5 BTC',
      },
    ])
  })

  it('lists only the facts the fill records, in UTC, and says what is missing', () => {
    const rows = (value: unknown) =>
      Object.fromEntries(
        fillDetailRows(value, {
          unit: 'BTC',
          source: 'Histórico · Gateway D',
        }).map((row) => [row.key, row.value]),
      )
    expect(rows(fill({ event_time_ms: 1_800_000_000_007 }))).toEqual({
      fill_id: 'fill:11',
      order_id: 'o1',
      time: '2027-01-15 08:00:00.007 UTC',
      quantity: '0.5 BTC',
      side: 'LONG (compra)',
      price: '100000 USD',
      source: 'Histórico · Gateway D',
    })
    expect(
      rows(fill({ side: 'sell', price_usd_per_btc: undefined })),
    ).toMatchObject({ side: 'SHORT (venta)', price: 'No disponible' })
    expect(fillDetailRows({}).map((row) => row.value)).toEqual(
      Array(7).fill('No disponible'),
    )
  })

  it('never reads the order state: a filled order without fills draws nothing', () => {
    expect(
      fillMarkers(
        [],
        [order({ state: 'filled', side: 'buy', closed_at_ms: 120_000 })],
      ),
    ).toEqual([])
    // A fill still draws when its order is not in the (trimmed) order list.
    expect(fillMarkers([fill()], [])).toHaveLength(1)
  })

  it('draws every partial fill of one order as its own marker with its quantity', () => {
    const markers = fillMarkers(
      [
        fill({
          fill_id: 'fill:21',
          quantity_btc: '0.2',
          event_time_ms: 120_000,
        }),
        fill({
          fill_id: 'fill:22',
          quantity_btc: '0.3',
          event_time_ms: 125_000,
        }),
      ],
      [order()],
    )
    expect(markers.map((m) => m.id)).toEqual(['fill:21', 'fill:22'])
    expect(markers.map((m) => m.label)).toEqual(['C25 EJ L', 'C25 EJ L'])
    expect(markers.map((m) => m.detail)).toEqual([
      'C25 EJEC. LONG 0.2',
      'C25 EJEC. LONG 0.3',
    ])
    expect(markers.map((m) => m.time)).toEqual([120, 125])
  })

  it('keeps fills inside the period and names the history source', () => {
    expect(fillMarkers([fill()], [], { from: 200 })).toEqual([])
    expect(
      fillMarkers([fill()], [order()], { prefix: 'Histórico · Gateway D' })[0]
        ?.label,
    ).toBe('Histórico · Gateway D · C25 EJ L')
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
      label: 'W×3',
      detail: 'WAIT ×3',
      count: 3,
      memberIds: ['a', 'b', 'c'],
    })
    expect(out.find((marker) => marker.id === 'd')?.label).toBe('WAIT')
    expect(out).toHaveLength(3)
  })
})

describe('pickMarkerAt', () => {
  // A decision one candle (13 px) before an EJEC. fill, labels overlapping.
  const decision = { id: 'PF_XBTUSD-1', x: 616, y: 231 }
  const fill = { id: 'fill:3', x: 629, y: 229 }

  it('opens the fill when the click is on the fill, whatever the order', () => {
    expect(pickMarkerAt([decision, fill], fill, 16, 30)).toBe('fill:3')
    expect(pickMarkerAt([fill, decision], fill, 16, 30)).toBe('fill:3')
  })

  it('opens the decision when the click is on the decision, whatever the order', () => {
    expect(pickMarkerAt([decision, fill], decision, 16, 30)).toBe('PF_XBTUSD-1')
    expect(pickMarkerAt([fill, decision], decision, 16, 30)).toBe('PF_XBTUSD-1')
  })

  it('keeps telling them apart when a zoom brings them to 4 px', () => {
    const zoomedOut = [
      { id: 'PF_XBTUSD-1', x: 620, y: 231 },
      { id: 'fill:3', x: 624, y: 229 },
    ]
    expect(pickMarkerAt(zoomedOut, { x: 624, y: 229 }, 8, 30)).toBe('fill:3')
    expect(pickMarkerAt(zoomedOut, { x: 620, y: 231 }, 8, 30)).toBe(
      'PF_XBTUSD-1',
    )
  })

  it('tells apart markers stacked on one candle by y, in both directions', () => {
    const stacked = [
      { id: 'PF_XBTUSD-2', x: 100, y: 200 },
      { id: 'fill:1', x: 100, y: 230 },
    ]
    expect(pickMarkerAt(stacked, { x: 100, y: 228 }, 16, 30)).toBe('fill:1')
    expect(pickMarkerAt(stacked, { x: 100, y: 203 }, 16, 30)).toBe(
      'PF_XBTUSD-2',
    )
    expect(
      pickMarkerAt([...stacked].reverse(), { x: 101, y: 228 }, 16, 30),
    ).toBe('fill:1')
  })

  it('selects nothing when the click is far above or below the glyph', () => {
    const lone = { id: 'fill:3', x: 629, y: 229 }
    expect(pickMarkerAt([lone], { x: 629, y: 229 }, 16, 30)).toBe('fill:3')
    expect(pickMarkerAt([lone], { x: 629, y: 500 }, 16, 30)).toBeNull()
    expect(pickMarkerAt([lone], { x: 629, y: 20 }, 16, 30)).toBeNull()
    // Beyond the vertical reach of the neighbour too, even in its column.
    expect(
      pickMarkerAt([decision, fill], { x: 616, y: 500 }, 16, 30),
    ).toBeNull()
  })

  it('returns null away from every marker', () => {
    expect(
      pickMarkerAt([decision, fill], { x: 300, y: 229 }, 16, 30),
    ).toBeNull()
    expect(pickMarkerAt([], { x: 1, y: 1 }, 16, 30)).toBeNull()
  })
})
