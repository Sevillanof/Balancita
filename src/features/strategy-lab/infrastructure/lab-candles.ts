import {
  loadTerminalBootstrap,
  terminalApiBase,
} from '../../connected-trading/infrastructure/terminal-stream-client.ts'
import { record } from '../../../shared/wire/decode.ts'

/** A closed 1m candle; `time` in seconds, like the terminal chart. */
export type LabCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type LabCandleSource = 'live'

export type LabCandles = {
  source: LabCandleSource
  candles: LabCandle[]
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
 * Deterministic random walk around 84.000 US$. TEST FIXTURE ONLY (DATOS DE
 * EJEMPLO): the screens never fall back to it when the Terminal is down.
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
 * The same 1m PF_XBTUSD candles the Terminal chart shows, from the live
 * gateway only (MOCK is not used any more). With no live candles it throws:
 * the screen says so instead of drawing invented ones.
 */
export async function loadLabCandles(
  load: typeof loadTerminalBootstrap = loadTerminalBootstrap,
): Promise<LabCandles> {
  const candles = candlesFromBootstrap(await load(terminalApiBase('live')))
  if (candles.length === 0)
    throw new Error('El Terminal no devolvió velas cerradas.')
  return { source: 'live', candles }
}
