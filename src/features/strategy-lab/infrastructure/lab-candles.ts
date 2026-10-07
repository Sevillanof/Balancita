import {
  loadTerminalBootstrap,
  terminalApiBase,
} from '../../connected-trading/infrastructure/terminal-stream-client.ts'
import type { LabCandle } from '../domain/indicators.ts'

export type LabCandleSource = 'live' | 'mock' | 'synthetic'

export type LabCandles = {
  source: LabCandleSource
  candles: LabCandle[]
}

/** Below this the indicators barely warm up, so the sample is not useful. */
export const MIN_USEFUL_CANDLES = 60

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** Closed candles of a terminal bootstrap's `terminal_market`, oldest first. */
export function candlesFromBootstrap(bootstrap: unknown): LabCandle[] {
  const market = record(record(bootstrap).terminal_market)
  if (!Array.isArray(market.candles)) return []
  return market.candles
    .flatMap((value) => {
      const candle = record(value)
      if (candle.closed === false || !Number.isSafeInteger(candle.time_ms))
        return []
      const values = ['open', 'high', 'low', 'close', 'volume_btc'].map((key) =>
        Number(candle[key]),
      )
      if (values.some((number) => !Number.isFinite(number))) return []
      return [
        {
          time: Math.floor(Number(candle.time_ms) / 1000),
          open: values[0]!,
          high: values[1]!,
          low: values[2]!,
          close: values[3]!,
          volume: values[4]!,
        },
      ]
    })
    .sort((a, b) => a.time - b.time)
}

/**
 * Deterministic random walk around 84.000 US$ for when no terminal backend
 * answers, so the screen still renders a realistic working state.
 */
export function syntheticCandles(
  count = 480,
  endSeconds = 1_791_331_200,
): LabCandle[] {
  let seed = 7
  const random = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed / 2_147_483_648
  }
  const candles: LabCandle[] = []
  let price = 84_000
  let drift = 0
  for (let index = 0; index < count; index += 1) {
    if (index % 60 === 0) drift = (random() - 0.5) * 6
    const open = price
    const close = open + drift + (random() - 0.5) * 40
    const high = Math.max(open, close) + random() * 18
    const low = Math.min(open, close) - random() * 18
    candles.push({
      time: endSeconds - (count - index) * 60,
      open,
      high,
      low,
      close,
      volume: 2 + random() * 6 + (random() > 0.93 ? 12 : 0),
    })
    price = close
  }
  return candles
}

/**
 * The same 1m PF_XBTUSD candles the Terminal chart shows: the live gateway
 * first, then the MOCK fixture, then synthetic candles.
 */
export async function loadLabCandles(
  load: typeof loadTerminalBootstrap = loadTerminalBootstrap,
): Promise<LabCandles> {
  for (const source of ['live', 'mock'] as const) {
    try {
      const candles = candlesFromBootstrap(await load(terminalApiBase(source)))
      if (candles.length >= MIN_USEFUL_CANDLES) return { source, candles }
    } catch {
      // Try the next source.
    }
  }
  return { source: 'synthetic', candles: syntheticCandles() }
}
