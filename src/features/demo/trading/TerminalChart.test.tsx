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
  const chart = {
    addSeries: vi.fn((series: string) =>
      series === 'candles' ? candles : volume,
    ),
    timeScale: vi.fn(() => timeScale),
    applyOptions: vi.fn(),
    subscribeClick: vi.fn(),
    unsubscribeClick: vi.fn(),
    remove: vi.fn(),
  }
  return {
    candles,
    volume,
    timeScale,
    chart,
    createChart: vi.fn((container: HTMLElement, options: unknown) => {
      if (!container || !options) throw new Error('Chart options are required.')
      return chart
    }),
    createSeriesMarkers: vi.fn(() => ({ setMarkers: vi.fn() })),
  }
})

vi.mock('lightweight-charts', () => ({
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

  it('uses the owned resize observer without enabling autoSize', () => {
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
      expect.objectContaining({ autoSize: false }),
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
})
