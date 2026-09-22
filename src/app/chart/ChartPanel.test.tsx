import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeCandle } from '../../test/fake-market-data-provider'
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
})
