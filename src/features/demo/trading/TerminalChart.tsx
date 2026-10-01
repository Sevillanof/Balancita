import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
} from 'lightweight-charts'
import type { SeriesMarker, Time } from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import type { DemoCandle, DemoDecision } from './types.ts'

type Props = {
  candles: readonly DemoCandle[]
  decisions: readonly DemoDecision[]
}

export default function TerminalChart({ candles, decisions }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const latest = useRef({ candles, decisions })
  const redraw = useRef<(() => void) | null>(null)

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
    const observer = new ResizeObserver(() =>
      chart.applyOptions({
        width: node.clientWidth,
        height: node.clientHeight,
      }),
    )
    observer.observe(node)
    const update = () => {
      const { candles: current, decisions: events } = latest.current
      candlesSeries.setData(
        current.map((candle) => ({
          time: candle.time as Time,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
        })),
      )
      volume.setData(
        current.map((candle) => ({
          time: candle.time as Time,
          value: candle.volume,
          color: candle.close >= candle.open ? '#285d50' : '#653f42',
        })),
      )
      const markers: SeriesMarker<Time>[] = events.map((event) => ({
        time: event.time as Time,
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
        text:
          event.kind === 'discard'
            ? 'DESC'
            : event.kind === 'exit'
              ? 'SAL'
              : event.direction === 'short'
                ? 'CORTO'
                : 'LARGO',
        id: event.id,
      }))
      markerApi.setMarkers(markers)
      chart.timeScale().fitContent()
    }
    redraw.current = update
    update()
    return () => {
      observer.disconnect()
      chart.remove()
      redraw.current = null
    }
  }, [])

  useEffect(() => {
    latest.current = { candles, decisions }
    redraw.current?.()
  }, [candles, decisions])

  return (
    <div
      ref={container}
      className="demo-terminal__chart"
      role="img"
      aria-label="Gráfico ilustrativo de velas BTC/EUR con volumen; las decisiones relacionadas se muestran en el panel"
    />
  )
}
