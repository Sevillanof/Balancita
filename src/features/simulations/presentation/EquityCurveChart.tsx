import { ColorType, LineSeries, createChart } from 'lightweight-charts'
import type { DeepPartial, ChartOptions, LineData } from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import type { SimulationsEquityPoint } from './simulations-types.ts'

type EquityCurveChartProps = {
  readonly candidate: readonly SimulationsEquityPoint[]
  /** Buy-and-hold equity on the same window, for visual comparison. */
  readonly baseline: readonly SimulationsEquityPoint[]
  /** Slice label announced to assistive technology. */
  readonly label: string
}

const EMPTY_MESSAGE = 'Sin datos de rentabilidad para este tramo.'

type Palette = {
  background: string
  text: string
  muted: string
  grid: string
  accent: string
}

const FALLBACK: Palette = {
  background: '#ffffff',
  text: '#172033',
  muted: '#5a6576',
  grid: 'rgba(23, 32, 51, 0.09)',
  accent: '#1d4ed8',
}

function cssVariable(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
  return value || fallback
}

function currentPalette(): Palette {
  return {
    background: cssVariable('--color-surface', FALLBACK.background),
    text: cssVariable('--color-text', FALLBACK.text),
    muted: cssVariable('--color-muted', FALLBACK.muted),
    grid: cssVariable('--color-chart-grid', FALLBACK.grid),
    accent: cssVariable('--color-accent', FALLBACK.accent),
  }
}

function chartOptions(palette: Palette): DeepPartial<ChartOptions> {
  return {
    autoSize: true,
    layout: {
      attributionLogo: true,
      background: { type: ColorType.Solid, color: palette.background },
      textColor: palette.text,
      fontFamily: "system-ui, 'Segoe UI', Roboto, sans-serif",
    },
    grid: {
      vertLines: { color: palette.grid },
      horzLines: { color: palette.grid },
    },
    rightPriceScale: { borderColor: palette.muted },
    timeScale: {
      borderColor: palette.muted,
      timeVisible: true,
      secondsVisible: false,
    },
  }
}

function toLineData(points: readonly SimulationsEquityPoint[]): LineData[] {
  return points.map((point) => ({
    time: Math.floor(point.time / 1000) as LineData['time'],
    value: point.equity,
  }))
}

/**
 * Candidate net equity vs. buy-and-hold on the same window. Read-only and
 * descriptive: it draws the persisted simulation report and never computes
 * or executes anything.
 */
export default function EquityCurveChart({
  candidate,
  baseline,
  label,
}: EquityCurveChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const hasData = candidate.length > 0 || baseline.length > 0

  useEffect(() => {
    if (!hasData) return undefined
    const container = containerRef.current
    if (!container) return undefined

    const palette = currentPalette()
    const chart = createChart(container, chartOptions(palette))
    const candidateSeries = chart.addSeries(LineSeries, {
      color: palette.accent,
      lineWidth: 2,
      priceLineVisible: false,
    })
    const baselineSeries = chart.addSeries(LineSeries, {
      color: palette.muted,
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
    })
    candidateSeries.setData(toLineData(candidate))
    baselineSeries.setData(toLineData(baseline))
    chart.timeScale().fitContent()

    return () => {
      chart.remove()
    }
  }, [hasData, candidate, baseline])

  if (!hasData) {
    return (
      <p className="simulations__chart-empty" role="status">
        {EMPTY_MESSAGE}
      </p>
    )
  }

  return (
    <div
      ref={containerRef}
      data-testid="equity-curve-chart"
      className="simulations__chart"
      role="img"
      aria-label={`Curva de rentabilidad en ${label}: candidata frente a comprar y mantener`}
    />
  )
}
