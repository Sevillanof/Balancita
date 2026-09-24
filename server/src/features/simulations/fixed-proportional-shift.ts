export interface ThreeClassPrior {
  readonly up: number
  readonly down: number
  readonly flat: number
}

export const FIXED_PROBABILITY_MAP_VERSION =
  'fixed-proportional-shift-v1' as const

export interface MaturedOutcomeLabel {
  readonly maturedAt: number
  readonly label: 'up' | 'down' | 'flat'
}

/** Returns null until at least one outcome matured strictly before this cutoff. */
export function empiricalPriorBefore(
  outcomes: readonly MaturedOutcomeLabel[],
  asOfTimestamp: number,
): ThreeClassPrior | null {
  const counts = { up: 0, down: 0, flat: 0 }
  for (const outcome of outcomes) {
    if (
      !Number.isFinite(outcome.maturedAt) ||
      outcome.maturedAt >= asOfTimestamp
    )
      continue
    counts[outcome.label] += 1
  }
  const total = counts.up + counts.down + counts.flat
  return total === 0
    ? null
    : {
        up: counts.up / total,
        down: counts.down / total,
        flat: counts.flat / total,
      }
}

/**
 * Adds at most 0.15 mass to UP and removes it proportionally from DOWN/FLAT.
 * The shift clamps at available non-UP mass; a prior already above 0.85 cannot
 * receive the full requested shift without leaving the probability simplex.
 */
export function probabilitiesForShift(
  prior: ThreeClassPrior,
  shift: 0 | 1,
): ThreeClassPrior {
  const total = prior.up + prior.down + prior.flat
  if (
    ![prior.up, prior.down, prior.flat, total].every(Number.isFinite) ||
    prior.up < 0 ||
    prior.down < 0 ||
    prior.flat < 0 ||
    Math.abs(total - 1) > 1e-9
  )
    throw new Error(
      'Prior probabilities must be finite, non-negative, and sum to one.',
    )
  if (shift === 0 && total === 1) return { ...prior }
  const normalized = {
    up: prior.up / total,
    down: prior.down / total,
    flat: prior.flat / total,
  }
  if (shift === 0) return simplexVector(normalized.up, normalized.down)
  const available = normalized.down + normalized.flat
  const delta = Math.min(0.15, available)
  if (available === 0 || delta === 0)
    return simplexVector(normalized.up, normalized.down)
  const up = Math.min(1, normalized.up + delta)
  const remaining = 1 - up
  const down = remaining * (normalized.down / available)
  return simplexVector(up, down)
}

/** Makes FLAT the residual so the public left-to-right sum is exactly 1. */
function simplexVector(up: number, down: number): ThreeClassPrior {
  const boundedDown = Math.min(Math.max(0, down), 1 - up)
  const flat = 1 - (up + boundedDown)
  return { up, down: boundedDown, flat }
}
