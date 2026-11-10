import { madridTime } from '../../../shared/finance/format.ts'
import {
  MESES_CORTOS,
  madridParts,
  madridWallMs,
} from '../../../shared/finance/madrid-time.ts'

/**
 * The chart's time axis in Europe/Madrid. The candles keep their real instants
 * (UTC seconds); only the tick weights, which decide where the day, month and
 * hour marks go, and the labels read the Madrid wall clock. lightweight-charts
 * weights in UTC by itself, which would put the «new day» mark at 01:00/02:00
 * in Madrid.
 */

// lightweight-charts TickMarkWeight values (the library does not export the enum).
const YEAR = 70
const MONTH = 60
const DAY = 50
const INTRADAY: readonly { divisor: number; weight: number }[] = [
  { divisor: 12 * 3_600_000, weight: 33 },
  { divisor: 6 * 3_600_000, weight: 32 },
  { divisor: 3 * 3_600_000, weight: 31 },
  { divisor: 3_600_000, weight: 30 },
  { divisor: 30 * 60_000, weight: 22 },
  { divisor: 5 * 60_000, weight: 21 },
  { divisor: 60_000, weight: 20 },
  { divisor: 1_000, weight: 10 },
]

/** What kind of mark a point is next to the previous one (UTC seconds), by the Madrid calendar. */
export function madridTickWeight(time: number, previousTime: number): number {
  const now = new Date(madridWallMs(time * 1000))
  const before = new Date(madridWallMs(previousTime * 1000))
  if (now.getUTCFullYear() !== before.getUTCFullYear()) return YEAR
  if (now.getUTCMonth() !== before.getUTCMonth()) return MONTH
  if (now.getUTCDate() !== before.getUTCDate()) return DAY
  const wall = now.getTime()
  const wallBefore = before.getTime()
  for (const { divisor, weight } of INTRADAY)
    if (Math.floor(wall / divisor) !== Math.floor(wallBefore / divisor))
      return weight
  return 0
}

interface WeightedPoint {
  originalTime: unknown
  timeWeight: number
}

const seconds = (point: WeightedPoint) => Number(point.originalTime)

/**
 * `fillWeightsForPoints` of the horizontal scale: sets each point's weight from
 * `startIndex`, comparing it with the previous one. The first point of the series
 * guesses its predecessor one average step back, like the library does.
 */
export function fillMadridWeights(
  points: readonly WeightedPoint[],
  startIndex: number,
): void {
  if (points.length === 0) return
  let previous = startIndex === 0 ? null : seconds(points[startIndex - 1]!)
  let totalDiff = 0
  for (let index = startIndex; index < points.length; index += 1) {
    const point = points[index]!
    const time = seconds(point)
    if (previous !== null) point.timeWeight = madridTickWeight(time, previous)
    totalDiff += time - (previous ?? time)
    previous = time
  }
  if (startIndex === 0 && points.length > 1) {
    const average = Math.ceil(totalDiff / (points.length - 1))
    const first = seconds(points[0]!)
    points[0]!.timeWeight = madridTickWeight(first, first - average)
  }
}

/** Label of a tick (`type` is the library's TickMarkType: 0 year, 1 month, 2 day, 3 and 4 time). */
export function madridTickLabel(time: number, type: number): string {
  const ms = time * 1000
  if (type === 0) return String(madridParts(ms).year)
  if (type === 1) return MESES_CORTOS[madridParts(ms).month]!
  if (type === 2) return String(madridParts(ms).day)
  return madridTime(ms)
}
