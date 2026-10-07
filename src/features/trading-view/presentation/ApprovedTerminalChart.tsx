import { useEffect, useRef } from 'react'
import { currency as formatCurrency } from '../../../shared/finance/format.ts'
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
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
  /** Strategy that took the decision; colours the marker and feeds the filter. */
  strategyId?: string
  decisionStatus?: 'pending' | 'hold' | 'gate-rejected' | 'abstained'
}

export type ApprovedTerminalLevel = {
  positionId: string
  stop: number
  target: number
}

/** A line drawn over the candles (indicator). Times in seconds. */
export type ApprovedChartOverlay = {
  id: string
  color: string
  points: readonly { time: number; value: number }[]
  dashed?: boolean
}

/** A sub-pane under the candles: order flow, open interest, RSI… */
export type ApprovedChartPane = {
  id: string
  series: readonly {
    id: string
    kind: 'line' | 'histogram'
    color: string
    points: readonly { time: number; value: number; color?: string }[]
    /** Fixed decimals for the axis (default 2). */
    precision?: number
  }[]
}

/** Always-visible horizontal price line (entry, stop, target, mark). */
export type ApprovedChartPriceLine = {
  id: string
  price: number
  title: string
  color: string
  dashed?: boolean
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
  /** Show the volume histogram under the candles (default true). */
  showVolume?: boolean
  overlays?: readonly ApprovedChartOverlay[]
  panes?: readonly ApprovedChartPane[]
  priceLines?: readonly ApprovedChartPriceLine[]
  /**
   * Scroll to the selected marker when the chart first renders (default true).
   * False opens on the latest candles and only follows later selections.
   */
  focusOnMount?: boolean
}

const PANE_HEIGHT_PX = 110
const NO_OVERLAYS: readonly ApprovedChartOverlay[] = []
const NO_PANES: readonly ApprovedChartPane[] = []
const NO_LINES: readonly ApprovedChartPriceLine[] = []

function cssColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback
  return (
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() ||
    fallback
  )
}

import { strategyMarkerColor } from '../domain/terminal-chart-model.ts'

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

const BASE_SCALE_MARGINS = { top: 0.12, bottom: 0.22 }
const MARKER_STACK_PX = 54
const FALLBACK_PANE_HEIGHT_PX = 420
const MAX_STACK_MARGIN = 0.6
const MAX_TOTAL_MARGIN = 0.9

type StackedMarker = { time: unknown; position: 'aboveBar' | 'belowBar' }

/**
 * Same-bucket, same-side markers stack by roughly one glyph plus its label per
 * marker, so each extra stacked marker needs extra price-scale headroom or the
 * outermost glyph is painted outside the pane. Depth <= 1 keeps the base margins.
 */
