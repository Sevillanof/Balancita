import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TerminalChart from './TerminalChart.tsx'
import type { DemoCandle } from './types.ts'

const chartMocks = vi.hoisted(() => {
  const candles = {
    setData: vi.fn(),
    createPriceLine: vi.fn(() => ({})),
    removePriceLine: vi.fn(),
  }
  const volume = {
    setData: vi.fn(),
    priceScale: vi.fn(() => ({ applyOptions: vi.fn() })),
  }
  const timeScale = {
    fitContent: vi.fn(),
    getVisibleLogicalRange: vi.fn(() => ({ from: 5, to: 25 })),
    setVisibleLogicalRange: vi.fn(),
    scrollToRealTime: vi.fn(),
  }
  const markerApi = { setMarkers: vi.fn() }
  const chart = {
    addSeries: vi.fn((series: string) =>
      series === 'candles' ? candles : volume,
    ),
    timeScale: vi.fn(() => timeScale),
    applyOptions: vi.fn(),
    resize: vi.fn(),
    subscribeClick: vi.fn(),
    unsubscribeClick: vi.fn(),
    remove: vi.fn(),
  }
  return {
    candles,
    volume,
    timeScale,
    markerApi,
    chart,
    createChart: vi.fn((container: HTMLElement, options: unknown) => {
      if (!container || !options) throw new Error('Chart options are required.')
      return chart
    }),
    createSeriesMarkers: vi.fn(() => markerApi),
  }
})

vi.mock('lightweight-charts', () => ({
  ColorType: { Solid: 'solid' },
  CandlestickSeries: 'candles',
  HistogramSeries: 'volume',
  createChart: chartMocks.createChart,
  createSeriesMarkers: chartMocks.createSeriesMarkers,
}))

const candle: DemoCandle = {
  time: 1_800_000_000,
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 5,
}

describe('terminal chart viewport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  })

  it('uses the approved renderer with automatic container resizing', () => {
    render(
      <TerminalChart
        candles={[candle]}
        decisions={[]}
        positions={[]}
        trades={[]}
        selectedId=""
        interval="1m"
        onBucketSelect={vi.fn()}
      />,
    )

    expect(chartMocks.createChart).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      expect.objectContaining({ autoSize: true }),
    )
  })

  it('fits once, then preserves the visible range while replacing corrected history', () => {
    const props = {
      candles: [candle],
      decisions: [],
      positions: [],
      trades: [],
      selectedId: '',
      interval: '1m' as const,
      onBucketSelect: vi.fn(),
    }
    const view = render(<TerminalChart {...props} />)
    expect(chartMocks.timeScale.fitContent).toHaveBeenCalledTimes(1)
    view.rerender(
      <TerminalChart
        {...props}
        candles={[{ ...candle, high: 14, close: 12 }]}
      />,
    )
    expect(chartMocks.candles.setData).toHaveBeenLastCalledWith([
      { time: candle.time, open: 10, high: 14, low: 9, close: 12 },
    ])
    expect(chartMocks.timeScale.setVisibleLogicalRange).toHaveBeenCalledWith({
      from: 5,
      to: 25,
    })
    expect(chartMocks.timeScale.fitContent).toHaveBeenCalledTimes(1)
  })

  it('shares the approved renderer while preserving demo marker IDs and bucket selection', () => {
    const onBucketSelect = vi.fn()
    render(
      <TerminalChart
        candles={[candle]}
        decisions={[
          {
            id: 'demo-decision-1',
            time: candle.time + 35,
            kind: 'entry',
            direction: 'long',
            price: candle.close,
            reason: 'Fixture event',
          },
        ]}
        positions={[]}
        trades={[]}
        selectedId="demo-decision-1"
        interval="5m"
        onBucketSelect={onBucketSelect}
      />,
    )

    expect(chartMocks.createChart).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
      expect.objectContaining({
        autoSize: true,
        layout: expect.objectContaining({
          background: {
            type: 'solid',
            color: '#171c20',
          },
          fontFamily: 'IBM Plex Mono, monospace',
        }),
      }),
    )
    expect(chartMocks.markerApi.setMarkers).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'demo-decision-1',
        time: candle.time,
        text: 'LARGO ◀',
      }),
    ])
    const click = chartMocks.chart.subscribeClick.mock
      .calls[0]?.[0] as (event: { hoveredInfo: { objectId: string } }) => void
    click({ hoveredInfo: { objectId: 'demo-decision-1' } })
    expect(onBucketSelect).toHaveBeenCalledWith(candle.time)
  })
})
