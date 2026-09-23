import type { TechnicalFeatureSnapshot } from '../contracts.ts'
import {
  assertKnownSimulationRule,
  candidateForRuleVersion,
  type SimulationCandidate,
  type SimulationRuleConfig,
} from './candidate-manifest.ts'

export type { SimulationRuleConfig }

export interface SimulationRuleOutput {
  readonly up: number
  readonly down: number
  readonly flat: number
  readonly abstentionReason?: string
}

export type SimulationRuleFn = (
  referencePrice: number,
  snapshot: TechnicalFeatureSnapshot,
  config: SimulationRuleConfig,
) => SimulationRuleOutput

const ABSTENTION_PROBABILITY = 1 / 3
const REQUIRED_VOTE_COUNT = 4

function vote(
  value: number | undefined,
  positive: (value: number) => boolean,
  negative: (value: number) => boolean,
): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  if (positive(value)) return 1
  if (negative(value)) return -1
  return 0
}

/**
 * Single parameterized directional rule. With the default candidate config it
 * reproduces the production `probabilitiesForFeatures` mapping exactly; every
 * other candidate varies one family through the config. No new math is
 * introduced: the same four votes and the same linear winner/loser/flat map.
 */
export const simulationRule: SimulationRuleFn = (
  referencePrice,
  snapshot,
  config,
) => {
  const atr = snapshot.values['atr']
  if (
    config.atrGateRatio !== null &&
    atr !== undefined &&
    Number.isFinite(atr) &&
    Number.isFinite(referencePrice) &&
    referencePrice > 0 &&
    atr / referencePrice > config.atrGateRatio
  ) {
    return {
      up: ABSTENTION_PROBABILITY,
      down: ABSTENTION_PROBABILITY,
      flat: ABSTENTION_PROBABILITY,
      abstentionReason: 'atr_gate',
    }
  }

  const values = snapshot.values
  const basis = config.useEmaForTrend ? values['ema'] : values['sma']
  const smaVote =
    basis === undefined || !Number.isFinite(basis) || basis <= 0
      ? 0
      : Math.abs(referencePrice - basis) / basis < config.smaEpsilonBps / 10_000
        ? 0
        : referencePrice > basis
          ? 1
          : -1
  const rsiVote = vote(
    values['rsi'],
    (value) => value > config.rsiHigh,
    (value) => value < config.rsiLow,
  )
  const macdValue =
    config.macdSource === 'line' ? values['macdLine'] : values['macdHistogram']
  const macdVote = vote(
    macdValue,
    (value) => value > 0,
    (value) => value < 0,
  )
  const slopeVote = vote(
    values['structuralSlope'],
    (value) => value > config.slopeEpsilon,
    (value) => value < -config.slopeEpsilon,
  )
  const score =
    config.weights.sma * smaVote +
    config.weights.rsi * rsiVote +
    config.weights.macd * macdVote +
    config.weights.slope * slopeVote

  if (score === 0 || Math.abs(score) < config.quorum)
    return { up: 0.3, down: 0.3, flat: 0.4 }
  const strength = Math.min(Math.abs(score) / REQUIRED_VOTE_COUNT, 1)
  const winner = config.probWinnerBase + config.probWinnerSlope * strength
  const loser = config.probLoserBase - config.probLoserSlope * strength
  const flat = 1 - winner - loser
  return score > 0
    ? { up: winner, down: loser, flat }
    : { up: loser, down: winner, flat }
}

export function resolveSimulationRule(ruleVersion: string): SimulationRuleFn {
  assertKnownSimulationRule(ruleVersion)
  return simulationRule
}

export function runSimulationRule(
  candidate: SimulationCandidate,
  referencePrice: number,
  snapshot: TechnicalFeatureSnapshot,
): SimulationRuleOutput {
  return resolveSimulationRule(candidate.ruleVersion)(
    referencePrice,
    snapshot,
    candidate.rule,
  )
}

export { candidateForRuleVersion }
