import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import EquityCurveChart from './EquityCurveChart'

const mocks = vi.hoisted(() => {
  const candidateSeries = {
    setData: vi.fn(),
    applyOptions: vi.fn(),
  }
  const baselineSeries = {
    setData: vi.fn(),
    applyOptions: vi.fn(),
  }
  const createdSeries = [candidateSeries, baselineSeries]
  let seriesIndex = 0
  const timeScale = { fitContent: vi.fn() }
  const chart = {
    addSeries: vi.fn(() => createdSeries[seriesIndex++ % 2]),
    timeScale: vi.fn(() => timeScale),
    remove: vi.fn(),
  }
  const createChart = vi.fn(() => chart)
  return {
    LineSeries: { kind: 'line' },
    createChart,
    chart,
    timeScale,
    candidateSeries,
    baselineSeries,
    reset() {
      seriesIndex = 0
      createChart.mockClear()
      chart.addSeries.mockClear()
      chart.timeScale.mockClear()
      timeScale.fitContent.mockClear()
      chart.remove.mockClear()
      candidateSeries.setData.mockClear()
      baselineSeries.setData.mockClear()
    },
  }
})

vi.mock('lightweight-charts', () => ({
  createChart: mocks.createChart,
  LineSeries: mocks.LineSeries,
  ColorType: { Solid: 'solid' },
}))

const CANDIDATE = [
  { time: 1_700_000_060_000, equity: 10_000 },
  { time: 1_700_000_120_000, equity: 10_500 },
]

const BASELINE = [
  { time: 1_700_000_060_000, equity: 10_000 },
  { time: 1_700_000_120_000, equity: 10_200 },
]

describe('EquityCurveChart', () => {
  beforeEach(() => {
    mocks.reset()
  })

  it('shows an empty state without touching the chart library', () => {
    render(<EquityCurveChart candidate={[]} baseline={[]} label="Validación" />)
    expect(screen.getByRole('status')).toHaveTextContent(
      /sin datos de rentabilidad/i,
    )
    expect(mocks.createChart).not.toHaveBeenCalled()
  })

  it('draws candidate equity against buy-and-hold on the same window', () => {
    render(
      <EquityCurveChart
        candidate={CANDIDATE}
        baseline={BASELINE}
        label="Validación"
      />,
    )
    const chart = screen.getByRole('img', {
      name: /curva de rentabilidad.*validación/i,
    })
    expect(chart).toBeInTheDocument()
    expect(mocks.createChart).toHaveBeenCalledTimes(1)
    // One line series per leg: candidate net equity + buy-and-hold.
    expect(mocks.chart.addSeries).toHaveBeenCalledTimes(2)
    expect(mocks.chart.addSeries).toHaveBeenNthCalledWith(
      1,
      mocks.LineSeries,
      expect.anything(),
    )
    expect(mocks.candidateSeries.setData).toHaveBeenCalledWith([
      { time: 1_700_000_060, value: 10_000 },
      { time: 1_700_000_120, value: 10_500 },
    ])
    expect(mocks.baselineSeries.setData).toHaveBeenCalledWith([
      { time: 1_700_000_060, value: 10_000 },
      { time: 1_700_000_120, value: 10_200 },
    ])
    expect(mocks.timeScale.fitContent).toHaveBeenCalledTimes(1)
  })

  it('removes the chart on unmount', () => {
    const { unmount } = render(
      <EquityCurveChart
        candidate={CANDIDATE}
        baseline={BASELINE}
        label="Selección"
      />,
    )
    unmount()
    expect(mocks.chart.remove).toHaveBeenCalledTimes(1)
  })
})
