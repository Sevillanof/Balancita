import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from 'lightweight-charts'
import {
  projectTrade,
  readTradeSpan,
  timeLogicalIndex,
  type TerminalChartTrade,
  type TradeCoordinates,
  type TradeSpan,
} from '../domain/terminal-trade-model.ts'
import type { ApprovedTerminalCandle } from './ApprovedTerminalChart.tsx'

export interface TerminalTradeFrame {
  width: number
  height: number
  items: readonly TradeCoordinates[]
  issues: readonly string[]
}

export const EMPTY_TRADE_FRAME: TerminalTradeFrame = {
  width: 0,
  height: 0,
  items: [],
  issues: [],
}

export class TerminalTradePrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null
  private series: ISeriesApi<SeriesType, Time> | null = null
  private redraw: (() => void) | null = null
  private candles: readonly ApprovedTerminalCandle[] = []
  private times: readonly number[] = []
  private intervalSeconds = 60
  private spans: Array<{
    trade: TerminalChartTrade
    span: Extract<TradeSpan, { state: 'ready' }>
  }> = []
  private issues: string[] = []
  private signature = ''
  private readonly publish: (frame: TerminalTradeFrame) => void

  constructor(publish: (frame: TerminalTradeFrame) => void) {
    this.publish = publish
  }

  attached({
    chart,
    series,
    requestUpdate,
  }: SeriesAttachedParameter<Time, SeriesType>): void {
    this.chart = chart
    this.series = series
    this.redraw = requestUpdate
    requestUpdate()
  }

  detached(): void {
    this.chart = null
    this.series = null
    this.redraw = null
    this.signature = ''
  }

  paneViews() {
    return []
  }

  setData(
    trades: readonly TerminalChartTrade[],
    candles: readonly ApprovedTerminalCandle[],
    intervalSeconds: number,
  ): void {
    this.candles = candles
    this.times = candles.map((candle) => candle.time)
    this.intervalSeconds = intervalSeconds
    this.spans = []
    this.issues = []
    const lastMs = (candles.at(-1)?.time ?? 0) * 1000
    for (const trade of trades) {
      const span = readTradeSpan(trade, lastMs || trade.entryMs)
      if (span.state !== 'ready') {
        this.issues.push(`Operación #${trade.tradeNo}: ${span.reason}`)
        continue
      }
      this.spans.push({ trade, span })
      const resultPrice = trade.open ? trade.markPrice : trade.exitPrice
      if (
        resultPrice === null ||
        !Number.isFinite(resultPrice) ||
        resultPrice <= 0
      )
        this.issues.push(
          `Operación #${trade.tradeNo}: falta un precio de ${trade.open ? 'marca' : 'cierre'} registrado; el neto solo se muestra en la ficha.`,
        )
    }
    this.redraw?.()
  }

  autoscaleInfo(start: Logical, end: Logical) {
    const prices = this.spans.flatMap(({ span, trade }) => {
      const a = timeLogicalIndex(this.times, span.startMs, this.intervalSeconds)
      const b = timeLogicalIndex(this.times, span.endMs, this.intervalSeconds)
      if (a === null || b === null || a > end || b < start) return []
      const resultTime = trade.open ? (trade.markMs ?? span.endMs) : span.endMs
      const result = timeLogicalIndex(
        this.times,
        resultTime,
        this.intervalSeconds,
      )
      const resultPrice = trade.open ? trade.markPrice : trade.exitPrice
      return result !== null &&
        result >= start &&
        result <= end &&
        resultPrice !== null &&
        Number.isFinite(resultPrice) &&
        resultPrice > 0
        ? [span.price, resultPrice]
        : [span.price]
    })
    return prices.length
      ? {
          priceRange: {
            minValue: Math.min(...prices),
            maxValue: Math.max(...prices),
          },
        }
      : null
  }

  updateAllViews(): void {
    if (
      this.chart === null ||
      this.series === null ||
      this.candles.length === 0
    )
      return
    const chart = this.chart,
      series = this.series
    const size = chart.paneSize(0)
    const scale = chart.timeScale()
    const range = scale.getVisibleLogicalRange()
    const visible = range
      ? this.candles.slice(
          Math.max(0, Math.floor(range.from) - 1),
          Math.ceil(range.to) + 2,
        )
      : this.candles
    const map = {
      width: size.width,
      height: size.height,
      time: (timeMs: number) => {
        const logical = timeLogicalIndex(
          this.times,
          timeMs,
          this.intervalSeconds,
        )
        return logical === null
          ? null
          : scale.logicalToCoordinate(logical as Logical)
      },
      price: (price: number) => series.priceToCoordinate(price),
    }
    const items = this.spans.flatMap(({ trade, span }) => {
      const item = projectTrade(trade, span, map, visible)
      return item === null ? [] : [item]
    })
    const frame = {
      width: size.width,
      height: size.height,
      items,
      issues: this.issues,
    }
    const signature = JSON.stringify(frame)
    if (signature !== this.signature) {
      this.signature = signature
      this.publish(frame)
    }
  }
}
