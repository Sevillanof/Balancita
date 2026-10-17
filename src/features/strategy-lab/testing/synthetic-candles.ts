import type { LabCandle } from '../infrastructure/lab-candles.ts'

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
