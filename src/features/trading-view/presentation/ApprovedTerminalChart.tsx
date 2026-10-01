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
  levels?: readonly ApprovedTerminalLevel[]
  onSelect: (time: number, markerId?: string) => void
  ariaLabel?: string
}

function markerPresentation(marker: ApprovedTerminalMarker) {
  if (marker.type === 'discard')
    return {
      color: '#d4aa62',
      shape: 'square' as const,
      position: 'aboveBar' as const,
    }
  if (marker.type === 'exit')
    return {
      color: '#79a9bd',
      shape: 'circle' as const,
      position: 'aboveBar' as const,
    }
  if (marker.type === 'decision')
    return marker.decisionStatus === 'gate-rejected'
      ? {
          color: '#d4aa62',
          shape: 'square' as const,
          position: 'aboveBar' as const,
        }
      : {
          color: '#79a9bd',
          shape: 'circle' as const,
          position: 'aboveBar' as const,
        }
  return marker.direction === 'short'
    ? {
        color: '#ee7777',
        shape: 'arrowDown' as const,
        position: 'aboveBar' as const,
      }
    : {
        color: '#55c7a2',
        shape: 'arrowUp' as const,
        position: 'belowBar' as const,
      }
}

export default function ApprovedTerminalChart({
  candles,
  markers,
  selectedId,
  intervalSeconds,
  levels = [],
  onSelect,
  ariaLabel = 'Gráfico de velas BTC/EUR con volumen; las decisiones del backend se describen y seleccionan en el panel lateral',
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
  const propsRef = useRef({ candles, markers, intervalSeconds, onSelect })

  useEffect(() => {
    propsRef.current = { candles, markers, intervalSeconds, onSelect }
  }, [candles, markers, intervalSeconds, onSelect])

  useEffect(() => {
    const node = container.current
    if (!node) return
    const chart = createChart(node, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#171c20' },
        textColor: '#8b969a',
        fontFamily: 'IBM Plex Mono, monospace',
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: '#252d31' },
        horzLines: { color: '#252d31' },
      },
      rightPriceScale: {
        borderColor: '#303a3e',
        scaleMargins: { top: 0.12, bottom: 0.22 },
      },
      timeScale: {
        borderColor: '#303a3e',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 8,
      },
      handleScroll: true,
      handleScale: true,
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#55c7a2',
      downColor: '#ee7777',
      borderVisible: false,
      wickUpColor: '#55c7a2',
      wickDownColor: '#ee7777',
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
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
    }
  }, [])

  useEffect(() => {
    const series = candleSeriesRef.current
    if (!series) return
    const timeScale = chartRef.current?.timeScale()
    const visibleRange = fitted.current
      ? timeScale?.getVisibleLogicalRange()
      : null
    series.setData(
      candles.map((candle) => ({
        time: candle.time as Time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    )
    volumeRef.current?.setData(
      candles.map((candle) => ({
        time: candle.time as Time,
        value: candle.volume,
        color: candle.close >= candle.open ? '#285d50' : '#653f42',
      })),
    )
    if (!fitted.current) {
      if (candles.length) chartRef.current?.timeScale().fitContent()
      fitted.current = candles.length > 0
    } else if (visibleRange) timeScale?.setVisibleLogicalRange(visibleRange)
  }, [candles])

  useEffect(() => {
    const candleTimes = new Set(candles.map((candle) => candle.time))
    const visibleMarkers: SeriesMarker<Time>[] = markers.flatMap((marker) => {
      const bucket = Math.floor(marker.time / intervalSeconds) * intervalSeconds
      if (!candleTimes.has(bucket)) return []
      const appearance = markerPresentation(marker)
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
    markerRef.current?.setMarkers(visibleMarkers)
  }, [candles, markers, selectedId, intervalSeconds])

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
  }, [markers, levels, selectedId])

  useEffect(() => {
    const selected = markers.find((marker) => marker.id === selectedId)
    if (!selected) return
    const bucket = Math.floor(selected.time / intervalSeconds) * intervalSeconds
    const index = candles.findIndex((candle) => candle.time === bucket)
    if (index >= 0)
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from: Math.max(0, index - 30),
        to: index + 30,
      })
  }, [markers, selectedId, intervalSeconds, candles])

  return (
    <>
      <div
        ref={container}
        data-testid="approved-chart-renderer"
        data-candle-count={candles.length}
        data-marker-count={markers.length}
        className="demo-terminal__chart"
        role="img"
        aria-label={ariaLabel}
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
