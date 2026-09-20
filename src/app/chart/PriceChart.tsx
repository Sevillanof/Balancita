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

const EMPTY_MESSAGE = 'No chart data available.'

type Palette = {
  background: string
  text: string
  muted: string
  grid: string
  up: string
  down: string
}

const LIGHT_PALETTE: Palette = {
  background: '#fafbfc',
  text: '#1f2430',
  muted: '#5b6472',
  grid: 'rgba(31, 36, 48, 0.08)',
  up: '#04724d',
  down: '#b3261e',
}

const DARK_PALETTE: Palette = {
  background: '#10141c',
  text: '#e7eaf0',
  muted: '#98a1b0',
  grid: 'rgba(231, 234, 240, 0.1)',
  up: '#5dd6a3',
  down: '#f28b82',
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

    const palette = prefersDarkMode() ? DARK_PALETTE : LIGHT_PALETTE
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
      aria-label="Price chart"
    />
  )
}
