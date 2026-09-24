import type { SeriesMarker, Time } from 'lightweight-charts'
import type { PaperOrderEvent } from './usePaperTelemetry.ts'

export function paperOrderMarkers(
  orders: readonly PaperOrderEvent[],
  candleTimes: ReadonlySet<number>,
): SeriesMarker<Time>[] {
  return orders
    .flatMap((order) => {
      const rejected = order.action === 'BUY' && !order.gatePassed
      const seconds = rejected
        ? order.signalTimestamp - 60
        : order.executionTimestamp
      if (seconds === null || !candleTimes.has(seconds)) return []
      const marker: SeriesMarker<Time> = {
        time: seconds as Time,
        position: rejected || order.action === 'SELL' ? 'aboveBar' : 'belowBar',
        color: rejected
          ? '#787b86'
          : order.action === 'BUY'
            ? '#26a69a'
            : '#ef5350',
        shape: rejected
          ? 'circle'
          : order.action === 'BUY'
            ? 'arrowUp'
            : 'arrowDown',
        text: rejected
          ? 'Gate < 0.60%'
          : order.action === 'BUY'
            ? 'BUY 30€'
            : 'SELL',
      }
      return [marker]
    })
    .sort((left, right) => Number(left.time) - Number(right.time))
}
