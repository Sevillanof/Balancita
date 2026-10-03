import { useEffect, useRef } from 'react'
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts'

export type ApprovedTerminalCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type ApprovedTerminalMarker = {
  id: string
  time: number
  type: 'entry' | 'exit' | 'discard' | 'decision'
  direction?: 'long' | 'short' | 'flat'
  label: string
  positionId?: string | null
  decisionStatus?: 'pending' | 'hold' | 'gate-rejected' | 'abstained'
}

export type ApprovedTerminalLevel = {
  positionId: string
  stop: number
  target: number
}

type Props = {
  candles: readonly ApprovedTerminalCandle[]
  markers: readonly ApprovedTerminalMarker[]
  selectedId: string
  intervalSeconds: number
  currency?: 'EUR' | 'USD'
  instrument?: string
  levels?: readonly ApprovedTerminalLevel[]
  initialViewport?: 'approved-terminal'
  onSelect: (time: number, markerId?: string) => void
  ariaLabel?: string
}

function cssColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  )
}

function markerPresentation(
  marker: ApprovedTerminalMarker,
  colors: { up: string; down: string; amber: string; info: string },
) {
  if (marker.type === 'discard')
    return {
      color: colors.amber,
      shape: 'square' as const,
      position: 'aboveBar' as const,
    }
  if (marker.type === 'exit')
    return {
      color: colors.info,
      shape: 'circle' as const,
      position: 'aboveBar' as const,
    }
  if (marker.type === 'decision')
    return marker.decisionStatus === 'gate-rejected'
      ? {
          color: colors.amber,
          shape: 'square' as const,
          position: 'aboveBar' as const,
        }
      : {
          color: colors.info,
          shape: 'circle' as const,
          position: 'aboveBar' as const,
        }
  return marker.direction === 'short'
    ? {
        color: colors.down,
        shape: 'arrowDown' as const,
        position: 'aboveBar' as const,
      }
    : {
        color: colors.up,
        shape: 'arrowUp' as const,
        position: 'belowBar' as const,
      }
}

