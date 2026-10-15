/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON fixtures */
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import gaps from '../../../../docs/mission-control/b6/ejemplo-con-huecos.json'
import missing from '../../../../docs/mission-control/b6/ejemplo-fuente-ausente.json'
import truncated from '../../../../docs/mission-control/b6/ejemplo-truncado.json'
import { decodeCandles } from '../infrastructure/candles-api.ts'
import { UnexpectedReport } from '../infrastructure/observability-api.ts'
import DecisionContext from './DecisionContext.tsx'
import {
  contextRange,
  contextSeries,
  CONTEXT_BUCKETS_EACH_SIDE,
} from './context-candles-view.ts'

// The drawing itself needs a canvas: here it only reports what it was given.
const drawn = vi.hoisted(() => ({ last: null as any, marker: null as any }))
vi.mock('./ContextCandlesChart.tsx', () => ({
  default: (props: any) => {
    drawn.last = props.series
    drawn.marker = props.marker
    return (
      <div
        data-testid="context-chart"
        data-candle-count={props.series.candles.length}
        data-gap-count={props.series.gapTimes.length}
      />
    )
  },
}))

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value))
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
const BUCKET = 1_789_999_500_000

afterEach(() => {
  vi.unstubAllGlobals()
  drawn.last = null
})

function serve(answer: (url: URL) => Response) {
  const calls: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost')
      calls.push(url)
      return answer(url)
    }),
  )
  return calls
}

function show(action = 'LONG', reasonCode = 'c25_long_pullback') {
  return render(
    <DecisionContext
      product="PF_XBTUSD"
      bucketStartMs={BUCKET}
      action={action}
      reasonCode={reasonCode}
    />,
  )
}

describe('B6 decoder (strict)', () => {
  it('keeps the prices as the strings the backend sent', () => {
    const report = decodeCandles(gaps)
    if (report.candles.state !== 'ok') throw new Error('expected ok')
    expect(report.candles.items[0].close).toBe('100.5')
    expect(report.candles.gaps).toHaveLength(2)
  })

  it('reads an unavailable source with its cause and no items', () => {
    const report = decodeCandles(missing)
    expect(report.candles.state).toBe('unavailable')
    expect('items' in report.candles).toBe(false)
  })

  it('rejects another schema, a bad state and a price that is not a number', () => {
    expect(() => decodeCandles({})).toThrow(UnexpectedReport)
    const state: any = clone(gaps)
    state.candles.state = 'maybe'
    expect(() => decodeCandles(state)).toThrow(/candles\.state/)
    const price: any = clone(gaps)
    price.candles.items[0].close = 'abc'
    expect(() => decodeCandles(price)).toThrow(/candle\.close/)
  })
})

describe('context range and series', () => {
  it('asks for N buckets each side, at most 1500, never past the last closed one', () => {
    const minute = 60_000
    const range = contextRange(BUCKET, minute, BUCKET + 600 * minute)
    expect(range.fromMs).toBe(BUCKET - CONTEXT_BUCKETS_EACH_SIDE * minute)
    expect((range.toMs - range.fromMs) / minute).toBeLessThanOrEqual(1500)
    // A recent decision: the range stops at the last closed bucket.
    const now = BUCKET + 5 * minute + 20_000
    expect(contextRange(BUCKET, minute, now).toMs).toBe(BUCKET + 5 * minute)
    // At least the decision's own bucket, even when «now» is right after it.
    expect(contextRange(BUCKET, minute, BUCKET + 10).toMs).toBe(BUCKET + minute)
  })

  it('draws only the served items; gaps stay empty and nothing is interpolated', () => {
    const series = contextSeries(decodeCandles(gaps), BUCKET)!
    expect(series.candles).toHaveLength(5)
    expect(series.gapTimes).toEqual([
      1_789_999_380, 1_789_999_440, 1_789_999_620,
    ])
    expect(series.gapRuns).toBe(2)
    expect(series.decisionCandle).toBe(true)
    // 1789999560 is the only candle after the decision's bucket.
    expect(series.afterCount).toBe(1)
    expect(series.candles.every((c) => !gapsInside(series, c.time))).toBe(true)
    expect(series.candles[0].close).toBe(100.5)
  })

  it('counts the minutes of the marked candle that come after the decision (D-157-01)', () => {
    const asFive = (r: ReturnType<typeof decodeCandles>) => ({
      ...r,
      interval: '5m',
      intervalMs: 300_000,
    })
    const report = decodeCandles(gaps)
    // 1 m: the candle is the decision's minute, nothing after it inside it.
    expect(contextSeries(report, BUCKET)!.minutesAfterInMarker).toBe(0)
    // 5 m, decision on the first minute of the candle: 4 later minutes.
    expect(contextSeries(asFive(report), BUCKET)!.minutesAfterInMarker).toBe(4)
    // Decision on the 4th minute: 1 later minute. On the last one: none.
    expect(
      contextSeries(asFive(report), BUCKET + 3 * 60_000)!.minutesAfterInMarker,
    ).toBe(1)
    expect(
      contextSeries(asFive(report), BUCKET + 4 * 60_000)!.minutesAfterInMarker,
    ).toBe(0)
  })

  it('has nothing to draw when the source is unavailable', () => {
    expect(contextSeries(decodeCandles(missing), BUCKET)).toBeNull()
  })
})

function gapsInside(series: { gapTimes: number[] }, time: number) {
  return series.gapTimes.includes(time)
}

