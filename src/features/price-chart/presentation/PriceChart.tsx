import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
} from 'lightweight-charts'
import type {
  ChartOptions,
  DeepPartial,
  CandlestickData,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
  SeriesMarker,
  Time,
} from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import type { ISeriesMarkersPluginApi } from 'lightweight-charts'
import './chart.css'

type PriceChartProps = {
  data: readonly CandlestickData[]
  markers?: readonly SeriesMarker<Time>[]
}

const EMPTY_MESSAGE = 'No hay datos de gráfico disponibles.'
const INITIAL_VISIBLE_RANGE_SECONDS = 15 * 60

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
    timeScale: {
      borderColor: palette.muted,
      timeVisible: true,
      secondsVisible: false,
    },
  }
}

export default function PriceChart({ data, markers = [] }: PriceChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const previousDataRef = useRef<readonly CandlestickData[] | null>(null)
  const markerPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null)
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
    chartRef.current = chart
    seriesRef.current = series
    previousDataRef.current = null

    return () => {
      chartRef.current = null
      seriesRef.current = null
      markerPluginRef.current?.detach()
      markerPluginRef.current = null
      previousDataRef.current = null
      chart.remove()
    }
  }, [hasData])

  useEffect(() => {
    const series = seriesRef.current
    const chart = chartRef.current
    if (!series || !chart) return

    const previousData = previousDataRef.current
    if (previousData === null) {
      series.setData([...data])
      const latestTime = data.at(-1)?.time
      const timeScale = chart.timeScale()
      if (
        typeof latestTime === 'number' &&
        typeof timeScale.setVisibleRange === 'function'
      ) {
        timeScale.setVisibleRange({
          from: (latestTime - INITIAL_VISIBLE_RANGE_SECONDS) as UTCTimestamp,
          to: latestTime as UTCTimestamp,
        })
      } else {
        chart.timeScale().fitContent()
      }
      previousDataRef.current = [...data]
      return
    }

    if (sameDataset(previousData, data)) return

    const previousLast = previousData.at(-1)
    const nextLast = data.at(-1)
    const sameHistory = previousData.every((candle, index) =>
      sameCandle(candle, data[index]),
    )
    const sameHistoryExceptLast = previousData
      .slice(0, -1)
      .every((candle, index) => sameCandle(candle, data[index]))
    const canUpdateCurrent =
      data.length === previousData.length &&
      previousLast !== undefined &&
      nextLast !== undefined &&
      previousLast.time === nextLast.time &&
      sameHistoryExceptLast
    const canAppend = data.length === previousData.length + 1 && sameHistory

    if (canUpdateCurrent || canAppend) {
      series.update(nextLast!)
    } else {
      series.setData([...data])
    }
    previousDataRef.current = [...data]
  }, [data])

  useEffect(() => {
    const series = seriesRef.current
    if (!series || (markerPluginRef.current === null && markers.length === 0))
      return
    if (markerPluginRef.current === null)
      markerPluginRef.current = createSeriesMarkers(series, [...markers])
    else markerPluginRef.current.setMarkers([...markers])
  }, [markers])

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

function sameDataset(
  left: readonly CandlestickData[],
  right: readonly CandlestickData[],
): boolean {
  return (
    left.length === right.length &&
    left.every((candle, index) => sameCandle(candle, right[index]))
  )
}

function sameCandle(
  left: CandlestickData,
  right: CandlestickData | undefined,
): boolean {
  return (
    right !== undefined &&
    left.time === right.time &&
    left.open === right.open &&
    left.high === right.high &&
    left.low === right.low &&
    left.close === right.close
  )
}
