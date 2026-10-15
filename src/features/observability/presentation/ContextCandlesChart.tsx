import { useEffect, useRef } from 'react'
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  type CandlestickData,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts'
import type { ContextSeries } from './context-candles-view.ts'

export type ContextMarker = {
  /** Text drawn on the marker: the action and the registered reason code. */
  text: string
  /** `long`/`short` colour the glyph; anything else is neutral (a discard). */
  tone: 'long' | 'short' | 'neutral'
}

function cssColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  )
}

/**
 * Context candles around one decision. A small chart of its own (the Terminal's
 * `ApprovedTerminalChart` stays untouched): the time axis of lightweight-charts
 * is a list of points, so the buckets with no candle are passed as empty points
 * to leave a visible gap instead of squeezing the neighbours together.
 */
export default function ContextCandlesChart({
  series,
  marker,
  ariaLabel,
}: {
  series: ContextSeries
  marker: ContextMarker
  ariaLabel: string
}) {
  const node = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = node.current
    if (!container) return
    const up = cssColor('--chart-up', '#10b981')
    const down = cssColor('--chart-down', '#ef4444')
    const neutral = cssColor('--warning', '#f59e0b')
    const text = cssColor('--mc-text-2', '#94a3b8')
    const grid = cssColor('--mc-border', '#1e2638')
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: text,
        fontFamily: 'IBM Plex Mono, monospace',
        fontSize: 11,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: grid, style: 2 },
        horzLines: { color: grid, style: 2 },
      },
      rightPriceScale: { borderColor: grid },
      timeScale: {
        borderColor: grid,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
      },
      handleScroll: true,
      handleScale: true,
    })
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: up,
      downColor: down,
      borderVisible: false,
      wickUpColor: up,
      wickDownColor: down,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
    })
    // After the decision: the same candles, muted so they read as observed later.
    const mute = (color: string) =>
      /^#[0-9a-f]{6}$/i.test(color) ? `${color}88` : color
    const points: (CandlestickData<Time> | WhitespaceData<Time>)[] = [
      ...series.candles.map((c): CandlestickData<Time> => ({
        time: c.time as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        ...(c.after
          ? {
              color: mute(c.close >= c.open ? up : down),
              wickColor: mute(c.close >= c.open ? up : down),
            }
          : {}),
      })),
      ...series.gapTimes.map((t): WhitespaceData<Time> => ({
        time: t as Time,
      })),
    ].sort((a, b) => Number(a.time) - Number(b.time))
    candles.setData(points)
    if (series.decisionCandle) {
      createSeriesMarkers(candles, [
        {
          time: series.markerTime as Time,
          position: 'aboveBar',
          shape: 'arrowDown',
          color:
            marker.tone === 'long'
              ? up
              : marker.tone === 'short'
                ? down
                : neutral,
          text: marker.text,
          size: 2,
        },
      ])
    }
    chart.timeScale().fitContent()
    return () => chart.remove()
  }, [series, marker])

  return (
    <div
      ref={node}
      className="inv-context__chart"
      data-testid="context-chart"
      data-candle-count={series.candles.length}
      data-gap-count={series.gapTimes.length}
      role="img"
      aria-label={ariaLabel}
    />
  )
}
