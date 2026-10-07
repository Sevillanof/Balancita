import { useEffect, useState } from 'react'
import { record } from '../../../shared/wire/decode.ts'

/** Timeframes the chart offers, in ms. */
export const CHART_TIMEFRAMES = [
  { ms: 60_000, label: '1m' },
  { ms: 300_000, label: '5m' },
  { ms: 900_000, label: '15m' },
  { ms: 3_600_000, label: '1h' },
  { ms: 14_400_000, label: '4h' },
  { ms: 86_400_000, label: '1d' },
] as const

export type ChartFlowPoint = {
  time_ms: number
  buy_volume: number | null
  sell_volume: number | null
  liquidation_volume: number | null
  open_interest: number | null
  long_percent: number | null
  top_long_percent: number | null
  volatility: number | null
}

export type TerminalTickerStats = Partial<{
  last: number | null
  mark: number | null
  index: number | null
  premium: number | null
  bid: number | null
  ask: number | null
  bid_size: number | null
  ask_size: number | null
  spread: number | null
  open_24h: number | null
  high_24h: number | null
  low_24h: number | null
  change_24h_pct: number | null
  volume_24h_base: number | null
  volume_24h_quote: number | null
  open_interest: number | null
  funding_rate: number | null
  funding_rate_prediction: number | null
  relative_funding_rate: number | null
  relative_funding_rate_prediction: number | null
  next_funding_time_ms: number | null
  received_at: number | null
}>

export type ChartDepth = {
  time_ms: number
  bid: Record<string, number | null>
  ask: Record<string, number | null>
}

export type TerminalChartData = {
  intervalMs: number
  candles: Array<{
    time: number
    open: number
    high: number
    low: number
    close: number
    volume: number
    closed: boolean
  }>
  flow: ChartFlowPoint[]
  depth: ChartDepth | null
  ticker: TerminalTickerStats | null
}

/** Validates the gateway's `futures-terminal-chart.v1` body; null when unusable. */
export function parseTerminalChart(value: unknown): TerminalChartData | null {
  const body = record(value)
  if (body.schema_version !== 'futures-terminal-chart.v1') return null
  const intervalMs = Number(body.interval_ms)
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) return null
  const candles = (Array.isArray(body.candles) ? body.candles : []).flatMap(
    (item) => {
      const candle = record(item)
      const values = ['open', 'high', 'low', 'close', 'volume_btc'].map((key) =>
        Number(candle[key]),
      )
      if (
        !Number.isSafeInteger(candle.time_ms) ||
        values.some((number) => !Number.isFinite(number))
      )
        return []
      return [
        {
          time: Math.floor(Number(candle.time_ms) / 1000),
          open: values[0]!,
          high: values[1]!,
          low: values[2]!,
          close: values[3]!,
          volume: values[4]!,
          closed: candle.closed === true,
        },
      ]
    },
  )
  const flow = (Array.isArray(body.flow) ? body.flow : []).flatMap((item) => {
    const point = record(item)
    if (!Number.isSafeInteger(point.time_ms)) return []
    const pick = (key: string) =>
      typeof point[key] === 'number' && Number.isFinite(point[key])
        ? (point[key] as number)
        : null
    return [
      {
        time_ms: Number(point.time_ms),
        buy_volume: pick('buy_volume'),
        sell_volume: pick('sell_volume'),
        liquidation_volume: pick('liquidation_volume'),
        open_interest: pick('open_interest'),
        long_percent: pick('long_percent'),
        top_long_percent: pick('top_long_percent'),
        volatility: pick('volatility'),
      },
    ]
  })
  const depth = record(body.depth)
  return {
    intervalMs,
    candles,
    flow,
    depth: Number.isSafeInteger(depth.time_ms)
      ? {
          time_ms: Number(depth.time_ms),
          bid: record(depth.bid) as ChartDepth['bid'],
          ask: record(depth.ask) as ChartDepth['ask'],
        }
      : null,
    ticker:
      body.ticker && typeof body.ticker === 'object'
        ? (body.ticker as TerminalTickerStats)
        : null,
  }
}

/**
 * Polls the gateway chart endpoint for one timeframe while `enabled`.
 * Returns null until the first good answer, and on any failure keeps the
 * last good one (the 1m stream keeps the chart alive meanwhile).
 */
export function useTerminalChart(
  apiBase: string,
  intervalMs: number,
  enabled: boolean,
  refreshMs = 15_000,
): TerminalChartData | null {
  const [data, setData] = useState<TerminalChartData | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let controller: AbortController | undefined
    const load = async () => {
      controller?.abort()
      controller = new AbortController()
      try {
        const response = await fetch(
          `${apiBase}/terminal/chart?interval_ms=${intervalMs}`,
          { signal: controller.signal },
        )
        if (!response.ok) return
        const parsed = parseTerminalChart(await response.json())
        if (!cancelled && parsed && parsed.intervalMs === intervalMs)
          setData(parsed)
      } catch {
        // Offline or aborted: keep the last good series.
      }
    }
    void load()
    const timer = setInterval(() => void load(), refreshMs)
    return () => {
      cancelled = true
      clearInterval(timer)
      controller?.abort()
    }
  }, [apiBase, intervalMs, enabled, refreshMs])
  return enabled && data?.intervalMs === intervalMs ? data : null
}