describe('DecisionContext', () => {
  it('asks 1 m around the decision, draws the candles and says where they come from', async () => {
    const calls = serve(() => json(gaps))
    show()
    expect(await screen.findByTestId('context-chart')).toHaveAttribute(
      'data-candle-count',
      '5',
    )
    expect(calls).toHaveLength(1)
    const q = calls[0].searchParams
    expect(calls[0].pathname).toBe('/api-live/observability/candles')
    expect(q.get('interval')).toBe('1m')
    expect(q.get('product')).toBe('PF_XBTUSD')
    expect(Number(q.get('from'))).toBe(BUCKET - 60 * 60_000)
    expect(Number(q.get('limit'))).toBeLessThanOrEqual(1500)
    expect(screen.getByTestId('context-prov')).toHaveTextContent(
      'paper_futures_official_candles (futures-market.sqlite)',
    )
    expect(screen.getByTestId('context-prov')).toHaveTextContent('UTC')
    expect(screen.getByTestId('context-gaps')).toHaveTextContent(
      '3 velas sin dato en 2 tramos',
    )
    expect(screen.getByTestId('context-after')).toHaveTextContent(
      '1 vela posterior observada',
    )
    // The marker names the action and the registered reason, nothing else.
    expect(drawn.marker).toEqual({
      text: 'LONG · c25_long_pullback',
      tone: 'long',
    })
    expect(screen.getByTestId('context-decision')).toHaveTextContent(
      'LONG (propuesta)',
    )
  })

  it('a discard marker names no strategy', async () => {
    serve(() => json(gaps))
    show('WAIT', 'no_directional_proposal')
    await screen.findByTestId('context-chart')
    expect(drawn.marker).toEqual({
      text: 'WAIT · no_directional_proposal',
      tone: 'neutral',
    })
    expect(screen.getByTestId('context-decision')).toHaveTextContent(
      'sin estrategia atribuida',
    )
  })

  it('says «Sin datos de velas» with the cause when the source is unavailable', async () => {
    serve(() => json(missing))
    show()
    expect(await screen.findByText('Sin datos de velas')).toBeInTheDocument()
    expect(screen.getByText(/file_not_found/)).toBeInTheDocument()
    expect(screen.queryByTestId('context-chart')).toBeNull()
  })

  it('says «Sin velas en el rango» when 1 m and 5 m have none', async () => {
    const empty: any = clone(gaps)
    empty.candles.count = 0
    empty.candles.items = []
    const calls = serve((url) =>
      json({ ...empty, interval: url.searchParams.get('interval') }),
    )
    show()
    expect(await screen.findByText('Sin velas en el rango')).toBeInTheDocument()
    expect(calls.map((c) => c.searchParams.get('interval'))).toEqual([
      '1m',
      '5m',
    ])
    expect(screen.queryByTestId('context-chart')).toBeNull()
  })

  it('falls back to 5 m only when 1 m has no candle', async () => {
    const empty: any = clone(gaps)
    empty.candles.count = 0
    empty.candles.items = []
    const five: any = clone(truncated)
    const calls = serve((url) =>
      url.searchParams.get('interval') === '1m' ? json(empty) : json(five),
    )
    show()
    expect(await screen.findByTestId('context-chart')).toBeInTheDocument()
    expect(calls).toHaveLength(2)
    expect(screen.getByText(/· 5m/)).toBeInTheDocument()
  })

  it('with 5 m candles it says the marked candle includes minutes after the decision', async () => {
    const empty: any = clone(gaps)
    empty.candles.count = 0
    empty.candles.items = []
    const five: any = clone(gaps)
    five.interval = '5m'
    five.interval_ms = 300_000
    serve((url) =>
      url.searchParams.get('interval') === '1m' ? json(empty) : json(five),
    )
    show()
    expect(
      await screen.findByTestId('context-coarse-candle'),
    ).toHaveTextContent('incluye 4 min posteriores')
    expect(drawn.marker.text).toContain('vela con 4 min posteriores')
  })

  it('with 1 m candles there is no such warning', async () => {
    serve(() => json(gaps))
    show()
    await screen.findByTestId('context-chart')
    expect(screen.queryByTestId('context-coarse-candle')).toBeNull()
    expect(drawn.marker.text).not.toContain('posteriores')
  })

  it('warns when the range was cut by the limit', async () => {
    serve(() => json(truncated))
    show()
    expect(await screen.findByTestId('context-truncated')).toHaveTextContent(
      'se acortó',
    )
  })

  it('a decision without its own candle is not an error: no marker is invented', async () => {
    const recent: any = clone(gaps)
    recent.candles.items = recent.candles.items.filter(
      (i: any) => i.bucket_start_ms !== BUCKET,
    )
    recent.candles.count = recent.candles.items.length
    serve(() => json(recent))
    show()
    expect(
      await screen.findByTestId('context-no-decision-candle'),
    ).toHaveTextContent('no es un error')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(drawn.last.decisionCandle).toBe(false)
  })

  it('reports a failed read as an error, never as an empty chart', async () => {
    serve(() => json({}, 503))
    show()
    expect(
      await screen.findByText('No se pudieron leer las velas'),
    ).toBeInTheDocument()
    expect(screen.getByText('HTTP 503')).toBeInTheDocument()
    expect(screen.queryByText('Sin velas en el rango')).toBeNull()
  })

  it('asks again for another decision and never shows the previous candles', async () => {
    const calls = serve(() => json(gaps))
    const view = show()
    await screen.findByTestId('context-chart')
    view.rerender(
      <DecisionContext
        product="PF_XBTUSD"
        bucketStartMs={BUCKET - 60_000}
        action="WAIT"
        reasonCode="no_directional_proposal"
      />,
    )
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(Number(calls[1].searchParams.get('from'))).toBe(
      BUCKET - 60_000 - 60 * 60_000,
    )
  })
})
