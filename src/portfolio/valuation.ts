import type { Holding } from '../domain/portfolio'

/** Total cost basis of a position: quantity × average cost. */
export function costOf(holding: Holding): number {
  return holding.quantity * holding.averageCost
}

/** Current value of a position at the given price: quantity × price. */
export function valueOf(holding: Holding, price: number): number {
  return holding.quantity * price
}

/** Unrealized profit/loss of a position: current value − cost basis. */
export function profitLossOf(holding: Holding, price: number): number {
  return valueOf(holding, price) - costOf(holding)
}

/** Unrealized profit/loss as a percentage of the cost basis. */
export function profitLossPercentOf(holding: Holding, price: number): number {
  const cost = costOf(holding)
  if (cost === 0) return 0
  return (profitLossOf(holding, price) / cost) * 100
}
