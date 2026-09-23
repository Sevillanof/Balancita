import type { Holding } from '../domain/portfolio.ts'
import {
  MONEY_ZERO,
  moneyDiv,
  moneyFromString,
  moneyIsZero,
  moneyMul,
  moneySub,
  type Money,
} from '../../../shared/finance/money.ts'

/** Total cost basis of a position: quantity × average cost. */
export function costOf(holding: Holding): Money {
  return moneyMul(holding.quantity, holding.averageCost)
}

/** Current value of a position at the given price: quantity × price. */
export function valueOf(holding: Holding, price: Money): Money {
  return moneyMul(holding.quantity, price)
}

/** Unrealized profit/loss of a position: current value − cost basis. */
export function profitLossOf(holding: Holding, price: Money): Money {
  return moneySub(valueOf(holding, price), costOf(holding))
}

/** Unrealized profit/loss as a percentage of the cost basis. */
export function profitLossPercentOf(holding: Holding, price: Money): Money {
  const cost = costOf(holding)
  if (moneyIsZero(cost)) return MONEY_ZERO
  return moneyMul(
    moneyDiv(profitLossOf(holding, price), cost),
    moneyFromString('100'),
  )
}
