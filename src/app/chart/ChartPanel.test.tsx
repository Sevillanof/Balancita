import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Quote } from '../../domain/market-data'
import { makeCandle } from '../../test/fake-market-data-provider'
import { toCandlestickDataset } from './candlestick-data'
import ChartPanel from './ChartPanel'

const mocks = vi.hoisted(() => {
  const series = { setData: vi.fn() }
  const chart = { addSeries: vi.fn(() => series), remove: vi.fn() }
  const createChart = vi.fn()
  return {
    createChart,
    chart,
    series,
    reset() {
      createChart.mockClear()
      chart.addSeries.mockClear()
      chart.remove.mockClear()
      series.setData.mockClear()
    },
  }
})

vi.mock('lightweight-charts', () => ({
  ColorType: { Solid: 'solid' },
  CandlestickSeries: {},
  createChart: (...args: unknown[]) => mocks.createChart(...args),
}))

mocks.createChart.mockReturnValue(mocks.chart)

describe('ChartPanel', () => {
  beforeEach(() => {
    mocks.reset()
  })

  it('renders the BTC-EUR chart without redundant headings', () => {
    render(
      <ChartPanel
        status="ready"
        candles={[makeCandle({ time: '2024-01-01T00:00:00.000Z' })]}
        onRetry={() => {}}
      />,
    )

    expect(
      screen.getByRole('region', { name: 'Gráfico BTC-EUR' }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('heading', { name: 'BTC-EUR' }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('Gráfico dominante')).not.toBeInTheDocument()
    expect(screen.queryByText('Velas BTC-EUR (mock)')).not.toBeInTheDocument()
    expect(screen.getByTestId('price-chart')).toBeInTheDocument()
  })

  it('shows a loading state', () => {
    render(<ChartPanel status="loading" candles={[]} onRetry={() => {}} />)

    expect(screen.getByRole('status')).toHaveTextContent('Cargando velas')
  })

  it('shows an empty state', () => {
    render(<ChartPanel status="empty" candles={[]} onRetry={() => {}} />)

    expect(screen.getByRole('status')).toHaveTextContent(
      'No hay velas BTC-EUR disponibles',
    )
  })

  it('shows an error state with a retry control', async () => {
    const onRetry = vi.fn()
    render(<ChartPanel status="error" candles={[]} onRetry={onRetry} />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'No se pudo cargar el gráfico BTC-EUR',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('keeps live freshness visible inside the chart area', () => {
    const quote: Quote = {
      instrumentId: 'BTC-EUR',
      price: 62_000,
      change: 100,
      changePercent: 0.16,
      timestamp: '2026-09-20T12:00:00.000Z',
      status: 'live',
      eventTime: '2026-09-20T12:00:00.000Z',
      receivedTime: '2026-09-20T12:00:01.000Z',
      displayTime: '2026-09-20T12:00:01.000Z',
      freshnessAgeMs: 1000,
      freshnessIsStale: false,
    }

    render(
      <ChartPanel
        status="ready"
        candles={[makeCandle()]}
        quote={quote}
        onRetry={() => {}}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Mercado en vivo')
    expect(screen.getByRole('status')).toHaveTextContent('1 s')
  })

  it('passes the latest provisional candle to the chart edge', () => {
    const closed = makeCandle({
      time: '2024-01-01T00:00:00.000Z',
      isClosed: true,
    })
    const provisional = makeCandle({
      time: '2024-01-01T00:01:00.000Z',
      close: 106,
      isClosed: false,
    })

    render(
      <ChartPanel
        status="ready"
        candles={[closed, provisional]}
        onRetry={() => {}}
      />,
    )

    expect(mocks.series.setData).toHaveBeenCalledWith(
      toCandlestickDataset([closed, provisional]),
    )
    expect(mocks.series.setData).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ time: 1704067260, close: 106 }),
      ]),
    )
  })

  it('shows stale degradation without changing the chart state', () => {
    render(
      <ChartPanel
        status="ready"
        candles={[makeCandle()]}
        quote={{
          instrumentId: 'BTC-EUR',
          price: 62_000,
          change: 0,
          changePercent: 0,
          timestamp: '2026-09-20T12:00:00.000Z',
          status: 'stale',
          freshnessIsStale: true,
          freshnessAgeMs: 16_000,
        }}
        onRetry={() => {}}
      />,
    )

    expect(screen.getByRole('status')).toHaveTextContent('Mercado stale')
    expect(screen.getByTestId('price-chart')).toBeInTheDocument()
    expect(mocks.series.setData).toHaveBeenLastCalledWith(
      expect.arrayContaining([expect.objectContaining({ close: 62_000 })]),
    )
  })
})
