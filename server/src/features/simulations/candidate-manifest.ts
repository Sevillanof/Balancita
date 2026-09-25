import { contentHashFor } from '../forecasts/forecast-hashing.ts'
import {
  DEFAULT_PARAM_SET_VERSION,
  DEFAULT_TECHNICAL_PARAMS,
  type TechnicalFeatureParams,
} from '../technical-analysis/technical-features.ts'
import { FIXED_PROBABILITY_MAP_VERSION } from './fixed-proportional-shift.ts'

/**
 * Production rule version. Kept as a literal here (instead of importing it
 * from the forecast engine) so the engine can dispatch to this manifest
 * without creating a module cycle; parity is enforced by test.
 */
export const PRODUCTION_RULE_VERSION = 'technical-direction.v1'

export const SIMULATION_MANIFEST_VERSION = 'simulations-manifest.v3' as const

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
  | 'ema-cross'
  | 'atr-deadband'
  | 'rsi-contrarian'
  | 'drop-leg'
  | 'strategy-ladder'
  | 'session-gate'
  | 'composite'
  | 'micro-strategy'

export type MicroStrategy =
  | 'trend-pullback'
  | 'bollinger-reversion'
  | 'donchian-breakout'
  | 'regime-adapter'

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
  readonly emaCross: boolean
  readonly atrDeadbandMultiplier: number
  readonly rsiContrarian: boolean
  readonly sessionGateUtc: readonly [number, number] | null
  readonly requireTrendConfirmation: boolean
}

