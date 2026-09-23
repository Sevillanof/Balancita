import { contentHashFor } from '../forecast-hashing.ts'
import {
  DEFAULT_PARAM_SET_VERSION,
  DEFAULT_TECHNICAL_PARAMS,
  type TechnicalFeatureParams,
} from '../technical-features.ts'

/**
 * Production rule version. Kept as a literal here (instead of importing it
 * from the forecast engine) so the engine can dispatch to this manifest
 * without creating a module cycle; parity is enforced by test.
 */
export const PRODUCTION_RULE_VERSION = 'technical-direction.v1'

export const SIMULATION_MANIFEST_VERSION = 'simulations-manifest.v1' as const

/**
 * Frozen outcome band for the whole comparison. Varying it per variant would
 * change the labels each candidate is scored against (label snooping), so the
 * harness rejects any other value.
 */
export const SIMULATION_NEUTRAL_BAND = 0.0015 as const

export type SimulationVariantFamily =
  | 'default'
  | 'rsi-band'
  | 'ema-trend'
  | 'macd-signal'
  | 'slope-gate'
  | 'vote-weights'
  | 'quorum'
  | 'prob-map'
  | 'atr-abstention'
  | 'period-preset'
  | 'sma-deadband'

export type SimulationMacdSource = 'histogram' | 'line'

export interface SimulationRuleConfig {
  readonly rsiLow: number
  readonly rsiHigh: number
  readonly useEmaForTrend: boolean
  readonly macdSource: SimulationMacdSource
  readonly slopeEpsilon: number
  readonly smaEpsilonBps: number
  readonly weights: {
    readonly sma: number
    readonly rsi: number
    readonly macd: number
    readonly slope: number
  }
  /** Minimum weighted |score| required for a directional call. */
  readonly quorum: number
  readonly probWinnerBase: number
  readonly probWinnerSlope: number
  readonly probLoserBase: number
  readonly probLoserSlope: number
  /** Abstain when atr/close exceeds this ratio; null disables the gate. */
  readonly atrGateRatio: number | null
}

export interface SimulationCandidate {
  readonly candidateId: string
  readonly family: SimulationVariantFamily
  readonly ruleVersion: string
  readonly paramSetVersion: string
  readonly params: TechnicalFeatureParams
  readonly rule: SimulationRuleConfig
}

const BASE_RULE: SimulationRuleConfig = {
  rsiLow: 45,
  rsiHigh: 55,
  useEmaForTrend: false,
  macdSource: 'histogram',
  slopeEpsilon: 0,
  smaEpsilonBps: 0,
  weights: { sma: 1, rsi: 1, macd: 1, slope: 1 },
  quorum: 0,
  probWinnerBase: 0.45,
  probWinnerSlope: 0.1,
  probLoserBase: 0.25,
  probLoserSlope: 0.05,
  atrGateRatio: null,
}

function defaultParams(): TechnicalFeatureParams {
  return { ...DEFAULT_TECHNICAL_PARAMS }
}

function candidate(
  candidateId: string,
  family: SimulationVariantFamily,
  ruleVersion: string,
  rule: Omit<Partial<SimulationRuleConfig>, 'weights'> & {
    readonly weights?: Partial<SimulationRuleConfig['weights']>
  },
  params: TechnicalFeatureParams = defaultParams(),
): SimulationCandidate {
  return {
    candidateId,
    family,
    ruleVersion,
    paramSetVersion: params.paramSetVersion ?? DEFAULT_PARAM_SET_VERSION,
    params,
    rule: {
      ...BASE_RULE,
      ...rule,
      weights: { ...BASE_RULE.weights, ...rule.weights },
    },
  }
}

/**
 * Pre-registered candidate set. Each entry varies exactly one rule/param
 * family against the production default; no new math is introduced and no
 * entry is added at run time.
 */
