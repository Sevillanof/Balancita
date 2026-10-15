import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import gaps from '../../../../docs/mission-control/b6/ejemplo-con-huecos.json'
import { decodeCandles } from '../infrastructure/candles-api.ts'
import ContextCandlesChart from './ContextCandlesChart.tsx'
import { contextSeries } from './context-candles-view.ts'

const mocks = vi.hoisted(() => {
  const candles = { setData: vi.fn() }
  const timeScale = { fitContent: vi.fn() }
  const chart = {
    addSeries: vi.fn(() => candles),
    timeScale: vi.fn(() => timeScale),
    remove: vi.fn(),
  }
  return {
    candles,
    chart,
    createChart: vi.fn(() => chart),
    createSeriesMarkers: vi.fn(),
  }
})

vi.mock('lightweight-charts', () => ({
  ColorType: { Solid: 'solid' },
  CandlestickSeries: 'candles',
  createChart: mocks.createChart,
  createSeriesMarkers: mocks.createSeriesMarkers,
}))

const BUCKET = 1_789_999_500_000

describe('ContextCandlesChart', () => {
  it('passes the served candles plus empty points for the gaps, in time order', () => {
    const series = contextSeries(decodeCandles(gaps), BUCKET)!
    render(
      <ContextCandlesChart
        series={series}
        marker={{ text: 'LONG · c25_long_pullback', tone: 'long' }}
        ariaLabel="x"
      />,
    )
    const data = mocks.candles.setData.mock.calls[0][0] as {
      time: number
      close?: number
    }[]
    expect(data).toHaveLength(8) // 5 candles + 3 empty buckets
    expect(data.map((p) => p.time)).toEqual(
      [...data.map((p) => p.time)].sort((a, b) => a - b),
    )
    const empty = data.filter((p) => p.close === undefined)
    expect(empty.map((p) => p.time)).toEqual([
      1_789_999_380, 1_789_999_440, 1_789_999_620,
    ])
    expect(mocks.createSeriesMarkers).toHaveBeenCalledTimes(1)
    const markers = (mocks.createSeriesMarkers.mock.calls[0] as unknown[])[1]
    expect(markers).toMatchObject([
      { time: 1_789_999_500, text: 'LONG · c25_long_pullback' },
    ])
  })

  it('draws no marker when the decision minute has no candle', () => {
    mocks.createSeriesMarkers.mockClear()
    const series = {
      ...contextSeries(decodeCandles(gaps), BUCKET)!,
      decisionCandle: false,
    }
    render(
      <ContextCandlesChart
        series={series}
        marker={{ text: 'WAIT · x', tone: 'neutral' }}
        ariaLabel="x"
      />,
    )
    expect(mocks.createSeriesMarkers).not.toHaveBeenCalled()
  })
})
