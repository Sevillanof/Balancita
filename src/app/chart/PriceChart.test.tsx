import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { CandlestickData } from 'lightweight-charts'
import PriceChart from './PriceChart'

const mocks = vi.hoisted(() => {
  const series = {
    setData: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    applyOptions: vi.fn(),
  }
  const timeScale = {
    fitContent: vi.fn(),
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
    chart,
    series,
    timeScale,
    reset() {
      createChart.mockClear()
      chart.addSeries.mockClear()
      series.setData.mockClear()
      series.update.mockClear()
      chart.timeScale.mockClear()
      timeScale.fitContent.mockClear()
      timeScale.scrollToRealTime.mockClear()
      chart.remove.mockClear()
    },
  }
})

vi.mock('lightweight-charts', () => ({
  createChart: mocks.createChart,
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
    expect(mocks.timeScale.fitContent).toHaveBeenCalledTimes(1)
    expect(mocks.timeScale.scrollToRealTime).not.toHaveBeenCalled()
  })

  it('updates the current candle without recentering the viewport', () => {
    const { rerender } = renderChart([candlestick(1704067200, 100)])

    const next = [candlestick(1704067200, 99)]
    rerender(<PriceChart data={next} />)

    expect(mocks.createChart).toHaveBeenCalledTimes(1)
    expect(mocks.series.setData).toHaveBeenCalledTimes(1)
    expect(mocks.series.update).toHaveBeenCalledWith(next[0])
    expect(mocks.timeScale.fitContent).toHaveBeenCalledTimes(1)
    expect(mocks.timeScale.scrollToRealTime).not.toHaveBeenCalled()
  })

  it('updates an appended candle without resetting the visible range', () => {
    const initial = [candlestick(1704067200, 100)]
    const { rerender } = renderChart(initial)
    const next = [...initial, candlestick(1704067260, 99)]

    rerender(<PriceChart data={next} />)

    expect(mocks.series.setData).toHaveBeenCalledTimes(1)
    expect(mocks.series.update).toHaveBeenCalledWith(next[1])
    expect(mocks.timeScale.fitContent).toHaveBeenCalledTimes(1)
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
    expect(mocks.timeScale.fitContent).toHaveBeenCalledTimes(1)
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
