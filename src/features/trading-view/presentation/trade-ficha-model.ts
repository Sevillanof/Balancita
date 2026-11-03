import type { TradeCoordinates } from '../domain/terminal-trade-model.ts'

export const FICHA_WIDTH = 184
export const FICHA_HEIGHT = 96
/** An operation is closed at 36 h at the latest: the ring fills up to it. */
export const CAP_MS = 36 * 3_600_000
/** The bar's half scale: a move of this % from the entry fills one side. */
export const BAR_HALF_PCT = 2

/** How far the price went in the operation's favour (+) or against it (−), in % of the entry. */
export function moveFraction(item: TradeCoordinates): number | null {
  const { trade } = item
  const result = trade.open ? trade.markPrice : trade.exitPrice
  if (trade.entryPrice === null || result === null || trade.entryPrice <= 0)
    return null
  const pct =
    ((result - trade.entryPrice) / trade.entryPrice) *
    100 *
    (trade.side === 'LONG' ? 1 : -1)
  return Math.max(-1, Math.min(1, pct / BAR_HALF_PCT))
}
