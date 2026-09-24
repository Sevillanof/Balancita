import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { CandlestickData } from 'lightweight-charts'
import PriceChart from './PriceChart.tsx'

const mocks = vi.hoisted(() => {
  const series = {
    setData: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    applyOptions: vi.fn(),
  }
  const markerPlugin = {
    setMarkers: vi.fn(),
    detach: vi.fn(),
  }
  const createSeriesMarkers = vi.fn(() => markerPlugin)
  const timeScale = {
    fitContent: vi.fn(),
    setVisibleRange: vi.fn(),
    scrollToRealTime: vi.fn(),
  }
  const chart = {
    addSeries: vi.fn(() => series),
    timeScale: vi.fn(() => timeScale),
    remove: vi.fn(),
    applyOptions: vi.fn(),
  }
  const createChart = vi.fn(() => chart)
  return {
    CandlestickSeries: { kind: 'candlestick' },
    createChart,
    createSeriesMarkers,
    chart,
    series,
    markerPlugin,
    timeScale,
    reset() {
      createChart.mockClear()
      createSeriesMarkers.mockClear()
      chart.addSeries.mockClear()
      series.setData.mockClear()
      series.update.mockClear()
      chart.timeScale.mockClear()
      timeScale.fitContent.mockClear()
      timeScale.setVisibleRange.mockClear()
      timeScale.scrollToRealTime.mockClear()
      chart.remove.mockClear()
      markerPlugin.setMarkers.mockClear()
      markerPlugin.detach.mockClear()
    },
  }
})

vi.mock('lightweight-charts', () => ({
  createChart: mocks.createChart,
  createSeriesMarkers: mocks.createSeriesMarkers,
  CandlestickSeries: mocks.CandlestickSeries,
  ColorType: { Solid: 'solid' },
}))

function candlestick(time: number, price: number): CandlestickData {
  return {
    time: time as CandlestickData['time'],
    open: price,
    high: price + 2,
    low: price - 2,
    close: price + 1,
  }
}

