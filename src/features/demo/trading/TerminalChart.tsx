import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
} from 'lightweight-charts'
import type {
  IChartApi,
  ISeriesApi,
  SeriesMarker,
  Time,
} from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import type {
  DemoCandle,
  DemoDecision,
  DemoPosition,
  DemoTrade,
} from './types.ts'
import { bucketForEvent, type TerminalInterval } from './terminal-model.ts'

type Props = {
  candles: readonly DemoCandle[]
  decisions: readonly DemoDecision[]
  positions: readonly DemoPosition[]
  trades: readonly DemoTrade[]
  selectedId: string
  interval: TerminalInterval
  onBucketSelect: (time: number) => void
}

export default function TerminalChart({
  candles,
  decisions,
  positions,
  trades,
  selectedId,
  interval,
  onBucketSelect,
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
  const callbacks = useRef({ onBucketSelect, decisions, interval })
  const selectionData = useRef({ candles, decisions, interval })
  const fitted = useRef(false)

  useEffect(() => {
    callbacks.current = { onBucketSelect, decisions, interval }
    selectionData.current = { candles, decisions, interval }
  }, [onBucketSelect, decisions, interval, candles])

  useEffect(() => {
    const node = container.current
    if (!node) return
    const chart = createChart(node, {
      autoSize: true,
      layout: {
        background: { color: '#171c20' },
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
    const candlesSeries = chart.addSeries(CandlestickSeries, {
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
    const markerApi = createSeriesMarkers(candlesSeries, [])
    const handleClick = (
      param: Parameters<typeof chart.subscribeClick>[0] extends (
        arg: infer P,
      ) => unknown
        ? P
        : never,
    ) => {
      const objectId = param.hoveredInfo?.objectId ?? param.hoveredObjectId
      if (typeof objectId === 'string') {
        const event = callbacks.current.decisions.find(
          (item) => item.id === objectId,
        )
        if (event)
          callbacks.current.onBucketSelect(
            bucketForEvent(
              event.time,
              callbacks.current.interval === '1m'
                ? 60
                : callbacks.current.interval === '5m'
                  ? 300
                  : callbacks.current.interval === '15m'
                    ? 900
                    : 3600,
            ),
          )
      } else if (typeof param.time === 'number')
        callbacks.current.onBucketSelect(param.time)
    }
    chart.subscribeClick(handleClick)
    const observer = new ResizeObserver(() =>
      chart.applyOptions({
        width: node.clientWidth,
        height: node.clientHeight,
      }),
    )
    observer.observe(node)
    chartRef.current = chart
    candleSeriesRef.current = candlesSeries
    volumeRef.current = volume
    markerRef.current = markerApi
    return () => {
      observer.disconnect()
      chart.unsubscribeClick(handleClick)
      priceLines.current.forEach((line) => candlesSeries.removePriceLine(line))
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
    if (!series || candles.length === 0) return
    const timeScale = chartRef.current?.timeScale()
    const visibleRange = fitted.current
      ? timeScale?.getVisibleLogicalRange()
      : null
    // Full replacement also applies corrections to older candles with an unchanged first timestamp.
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
      chartRef.current?.timeScale().fitContent()
      fitted.current = true
    } else if (visibleRange) timeScale?.setVisibleLogicalRange(visibleRange)
  }, [candles])

  useEffect(() => {
    const intervalSeconds =
      interval === '1m'
        ? 60
        : interval === '5m'
          ? 300
          : interval === '15m'
            ? 900
            : 3600
    const markers: SeriesMarker<Time>[] = decisions.map((event) => ({
      time: bucketForEvent(event.time, intervalSeconds) as Time,
      position:
        event.kind === 'entry' && event.direction === 'long'
          ? 'belowBar'
          : 'aboveBar',
      color:
        event.kind === 'discard'
          ? '#d4aa62'
          : event.kind === 'exit'
            ? '#79a9bd'
            : event.direction === 'short'
              ? '#ee7777'
              : '#55c7a2',
      shape:
        event.kind === 'discard'
          ? 'square'
          : event.kind === 'exit'
            ? 'circle'
            : event.direction === 'short'
              ? 'arrowDown'
              : 'arrowUp',
      text: `${event.kind === 'discard' ? 'DESC' : event.kind === 'exit' ? 'SAL' : event.direction === 'short' ? 'CORTO' : 'LARGO'}${selectedId === event.id ? ' ◀' : ''}`,
      id: event.id,
      size: selectedId === event.id ? 2 : 1,
    }))
    markerRef.current?.setMarkers(markers)
  }, [decisions, selectedId, interval])

  useEffect(() => {
    const series = candleSeriesRef.current
    if (!series) return
    priceLines.current.forEach((line) => series.removePriceLine(line))
    priceLines.current = []
    const decision = decisions.find((event) => event.id === selectedId)
    if (!decision?.positionId) return
    const levels =
      positions.find((position) => position.id === decision.positionId) ??
      trades.find((trade) => trade.positionId === decision.positionId)
    if (!levels) return
    priceLines.current = [
      series.createPriceLine({
        price: levels.stopEur,
        color: '#ee7777',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'STOP',
      }),
      series.createPriceLine({
        price: levels.targetEur,
        color: '#55c7a2',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'OBJETIVO',
      }),
    ]
  }, [decisions, positions, trades, selectedId])

  useEffect(() => {
    const {
      candles: currentCandles,
      decisions: currentDecisions,
      interval: currentInterval,
    } = selectionData.current
    const event = currentDecisions.find((item) => item.id === selectedId)
    if (!event) return
    const bucket = bucketForEvent(
      event.time,
      currentInterval === '1m'
        ? 60
        : currentInterval === '5m'
          ? 300
          : currentInterval === '15m'
            ? 900
            : 3600,
    )
    const index = currentCandles.findIndex((candle) => candle.time === bucket)
    if (index >= 0)
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from: Math.max(0, index - 30),
        to: index + 30,
      })
  }, [selectedId, interval])

  const present = () => chartRef.current?.timeScale().scrollToRealTime()

  return (
    <>
      <div
        ref={container}
        className="demo-terminal__chart"
        role="img"
        aria-label="Gráfico ilustrativo de velas BTC/EUR con volumen; cada decisión está descrita y es seleccionable en la lista accesible"
      />
      <button
        className="demo-terminal__present"
        type="button"
        onClick={present}
      >
        Volver al presente
      </button>
    </>
  )
}
