import type { InstrumentId } from '../../market-data/domain/market-data.ts'
import {
  isMoney,
  moneyIsPositive,
  type Money,
} from '../../../shared/finance/money.ts'

export type Holding = {
  instrumentId: InstrumentId
  quantity: Money
  averageCost: Money
}

/**
 * Persistence contract for the personal portfolio. Kept deliberately small and
 * async so a future backend adapter can replace localStorage without touching
 * the UI.
 */
export interface PortfolioRepository {
  /** Returns all stored holdings, or an empty list when none exist. */
  list(): Promise<readonly Holding[]>
  /**
   * Creates the holding for its instrumentId, or replaces the existing one.
   * Storage failures reject the promise.
   */
  add(holding: Holding): Promise<void>
  /** Removes the holding for the given instrument, if present. */
  remove(instrumentId: InstrumentId): Promise<void>
  /** Removes every stored holding. */
  clear(): Promise<void>
}

/**
 * Raised when stored portfolio data exists but cannot be trusted: invalid JSON,
 * unsupported schema version, or a malformed holding. The UI must surface this
 * explicitly and offer a way to reset instead of silently returning garbage.
 */
export class PortfolioCorruptError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'PortfolioCorruptError'
  }
}

/** Loose shape guard for an in-memory holding. */
export function isHolding(value: unknown): value is Holding {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.instrumentId === 'string' &&
    candidate.instrumentId.length > 0 &&
    isMoney(candidate.quantity) &&
    moneyIsPositive(candidate.quantity) &&
    isMoney(candidate.averageCost) &&
    moneyIsPositive(candidate.averageCost)
  )
}