describe('PriceChart', () => {
  beforeEach(() => {
    mocks.reset()
  })

  function renderChart(data: CandlestickData[]) {
    return render(<PriceChart data={data} />)
  }

  it('shows an accessible empty state and does not create a chart without data', () => {
    renderChart([])

    expect(screen.getByRole('status')).toHaveTextContent(
      'No hay datos de gráfico disponibles.',
    )
    expect(mocks.createChart).not.toHaveBeenCalled()
  })

  it('creates an auto-size chart with TradingView attribution when data is available', () => {
    renderChart([candlestick(1704067200, 100)])

    const container = screen.getByTestId('price-chart')
    expect(mocks.createChart).toHaveBeenCalledTimes(1)
    expect(mocks.createChart).toHaveBeenCalledWith(
      container,
      expect.objectContaining({
        autoSize: true,
        layout: expect.objectContaining({ attributionLogo: true }),
        timeScale: {
          borderColor: expect.any(String),
          timeVisible: true,
          secondsVisible: false,
        },
      }),
    )
  })

  it('adds a candlestick series and feeds it the transformed data', () => {
    const data = [candlestick(1704067200, 100), candlestick(1704067201, 101)]
    renderChart(data)

    expect(mocks.chart.addSeries).toHaveBeenCalledWith(
      mocks.CandlestickSeries,
      expect.objectContaining({
        upColor: expect.any(String),
        downColor: expect.any(String),
      }),
    )
    expect(mocks.series.setData).toHaveBeenCalledWith(data)
    expect(mocks.timeScale.setVisibleRange).toHaveBeenCalledWith({
      from: 1704066301,
      to: 1704067201,
    })
    expect(mocks.timeScale.fitContent).not.toHaveBeenCalled()
    expect(mocks.timeScale.scrollToRealTime).not.toHaveBeenCalled()
  })

  it('does not create a markers plugin in normal real-time mode', () => {
    renderChart([candlestick(1704067200, 100)])

    expect(mocks.createSeriesMarkers).not.toHaveBeenCalled()
  })

  it('detaches its marker plugin on unmount', () => {
    const markers = [
      {
        time: 1704067200 as CandlestickData['time'],
        position: 'belowBar' as const,
        color: '#13795b',
        shape: 'arrowUp' as const,
        text: 'Compra',
      },
    ]
    const { unmount } = render(
      <PriceChart data={[candlestick(1704067200, 100)]} markers={markers} />,
    )

    expect(mocks.createSeriesMarkers).toHaveBeenCalledWith(
      mocks.series,
      markers,
    )
    unmount()

    expect(mocks.markerPlugin.detach).toHaveBeenCalledTimes(1)
    expect(mocks.markerPlugin.setMarkers).not.toHaveBeenCalled()
  })

  it('updates markers on the same plugin without resetting chart data', () => {
    const marker = {
      time: 1704067200 as CandlestickData['time'],
      position: 'belowBar' as const,
      color: '#26a69a',
      shape: 'arrowUp' as const,
      text: 'BUY 30€',
    }
    const data = [candlestick(1704067200, 100)]
    const { rerender } = render(<PriceChart data={data} markers={[marker]} />)
    rerender(<PriceChart data={data} markers={[]} />)

    expect(mocks.createSeriesMarkers).toHaveBeenCalledTimes(1)
    expect(mocks.markerPlugin.setMarkers).toHaveBeenCalledWith([])
    expect(mocks.markerPlugin.detach).not.toHaveBeenCalled()
    expect(mocks.series.setData).toHaveBeenCalledTimes(1)
    expect(mocks.chart.remove).not.toHaveBeenCalled()
  })

  it('updates the current candle without recentering the viewport', () => {
    const { rerender } = renderChart([candlestick(1704067200, 100)])

    const next = [candlestick(1704067200, 99)]
    rerender(<PriceChart data={next} />)

    expect(mocks.createChart).toHaveBeenCalledTimes(1)
    expect(mocks.series.setData).toHaveBeenCalledTimes(1)
    expect(mocks.series.update).toHaveBeenCalledWith(next[0])
    expect(mocks.timeScale.setVisibleRange).toHaveBeenCalledTimes(1)
    expect(mocks.timeScale.scrollToRealTime).not.toHaveBeenCalled()
  })

  it('sets the initial 15-minute range once and preserves it during updates', () => {
    const initial = [candlestick(1704067200, 100)]
    const { rerender } = renderChart(initial)

    rerender(<PriceChart data={[...initial, candlestick(1704067260, 101)]} />)

    expect(mocks.timeScale.setVisibleRange).toHaveBeenCalledTimes(1)
    expect(mocks.series.update).toHaveBeenCalledWith(
      candlestick(1704067260, 101),
    )
  })

  it('updates an appended candle without resetting the visible range', () => {
    const initial = [candlestick(1704067200, 100)]
    const { rerender } = renderChart(initial)
    const next = [...initial, candlestick(1704067260, 99)]

    rerender(<PriceChart data={next} />)

    expect(mocks.series.setData).toHaveBeenCalledTimes(1)
    expect(mocks.series.update).toHaveBeenCalledWith(next[1])
    expect(mocks.timeScale.setVisibleRange).toHaveBeenCalledTimes(1)
    expect(mocks.timeScale.scrollToRealTime).not.toHaveBeenCalled()
  })

  it('replaces the series when historical data changes', () => {
    const { rerender } = renderChart([
      candlestick(1704067200, 100),
      candlestick(1704067260, 101),
    ])
    const next = [candlestick(1704067200, 98), candlestick(1704067260, 101)]

    rerender(<PriceChart data={next} />)

    expect(mocks.series.setData).toHaveBeenLastCalledWith(next)
    expect(mocks.series.setData).toHaveBeenCalledTimes(2)
    expect(mocks.series.update).not.toHaveBeenCalled()
    expect(mocks.timeScale.setVisibleRange).toHaveBeenCalledTimes(1)
    expect(mocks.timeScale.scrollToRealTime).not.toHaveBeenCalled()
  })

  it('removes the chart when data becomes empty', () => {
    const { rerender } = renderChart([candlestick(1704067200, 100)])

    rerender(<PriceChart data={[]} />)

    expect(mocks.chart.remove).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent(
      'No hay datos de gráfico disponibles.',
    )
  })

  it('releases chart resources on unmount', () => {
    const { unmount } = renderChart([candlestick(1704067200, 100)])

    unmount()

    expect(mocks.chart.remove).toHaveBeenCalledTimes(1)
  })
})