export default function ApprovedTerminalChart({
  candles,
  markers,
  selectedId,
  intervalSeconds,
  currency = 'EUR',
  instrument = 'BTC/EUR',
  levels = [],
  initialViewport,
  onSelect,
  ariaLabel,
}: Props) {
  const container = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const markerRef = useRef<ReturnType<typeof createSeriesMarkers<Time>> | null>(
    null,
  )
  const priceLines = useRef<
    ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>[]
  >([])
  const fitted = useRef(false)
  const focusedSelection = useRef<string | null>(null)
  const renderedCandles = useRef<readonly ApprovedTerminalCandle[] | null>(null)
  const renderedInterval = useRef<number | null>(null)
  const propsRef = useRef({ candles, markers, intervalSeconds, onSelect })

  useEffect(() => {
    propsRef.current = { candles, markers, intervalSeconds, onSelect }
  }, [candles, markers, intervalSeconds, onSelect])

  useEffect(() => {
    const node = container.current
    if (!node) return
    const colors = {
      background: cssColor('--card', '#171c20'),
      text: cssColor('--muted-foreground', '#8b969a'),
      grid: cssColor('--border', '#252d31'),
      up: cssColor('--chart-up', '#55c7a2'),
      down: cssColor('--chart-down', '#ee7777'),
      amber: cssColor('--warning', '#d4aa62'),
      info: cssColor('--info', '#79a9bd'),
    }
    const chart = createChart(node, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: colors.background },
        textColor: colors.text,
        fontFamily: 'IBM Plex Mono, monospace',
        ...(initialViewport === 'approved-terminal' ? { fontSize: 11 } : {}),
        attributionLogo: true,
      },
      ...(initialViewport === 'approved-terminal'
        ? { localization: { locale: 'es-ES' } }
        : {}),
      grid: {
        vertLines: {
          color: colors.grid,
          ...(initialViewport === 'approved-terminal'
            ? { style: 2 as const }
            : {}),
        },
        horzLines: {
          color: colors.grid,
          ...(initialViewport === 'approved-terminal'
            ? { style: 2 as const }
            : {}),
        },
      },
      ...(initialViewport === 'approved-terminal'
        ? {
            crosshair: {
              vertLine: {
                color: colors.info,
                labelBackgroundColor: colors.grid,
              },
              horzLine: {
                color: colors.info,
                labelBackgroundColor: colors.grid,
              },
            },
          }
        : {}),
      rightPriceScale: {
        borderColor: colors.grid,
        scaleMargins: { top: 0.12, bottom: 0.22 },
      },
      timeScale: {
        borderColor: colors.grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
        ...(initialViewport === 'approved-terminal' ? { barSpacing: 8 } : {}),
      },
      handleScroll: true,
      handleScale: true,
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderVisible: false,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
      priceFormat:
        initialViewport === 'approved-terminal'
          ? {
              type: 'custom',
              minMove: 0.01,
              formatter: (price: number) =>
                new Intl.NumberFormat('es-ES', {
                  style: 'currency',
                  currency,
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                }).format(price),
            }
          : { type: 'price', precision: 2, minMove: 0.01 },
    })
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    })
    volume
      .priceScale()
      .applyOptions({ scaleMargins: { top: 0.83, bottom: 0.02 } })
    const markerApi = createSeriesMarkers(series, [])
    const handleClick = (
      param: Parameters<typeof chart.subscribeClick>[0] extends (
        arg: infer P,
      ) => unknown
        ? P
        : never,
    ) => {
      const objectId = param.hoveredInfo?.objectId ?? param.hoveredObjectId
      const state = propsRef.current
      if (typeof objectId === 'string') {
        const marker = state.markers.find((item) => item.id === objectId)
        if (marker)
          state.onSelect(
            Math.floor(marker.time / state.intervalSeconds) *
              state.intervalSeconds,
            marker.id,
          )
      } else if (typeof param.time === 'number') {
        state.onSelect(param.time)
      }
    }
    chart.subscribeClick(handleClick)
    chartRef.current = chart
    candleSeriesRef.current = series
    volumeRef.current = volume
    markerRef.current = markerApi
    return () => {
      chart.unsubscribeClick(handleClick)
      priceLines.current.forEach((line) => series.removePriceLine(line))
      priceLines.current = []
      chart.remove()
      chartRef.current = null
      candleSeriesRef.current = null
      volumeRef.current = null
      markerRef.current = null
      fitted.current = false
      focusedSelection.current = null
      renderedCandles.current = null
      renderedInterval.current = null
    }
  }, [currency, initialViewport])

  useEffect(() => {
    const series = candleSeriesRef.current
    if (!series) return
    const timeScale = chartRef.current?.timeScale()
    const volumeUpColor = cssColor('--chart-volume-up', '#285d50')
    const volumeDownColor = cssColor('--chart-volume-down', '#653f42')
    const previous = renderedCandles.current
    const rebuild =
      previous === null ||
      renderedInterval.current !== intervalSeconds ||
      candles.length < previous.length ||
      previous.some((candle, index) => {
        if (index === previous.length - 1) return false
        const next = candles[index]
        return (
          !next ||
          next.time !== candle.time ||
          next.open !== candle.open ||
          next.high !== candle.high ||
          next.low !== candle.low ||
          next.close !== candle.close ||
          next.volume !== candle.volume
        )
      })
    const visibleRange =
      rebuild && fitted.current ? timeScale?.getVisibleLogicalRange() : null
    const pricePoint = (candle: ApprovedTerminalCandle) => ({
      time: candle.time as Time,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
    })
    const volumePoint = (candle: ApprovedTerminalCandle) => ({
      time: candle.time as Time,
      value: candle.volume,
      color: candle.close >= candle.open ? volumeUpColor : volumeDownColor,
    })
    if (rebuild) {
      series.setData(candles.map(pricePoint))
      volumeRef.current?.setData(candles.map(volumePoint))
      renderedInterval.current = intervalSeconds
    } else if (candles.length > 0 && previous !== null) {
      const firstUpdate = Math.max(0, previous.length - 1)
      for (const candle of candles.slice(firstUpdate)) {
        series.update(pricePoint(candle))
        volumeRef.current?.update(volumePoint(candle))
      }
    }
    renderedCandles.current = candles
    if (!fitted.current) {
      if (candles.length) {
        if (initialViewport === 'approved-terminal')
          chartRef.current?.timeScale().setVisibleLogicalRange({
            from: Math.max(0, candles.length - 67),
            to: candles.length + 6,
          })
        else chartRef.current?.timeScale().fitContent()
      }
      fitted.current = candles.length > 0
    } else if (visibleRange) timeScale?.setVisibleLogicalRange(visibleRange)
  }, [candles, intervalSeconds, initialViewport])

  useEffect(() => {
    const candleTimes = new Set(candles.map((candle) => candle.time))
    const markerColors = {
      up: cssColor('--chart-up', '#55c7a2'),
      down: cssColor('--chart-down', '#ee7777'),
      amber: cssColor('--warning', '#d4aa62'),
      info: cssColor('--info', '#79a9bd'),
    }
    const visibleMarkers: SeriesMarker<Time>[] = [...markers]
      .sort((left, right) => left.time - right.time)
      .flatMap((marker) => {
        const bucket =
          Math.floor(marker.time / intervalSeconds) * intervalSeconds
        if (!candleTimes.has(bucket)) return []
        const appearance = markerPresentation(marker, markerColors)
        return [
          {
            time: bucket as Time,
            position: appearance.position,
            color: appearance.color,
            shape: appearance.shape,
            text: `${marker.label}${selectedId === marker.id ? ' ◀' : ''}`,
            id: marker.id,
            size: selectedId === marker.id ? 2 : 1,
          },
        ]
      })
    markerRef.current?.setMarkers(
      visibleMarkers
        .sort((left, right) => Number(left.time) - Number(right.time))
        .slice(-200),
    )
  }, [candles, markers, selectedId, intervalSeconds, initialViewport])

  useEffect(() => {
    const series = candleSeriesRef.current
    if (!series) return
    priceLines.current.forEach((line) => series.removePriceLine(line))
    priceLines.current = []
    const selected = markers.find((marker) => marker.id === selectedId)
    if (!selected?.positionId) return
    const position = levels.find(
      (item) => item.positionId === selected.positionId,
    )
    if (!position) return
    priceLines.current = [
      series.createPriceLine({
        price: position.stop,
        color: '#ee7777',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'STOP',
      }),
      series.createPriceLine({
        price: position.target,
        color: '#55c7a2',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'OBJETIVO',
      }),
    ]
  }, [markers, levels, selectedId, initialViewport])

  useEffect(() => {
    const selected = markers.find((marker) => marker.id === selectedId)
    if (!selected) return
    const bucket = Math.floor(selected.time / intervalSeconds) * intervalSeconds
    const index = candles.findIndex((candle) => candle.time === bucket)
    const selectionKey = `${selectedId}:${intervalSeconds}:${bucket}`
    if (index >= 0 && focusedSelection.current !== selectionKey) {
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from: Math.max(0, index - 30),
        to: index + 30,
      })
      focusedSelection.current = selectionKey
    }
  }, [markers, selectedId, intervalSeconds, candles, initialViewport])

  return (
    <>
      <div
        ref={container}
        data-testid="approved-chart-renderer"
        data-candle-count={candles.length}
        data-marker-count={markers.length}
        className="demo-terminal__chart"
        role="img"
        aria-label={
          ariaLabel ??
          `Gráfico de velas ${instrument} con volumen; las decisiones del backend se describen y seleccionan en el panel lateral`
        }
      />
      <button
        className="demo-terminal__present"
        type="button"
        onClick={() => chartRef.current?.timeScale().scrollToRealTime()}
      >
        Volver al presente
      </button>
    </>
  )
}