export interface SimulationCandidate {
  readonly status: 'archived' | 'active'
  readonly candidateId: string
  readonly family: SimulationVariantFamily
  readonly ruleVersion: string
  readonly paramSetVersion: string
  readonly params: TechnicalFeatureParams
  readonly rule: SimulationRuleConfig
  readonly theory: string
  readonly entryThreshold?: number
  readonly exitThreshold?: number
  readonly microStrategy?: MicroStrategy
  readonly probabilityMapVersion?: typeof FIXED_PROBABILITY_MAP_VERSION
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
  emaCross: false,
  atrDeadbandMultiplier: 0,
  rsiContrarian: false,
  sessionGateUtc: null,
  requireTrendConfirmation: false,
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
  theory = 'Versioned hypothesis, measured against the unchanged production baseline.',
  thresholds?: { readonly entry: number; readonly exit: number },
  microStrategy?: MicroStrategy,
): SimulationCandidate {
  return {
    status: microStrategy === undefined ? 'archived' : 'active',
    candidateId,
    family,
    ruleVersion,
    paramSetVersion: params.paramSetVersion ?? DEFAULT_PARAM_SET_VERSION,
    params,
    theory,
    ...(microStrategy === undefined ? {} : { microStrategy }),
    ...(microStrategy === undefined
      ? {}
      : { probabilityMapVersion: FIXED_PROBABILITY_MAP_VERSION }),
    ...(thresholds === undefined
      ? {}
      : { entryThreshold: thresholds.entry, exitThreshold: thresholds.exit }),
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
  candidate(
    'ema-cross-trend',
    'ema-cross',
    'simulation-ema-cross.v1',
    { emaCross: true },
    defaultParams(),
    'EMA/SMA spread tests trend independent of the price level.',
  ),
  candidate(
    'atr-deadband',
    'atr-deadband',
    'simulation-atr-deadband.v1',
    { atrDeadbandMultiplier: 0.5 },
    defaultParams(),
    'Volatility-scaled deadband filters small trend moves.',
  ),
  candidate(
    'rsi-contrarian',
    'rsi-contrarian',
    'simulation-rsi-contrarian.v1',
    { rsiContrarian: true },
    defaultParams(),
    'Mean-reversion hypothesis reverses the RSI momentum vote.',
  ),
  candidate(
    'drop-sma-leg',
    'drop-leg',
    'simulation-drop-sma.v1',
    { weights: { sma: 0 } },
    defaultParams(),
    'Ablation isolates the value of the SMA leg.',
  ),
  candidate(
    'drop-rsi-leg',
    'drop-leg',
    'simulation-drop-rsi.v1',
    { weights: { rsi: 0 } },
    defaultParams(),
    'Ablation isolates the value of the RSI leg.',
  ),
  candidate(
    'drop-macd-leg',
    'drop-leg',
    'simulation-drop-macd.v1',
    { weights: { macd: 0 } },
    defaultParams(),
    'Ablation isolates the value of the MACD leg.',
  ),
  candidate(
    'drop-slope-leg',
    'drop-leg',
    'simulation-drop-slope.v1',
    { weights: { slope: 0 } },
    defaultParams(),
    'Ablation isolates the value of the slope leg.',
  ),
  candidate(
    'ladder-patient',
    'strategy-ladder',
    'simulation-ladder-patient.v1',
    {},
    defaultParams(),
    'Wider entry and exit hysteresis may reduce turnover.',
    { entry: 0.6, exit: 0.4 },
  ),
  candidate(
    'ladder-twitchy',
    'strategy-ladder',
    'simulation-ladder-twitchy.v1',
    {},
    defaultParams(),
    'Narrower hysteresis measures turnover sensitivity.',
    { entry: 0.52, exit: 0.48 },
  ),
  candidate(
    'session-gate',
    'session-gate',
    'simulation-session-gate.v1',
    { sessionGateUtc: [7, 17] },
    defaultParams(),
    'UTC European session gate tests time-of-day exposure.',
  ),
  candidate(
    'composite-trend-confirmation',
    'composite',
    'simulation-composite-trend.v1',
    {
      useEmaForTrend: true,
      macdSource: 'histogram',
      slopeEpsilon: 0.25,
      requireTrendConfirmation: true,
    },
    defaultParams(),
    'EMA trend direction is accepted only with confirming MACD histogram and structural slope votes.',
  ),
  candidate(
    'composite-rsi-atr-reversion',
    'composite',
    'simulation-composite-reversion.v1',
    { rsiContrarian: true, atrGateRatio: 0.025 },
    defaultParams(),
    'Contrarian RSI votes are evaluated only when ATR remains below the configured volatility ceiling.',
  ),
  candidate(
    'composite-session-trend',
    'composite',
    'simulation-composite-session.v1',
    { useEmaForTrend: true, sessionGateUtc: [7, 17], quorum: 2 },
    defaultParams(),
    'A UTC session gate requires at least two existing directional feature votes for a trend forecast.',
  ),
  candidate(
    'micro-trend-pullback',
    'micro-strategy',
    'simulation-micro-trend-pullback.v1',
    {},
    {
      ...defaultParams(),
      smaPeriod: 50,
      emaPeriod: 21,
      rsiPeriod: 14,
      atrPeriod: 14,
      paramSetVersion: 'micro-trend-pullback.v1',
    },
    'Long while EMA9 exceeds EMA21, close exceeds SMA50 and RSI14 is below 42; exit below EMA21 or above RSI68.',
    undefined,
    'trend-pullback',
  ),
  candidate(
    'micro-bollinger-reversion',
    'micro-strategy',
    'simulation-micro-bollinger-reversion.v1',
    {},
    {
      ...defaultParams(),
      smaPeriod: 20,
      rsiPeriod: 14,
      atrPeriod: 14,
      paramSetVersion: 'micro-bollinger-reversion.v1',
    },
    'Long below BB20 lower at RSI below 32 in a low ATR regime; exit at BB20 mid or RSI above 55.',
    undefined,
    'bollinger-reversion',
  ),
  candidate(
    'micro-donchian-breakout',
    'micro-strategy',
    'simulation-micro-donchian-breakout.v1',
    {},
    {
      ...defaultParams(),
      rsiPeriod: 14,
      atrPeriod: 14,
      paramSetVersion: 'micro-donchian-breakout.v1',
    },
    'Long on a previous-20-bar Donchian breakout confirmed by prior-volume mean; exit below channel mid.',
    undefined,
    'donchian-breakout',
  ),
  candidate(
    'micro-regime-adapter',
    'micro-strategy',
    'simulation-micro-regime-adapter.v1',
    {},
    {
      ...defaultParams(),
      smaPeriod: 50,
      emaPeriod: 21,
      rsiPeriod: 14,
      atrPeriod: 14,
      paramSetVersion: 'micro-regime-adapter.v1',
    },
    'Selects trend rules above ATR percentile 60 and range rules below 40, retaining the prior regime in between.',
    undefined,
    'regime-adapter',
  ),
]

export function getAllCandidates(): readonly SimulationCandidate[] {
  return SIMULATION_CANDIDATES
}

export function getActiveCandidates(): readonly SimulationCandidate[] {
  return SIMULATION_CANDIDATES.filter(
    (candidate) => candidate.status === 'active',
  )
}

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
  const ordered = [...candidates]
    .map(({ status: _status, ...candidate }) => candidate)
    .sort((left, right) =>
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