function markerStackScaleMargins(
  markers: readonly StackedMarker[],
  paneHeightPx: number,
): { top: number; bottom: number } {
  const depth = {
    aboveBar: new Map<unknown, number>(),
    belowBar: new Map<unknown, number>(),
  }
  let maxAbove = 0
  let maxBelow = 0
  for (const marker of markers) {
    const side = depth[marker.position]
    const count = (side.get(marker.time) ?? 0) + 1
    side.set(marker.time, count)
    if (marker.position === 'aboveBar') maxAbove = Math.max(maxAbove, count)
    else maxBelow = Math.max(maxBelow, count)
  }
  const height = paneHeightPx > 0 ? paneHeightPx : FALLBACK_PANE_HEIGHT_PX
  const extra = (count: number) =>
    Math.min(
      MAX_STACK_MARGIN,
      Math.max(0, count - 1) * (MARKER_STACK_PX / height),
    )
  // lightweight-charts throws when top + bottom reaches 1: many markers on
  // one candle must squeeze the extra room, never the whole page.
  const room =
    MAX_TOTAL_MARGIN - BASE_SCALE_MARGINS.top - BASE_SCALE_MARGINS.bottom
  const above = extra(maxAbove)
  const below = extra(maxBelow)
  const squeeze = above + below > room ? room / (above + below) : 1
  return {
    top: BASE_SCALE_MARGINS.top + above * squeeze,
    bottom: BASE_SCALE_MARGINS.bottom + below * squeeze,
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
  showVolume = true,
  overlays = NO_OVERLAYS,
  panes = NO_PANES,
  priceLines: fixedLines = NO_LINES,
  focusOnMount = true,
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
  const overlaySeries = useRef(new Map<string, ISeriesApi<'Line'>>())
  const paneSeries = useRef<ISeriesApi<'Line' | 'Histogram'>[]>([])
  const paneKey = useRef('')
  const fixedPriceLines = useRef<
    ReturnType<ISeriesApi<'Candlestick'>['createPriceLine']>[]
  >([])
  const fitted = useRef(false)
  const marginsApplied = useRef(false)
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
    const overlays = overlaySeries.current
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
        scaleMargins: BASE_SCALE_MARGINS,
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
              formatter: (price: number) => formatCurrency(price, currency),
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
      overlays.clear()
      paneSeries.current = []
      paneKey.current = ''
      fixedPriceLines.current = []
      chartRef.current = null
      candleSeriesRef.current = null
      volumeRef.current = null
      markerRef.current = null
      fitted.current = false
      marginsApplied.current = false
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

  // Markers depend on which buckets exist, not on the forming candle's price.
  const bucketsKey = `${candles.length}:${candles[0]?.time}:${candles.at(-1)?.time}`
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
        const strategyColor = strategyMarkerColor(marker.strategyId)
        return [
          {
            time: bucket as Time,
            position: appearance.position,
            color: strategyColor ?? appearance.color,
            shape: appearance.shape,
            text: `${marker.label}${selectedId === marker.id ? ' ◀' : ''}`,
            id: marker.id,
            size: selectedId === marker.id ? 2 : 1,
          },
        ]
      })
    const painted = visibleMarkers
      .sort((left, right) => Number(left.time) - Number(right.time))
      .slice(-200)
    const margins = markerStackScaleMargins(
      painted as StackedMarker[],
      container.current?.clientHeight ?? 0,
    )
    const stacked =
      margins.top !== BASE_SCALE_MARGINS.top ||
      margins.bottom !== BASE_SCALE_MARGINS.bottom
    if (stacked || marginsApplied.current) {
      candleSeriesRef.current
        ?.priceScale()
        .applyOptions({ scaleMargins: margins })
      marginsApplied.current = stacked
    }
    markerRef.current?.setMarkers(painted)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bucketsKey, markers, selectedId, intervalSeconds, initialViewport])

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
    if (!focusOnMount && focusedSelection.current === null) {
      focusedSelection.current = selectionKey
      return
    }
    if (index >= 0 && focusedSelection.current !== selectionKey) {
      chartRef.current?.timeScale().setVisibleLogicalRange({
        from: Math.max(0, index - 30),
        to: index + 30,
      })
      focusedSelection.current = selectionKey
    }
  }, [
    markers,
    selectedId,
    intervalSeconds,
    candles,
    initialViewport,
    focusOnMount,
  ])

  const volumeHidden = useRef(false)
  useEffect(() => {
    // Untouched while visible: only a hide (or the show after it) is applied.
    if (showVolume && !volumeHidden.current) return
    volumeRef.current?.applyOptions({ visible: showVolume })
    volumeHidden.current = !showVolume
  }, [showVolume, initialViewport, currency])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const live = overlaySeries.current
    const wanted = new Set(overlays.map((overlay) => overlay.id))
    for (const [id, series] of live)
      if (!wanted.has(id)) {
        chart.removeSeries(series)
        live.delete(id)
      }
    for (const overlay of overlays) {
      let series = live.get(overlay.id)
      if (!series) {
        series = chart.addSeries(LineSeries, {
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        })
        live.set(overlay.id, series)
      }
      series.applyOptions({
        color: overlay.color,
        lineStyle: overlay.dashed ? 2 : 0,
      })
      series.setData(
        overlay.points.map((point) => ({
          time: point.time as Time,
          value: point.value,
        })),
      )
    }
  }, [overlays, initialViewport, currency])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    // Rebuild the sub-panes only when their layout changes; otherwise update data.
    const key = panes
      .map(
        (pane) =>
          `${pane.id}:${pane.series.map((item) => `${item.id}/${item.kind}`).join(',')}`,
      )
      .join('|')
    if (key !== paneKey.current) {
      for (const series of paneSeries.current) chart.removeSeries(series)
      paneSeries.current = []
      for (let index = chart.panes().length - 1; index >= 1; index -= 1)
        chart.removePane(index)
      panes.forEach((pane, paneIndex) => {
        for (const item of pane.series) {
          const options = {
            color: item.color,
            priceLineVisible: false,
            lastValueVisible: true,
            priceFormat: {
              type: 'price' as const,
              precision: item.precision ?? 2,
              minMove: 1 / 10 ** (item.precision ?? 2),
            },
          }
          paneSeries.current.push(
            item.kind === 'line'
              ? chart.addSeries(
                  LineSeries,
                  { ...options, lineWidth: 1 },
                  paneIndex + 1,
                )
              : chart.addSeries(HistogramSeries, options, paneIndex + 1),
          )
        }
      })
      // Sizes survive auto-resize as proportions: candles keep about 440 px
      // and every sub-pane about PANE_HEIGHT_PX of the taller container.
      chart
        .panes()
        .forEach((pane, index) =>
          pane.setStretchFactor(index === 0 ? 440 / PANE_HEIGHT_PX : 1),
        )
      paneKey.current = key
    }
    let index = 0
    for (const pane of panes)
      for (const item of pane.series) {
        paneSeries.current[index]?.setData(
          item.points.map((point) => ({
            time: point.time as Time,
            value: point.value,
            ...(point.color ? { color: point.color } : {}),
          })),
        )
        index += 1
      }
  }, [panes, initialViewport, currency])

  useEffect(() => {
    const series = candleSeriesRef.current
    if (!series) return
    fixedPriceLines.current.forEach((line) => series.removePriceLine(line))
    fixedPriceLines.current = fixedLines.map((line) =>
      series.createPriceLine({
        price: line.price,
        color: line.color,
        lineWidth: 1,
        lineStyle: line.dashed ? 2 : 0,
        axisLabelVisible: true,
        title: line.title,
      }),
    )
  }, [fixedLines, initialViewport, currency])

  return (
    <>
      <div
        ref={container}
        data-testid="approved-chart-renderer"
        data-candle-count={candles.length}
        data-marker-count={markers.length}
        className="demo-terminal__chart"
        style={
          panes.length > 0
            ? {
                height: `calc(var(--terminal-chart-height, 440px) + ${panes.length * PANE_HEIGHT_PX}px)`,
              }
            : undefined
        }
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
