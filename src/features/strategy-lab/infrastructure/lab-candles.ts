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
