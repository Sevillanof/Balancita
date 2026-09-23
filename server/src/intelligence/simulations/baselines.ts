import type { ForecastOutcomeLabel } from '../contracts.ts'

export interface BaselineProbabilities {
  readonly probabilityUp: number
  readonly probabilityDown: number
  readonly probabilityFlat: number
}

/** Uniform baseline: one third per class, always issued. */
export function uniformBaseline(): BaselineProbabilities {
  return {
    probabilityUp: 1 / 3,
    probabilityDown: 1 / 3,
    probabilityFlat: 1 / 3,
  }
}

/** No-change baseline: the market stays flat, always issued. */
export function noChangeBaseline(): BaselineProbabilities {
  return { probabilityUp: 0, probabilityDown: 0, probabilityFlat: 1 }
}

/**
 * Momentum baseline: repeat the last observed label with certainty. Before
 * the first label there is no past to repeat, so it falls back to uniform.
 */
export function momentumBaseline(
  previousLabel: ForecastOutcomeLabel | null,
): BaselineProbabilities {
  if (previousLabel === null) return uniformBaseline()
  return {
    probabilityUp: previousLabel === 'up' ? 1 : 0,
    probabilityDown: previousLabel === 'down' ? 1 : 0,
    probabilityFlat: previousLabel === 'flat' ? 1 : 0,
  }
}