export const SIMULATION_CANDIDATES: readonly SimulationCandidate[] = [
  candidate('technical-default', 'default', PRODUCTION_RULE_VERSION, {}),
  candidate('rsi-wide-band', 'rsi-band', 'simulation-rsi-wide.v1', {
    rsiLow: 40,
    rsiHigh: 60,
  }),
  candidate('ema-trend', 'ema-trend', 'simulation-ema-trend.v1', {
    useEmaForTrend: true,
  }),
  candidate('macd-line-signal', 'macd-signal', 'simulation-macd-line.v1', {
    macdSource: 'line',
  }),
  candidate('slope-epsilon-gate', 'slope-gate', 'simulation-slope-gate.v1', {
    slopeEpsilon: 0.5,
  }),
  candidate(
    'weighted-rsi-double',
    'vote-weights',
    'simulation-weighted-rsi.v1',
    { weights: { rsi: 2 } },
  ),
  candidate('strict-quorum', 'quorum', 'simulation-strict-quorum.v1', {
    quorum: 2,
  }),
  candidate('steep-prob-map', 'prob-map', 'simulation-steep-probmap.v1', {
    probWinnerBase: 0.5,
    probWinnerSlope: 0.15,
    probLoserBase: 0.3,
    probLoserSlope: 0.08,
  }),
  candidate('atr-gated', 'atr-abstention', 'simulation-atr-gated.v1', {
    atrGateRatio: 0.02,
  }),
  candidate(
    'period-preset-fast',
    'period-preset',
    'simulation-period-fast.v1',
    {},
    {
      ...defaultParams(),
      smaPeriod: 10,
      emaPeriod: 10,
      rsiPeriod: 7,
      atrPeriod: 7,
      slopePeriod: 10,
      paramSetVersion: 'simulation-periods-fast.v1',
    },
  ),
  candidate('sma-deadband', 'sma-deadband', 'simulation-sma-deadband.v1', {
    smaEpsilonBps: 10,
  }),
]

export class UnknownSimulationRuleError extends Error {
  constructor(ruleVersion: string) {
    super(`Unknown simulation rule version: ${ruleVersion}.`)
    this.name = 'UnknownSimulationRuleError'
  }
}

export class UnknownSimulationCandidateError extends Error {
  constructor(candidateId: string) {
    super(`Unknown simulation candidate: ${candidateId}.`)
    this.name = 'UnknownSimulationCandidateError'
  }
}

/** The harness refuses any rule version outside the pre-registered manifest. */
export function assertKnownSimulationRule(ruleVersion: string): void {
  const known = SIMULATION_CANDIDATES.some(
    (candidate) => candidate.ruleVersion === ruleVersion,
  )
  if (!known) throw new UnknownSimulationRuleError(ruleVersion)
}

export function candidateForRuleVersion(
  ruleVersion: string,
): SimulationCandidate {
  assertKnownSimulationRule(ruleVersion)
  return SIMULATION_CANDIDATES.find(
    (candidate) => candidate.ruleVersion === ruleVersion,
  )!
}

export function candidateForId(candidateId: string): SimulationCandidate {
  const candidate = SIMULATION_CANDIDATES.find(
    (entry) => entry.candidateId === candidateId,
  )
  if (candidate === undefined)
    throw new UnknownSimulationCandidateError(candidateId)
  return candidate
}

/** Order-independent hash of the frozen manifest for report provenance. */
export function manifestHashFor(
  candidates: readonly SimulationCandidate[],
): string {
  const ordered = [...candidates].sort((left, right) =>
    left.candidateId < right.candidateId
      ? -1
      : left.candidateId > right.candidateId
        ? 1
        : 0,
  )
  return contentHashFor({
    version: SIMULATION_MANIFEST_VERSION,
    neutralBand: SIMULATION_NEUTRAL_BAND,
    candidates: ordered,
  })
}

export function simulationManifestHash(): string {
  return manifestHashFor(SIMULATION_CANDIDATES)
}
