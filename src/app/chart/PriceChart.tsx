import { CandlestickSeries, ColorType, createChart } from 'lightweight-charts'
import type {
  ChartOptions,
  DeepPartial,
  CandlestickData,
  ISeriesApi,
} from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import './chart.css'

type PriceChartProps = {
  data: readonly CandlestickData[]
}

const EMPTY_MESSAGE = 'No hay datos de gráfico disponibles.'

type Palette = {
  background: string
  text: string
  muted: string
  grid: string
  up: string
  down: string
}

const LIGHT_FALLBACK: Palette = {
  background: '#ffffff',
  text: '#172033',
  muted: '#5a6576',
  grid: 'rgba(23, 32, 51, 0.09)',
  up: '#13795b',
  down: '#b42318',
}

const DARK_FALLBACK: Palette = {
  background: '#171e2a',
  text: '#edf2f7',
  muted: '#aab6c5',
  grid: 'rgba(237, 242, 247, 0.11)',
  up: '#69d3a6',
  down: '#ff9b91',
}

function prefersDarkMode(): boolean {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return false
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches
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
  const fallback = prefersDarkMode() ? DARK_FALLBACK : LIGHT_FALLBACK
  return {
    background: cssVariable('--color-surface', fallback.background),
    text: cssVariable('--color-text', fallback.text),
    muted: cssVariable('--color-muted', fallback.muted),
    grid: cssVariable('--color-chart-grid', fallback.grid),
    up: cssVariable('--color-success', fallback.up),
    down: cssVariable('--color-danger', fallback.down),
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
    timeScale: { borderColor: palette.muted },
  }
}

export default function PriceChart({ data }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const hasData = data.length > 0

  useEffect(() => {
    if (!hasData) return undefined
    const container = containerRef.current
    if (!container) return undefined

    const palette = currentPalette()
    const chart = createChart(container, chartOptions(palette))
    const series = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.down,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
      borderVisible: false,
    })
    seriesRef.current = series

    return () => {
      seriesRef.current = null
      chart.remove()
    }
  }, [hasData])

  useEffect(() => {
    seriesRef.current?.setData([...data])
  }, [data])

  if (!hasData) {
    return (
      <p className="chart__empty" role="status">
        {EMPTY_MESSAGE}
      </p>
    )
  }

  return (
    <div
      ref={containerRef}
      data-testid="price-chart"
      className="chart__container"
      role="img"
      aria-label="Gráfico de precio"
    />
  )
}
