import type {
  DataFreshness,
  ForecastHorizon,
  GapMetrics,
  TechnicalFeatureSnapshot,
  TimestampMs,
} from '../../domain/contracts.ts'
import { contentHashFor } from '../forecasts/forecast-hashing.ts'
import {
  NEWS_ANALYSIS_RULE_VERSION,
  NEWS_ANALYSIS_VERSION,
  type NewsAnalysisSnapshot,
} from '../news/news-analysis.ts'

export const TECHNICAL_SCORE_VERSION = 'technical-score.v1' as const
export const TECHNICAL_SCORE_RULE_VERSION = 'technical-direction.v1' as const
export const NEWS_SCORE_VERSION = 'news-score.v1' as const
export const NEWS_SCORE_RULE_VERSION = NEWS_ANALYSIS_RULE_VERSION
export const COMPARISON_VERSION = 'signal-comparison.v1' as const
export const COMPARISON_RULE_VERSION = 'comparison.v1' as const
export const NO_COMBINATION_RULE_VERSION = 'no-combination.v1' as const

export type ComparisonDirection = 'up' | 'down' | 'flat'
export type ScoreStatus = 'scored' | 'abstain'

export type ScoreAbstentionReason =
  | 'missing_technical_evidence'
  | 'stale_technical_evidence'
  | 'uncertain_technical_evidence'
  | 'future_technical_evidence'
  | 'invalid_technical_evidence'
  | 'missing_news_evidence'
  | 'stale_news_evidence'
  | 'uncertain_news_evidence'
  | 'retracted_news_evidence'
  | 'future_news_evidence'
  | 'invalid_news_evidence'
  | 'cutoff_mismatch'
  | 'horizon_mismatch'

export interface DirectionalProbabilities {
  readonly probabilityUp: number
  readonly probabilityDown: number
  readonly probabilityFlat: number
}

export interface ComparisonContext {
  readonly asOfTimestamp: TimestampMs
  readonly eventCutoff: TimestampMs
  readonly horizon: ForecastHorizon
}

export interface TechnicalFeatureReference {
  readonly version: string
  readonly contentHash: string
  readonly asOfTimestamp: TimestampMs
  readonly isClosed: boolean
  readonly ready: boolean
}

export interface TechnicalComponentVote {
  readonly name: string
  readonly vote: -1 | 0 | 1
  readonly explanation: string
}

export interface TechnicalScoreSnapshot extends ComparisonContext {
  readonly version: typeof TECHNICAL_SCORE_VERSION
  readonly ruleVersion: typeof TECHNICAL_SCORE_RULE_VERSION
  readonly instrumentId: 'BTC-EUR'
  readonly status: ScoreStatus
  readonly featureReference: TechnicalFeatureReference | null
  readonly freshness: DataFreshness | null
  readonly gaps: GapMetrics | null
  readonly score?: number
  readonly direction?: ComparisonDirection
  readonly probabilities?: DirectionalProbabilities
  readonly componentVotes: readonly TechnicalComponentVote[]
  readonly reasons: readonly string[]
  readonly abstentionReasons: readonly ScoreAbstentionReason[]
  readonly contentHash: string
}

export interface NewsAnalysisReference {
  readonly version: typeof NEWS_ANALYSIS_VERSION
  readonly ruleVersion: string
  readonly contentHash: string
  readonly asOfTimestamp: TimestampMs
  readonly eventCutoff: TimestampMs
  readonly requestedHorizon: ForecastHorizon
}

export interface NewsScoreEvidenceReference {
  readonly evidenceId: string
  readonly evidenceVersion: string
  readonly contentHash: string
  readonly freshness: {
    readonly ageMs: number
    readonly staleAfterMs: number
    readonly isStale: boolean
  }
}

export interface NewsScoreExcludedReference {
  readonly evidenceId: string
  readonly evidenceVersion: string
  readonly contentHash: string
  readonly reason: string
}

export interface NewsFreshnessSummary {
  readonly maxAgeMs: number
  readonly staleAfterMs: number
  readonly staleItemCount: number
  readonly itemCount: number
}

export interface NewsScoreSnapshot extends ComparisonContext {
  readonly version: typeof NEWS_SCORE_VERSION
  readonly ruleVersion: typeof NEWS_SCORE_RULE_VERSION
  readonly instrumentId: 'BTC-EUR'
  readonly status: ScoreStatus
  readonly analysisReference: NewsAnalysisReference | null
  readonly evidenceReferences: readonly NewsScoreEvidenceReference[]
  readonly excludedEvidenceReferences: readonly NewsScoreExcludedReference[]
  readonly freshness: NewsFreshnessSummary | null
  readonly gaps: null
  readonly analyzedItemCount: number
  readonly score?: number
  readonly direction?: ComparisonDirection
  readonly probabilities?: DirectionalProbabilities
  readonly reasons: readonly string[]
  readonly abstentionReasons: readonly ScoreAbstentionReason[]
  readonly contentHash: string
}

export interface SignalReference {
  readonly scoreVersion: string
  readonly scoreRuleVersion: string
  readonly scoreHash: string
  readonly asOfTimestamp: TimestampMs
  readonly eventCutoff: TimestampMs
  readonly horizon: ForecastHorizon
  readonly freshness: DataFreshness | NewsFreshnessSummary | null
  readonly gaps: GapMetrics | null
  readonly featureVersion?: string
  readonly featureHash?: string
  readonly analysisVersion?: string
  readonly analysisRuleVersion?: string
  readonly analysisHash?: string
  readonly evidenceReferences?: readonly NewsScoreEvidenceReference[]
  readonly excludedEvidenceReferences?: readonly NewsScoreExcludedReference[]
}

export type ComparisonStatus = 'agreement' | 'disagreement' | 'abstain'

export interface ComparisonReason {
  readonly code: string
  readonly message: string
  readonly details?: readonly string[]
}

export interface SignalComparisonSnapshot extends ComparisonContext {
  readonly version: typeof COMPARISON_VERSION
  readonly ruleVersion: typeof COMPARISON_RULE_VERSION
  readonly instrumentId: 'BTC-EUR'
  readonly status: ComparisonStatus
  readonly technicalDirection?: ComparisonDirection
  readonly newsDirection?: ComparisonDirection
  readonly technicalReference: SignalReference | null
  readonly newsReference: SignalReference | null
  readonly reasons: readonly ComparisonReason[]
  readonly combination: {
    readonly enabled: false
    readonly ruleVersion: typeof NO_COMBINATION_RULE_VERSION
    readonly reason: string
  }
  readonly contentHash: string
}

export interface TechnicalScoreInput extends ComparisonContext {
  readonly featureSnapshot: TechnicalFeatureSnapshot | null
  readonly referencePrice: number
  readonly freshness: DataFreshness | null
  readonly gaps: GapMetrics | null
}

export interface NewsScoreInput extends ComparisonContext {
  readonly analysis: NewsAnalysisSnapshot | null
}

export interface CompareSignalsInput extends ComparisonContext {
  readonly technical: TechnicalScoreSnapshot | null
  readonly news: NewsScoreSnapshot | null
}

const REQUIRED_FEATURES = [
  'sma',
  'rsi',
  'macdHistogram',
  'structuralSlope',
] as const

export function scoreTechnicalFeatures(
  input: TechnicalScoreInput,
): TechnicalScoreSnapshot {
  const featureReference =
    input.featureSnapshot === null
      ? null
      : {
          version: input.featureSnapshot.version,
          contentHash: contentHashFor(input.featureSnapshot),
          asOfTimestamp: input.featureSnapshot.asOfTimestamp,
          isClosed: input.featureSnapshot.isClosed,
          ready: input.featureSnapshot.ready,
        }
  const base = {
    version: TECHNICAL_SCORE_VERSION,
    ruleVersion: TECHNICAL_SCORE_RULE_VERSION,
    instrumentId: 'BTC-EUR' as const,
    asOfTimestamp: input.asOfTimestamp,
    eventCutoff: input.eventCutoff,
    horizon: input.horizon,
    featureReference,
    freshness: input.freshness,
    gaps: input.gaps,
    componentVotes: [] as readonly TechnicalComponentVote[],
    reasons: [] as readonly string[],
    abstentionReasons: [] as readonly ScoreAbstentionReason[],
  } satisfies Omit<
    TechnicalScoreSnapshot,
    'status' | 'contentHash' | 'score' | 'direction' | 'probabilities'
  >

  const abstention = technicalAbstentionReasons(input)
  if (abstention.length > 0)
    return withHash({
      ...base,
      status: 'abstain',
      abstentionReasons: abstention,
    })

  const snapshot = input.featureSnapshot!
  const values = snapshot.values
  const components: TechnicalComponentVote[] = [
    {
      name: 'reference_vs_sma',
      vote: voteFor(input.referencePrice - values.sma!),
      explanation: 'Reference price is compared with the closed-candle SMA.',
    },
    {
      name: 'rsi_momentum',
      vote: values.rsi! > 55 ? 1 : values.rsi! < 45 ? -1 : 0,
      explanation: 'RSI outside the neutral 45-55 band supplies direction.',
    },
    {
      name: 'macd_histogram',
      vote: voteFor(values.macdHistogram!),
      explanation: 'MACD histogram sign supplies direction.',
    },
    {
      name: 'structural_slope',
      vote: voteFor(values.structuralSlope!),
      explanation: 'Structural slope sign supplies direction.',
    },
  ]
  const score = components.reduce(
    (total, component) => total + component.vote,
    0,
  )
  const direction: ComparisonDirection =
    score > 0 ? 'up' : score < 0 ? 'down' : 'flat'
  const probabilities = probabilitiesForScore(score)
  return withHash({
    ...base,
    status: 'scored',
    score,
    direction,
    probabilities,
    componentVotes: components,
    reasons: [
      'Technical direction is calculated from four explicit indicator votes only.',
      'Technical evidence is scored independently; no news evidence is read or weighted.',
    ],
  })
}

export function scoreNewsAnalysis(input: NewsScoreInput): NewsScoreSnapshot {
  const analysis = input.analysis
  const base = {
    version: NEWS_SCORE_VERSION,
    ruleVersion: NEWS_SCORE_RULE_VERSION,
    instrumentId: 'BTC-EUR' as const,
    asOfTimestamp: input.asOfTimestamp,
    eventCutoff: input.eventCutoff,
    horizon: input.horizon,
    analysisReference:
      analysis === null
        ? null
        : {
            version: analysis.version,
            ruleVersion: analysis.ruleVersion,
            contentHash: analysis.contentHash,
            asOfTimestamp: analysis.asOfTimestamp,
            eventCutoff: analysis.eventCutoff,
            requestedHorizon: analysis.requestedHorizon,
          },
    evidenceReferences:
      analysis === null ? [] : evidenceReferencesFor(analysis),
    excludedEvidenceReferences:
      analysis === null ? [] : excludedReferencesFor(analysis),
    freshness: analysis === null ? null : freshnessFor(analysis),
    gaps: null,
    analyzedItemCount: 0,
    reasons: [] as readonly string[],
    abstentionReasons: [] as readonly ScoreAbstentionReason[],
  } satisfies Omit<
    NewsScoreSnapshot,
    'status' | 'contentHash' | 'score' | 'direction' | 'probabilities'
  >

  const abstention = newsAbstentionReasons(input)
  if (abstention.length > 0)
    return withHash({
      ...base,
      status: 'abstain',
      abstentionReasons: abstention,
    })

  const analyzed = analysis!.items.filter(
    (item) => item.status === 'analyzed' && item.horizon === input.horizon,
  )
  const score = analyzed.reduce(
    (total, item) =>
      total +
      (item.direction === 'bullish'
        ? 1
        : item.direction === 'bearish'
          ? -1
          : 0),
    0,
  )
  const direction: ComparisonDirection =
    score > 0 ? 'up' : score < 0 ? 'down' : 'flat'
  const ignoredReasons = analysis!.items
    .filter((item) => item.status === 'abstain')
    .map((item) => item.reason)
    .filter((reason): reason is string => reason !== undefined)
  return withHash({
    ...base,
    status: 'scored',
    analyzedItemCount: analyzed.length,
    score,
    direction,
    probabilities: probabilitiesForScore(score, analyzed.length),
    reasons: [
      'News direction counts only analyzed items for the requested horizon.',
      'News evidence is scored independently; no technical evidence is read or weighted.',
      ...(ignoredReasons.length === 0
        ? []
        : [`Some news items were abstained: ${ignoredReasons.join(', ')}.`]),
    ],
  })
}

export function compareTechnicalAndNews(
  input: CompareSignalsInput,
): SignalComparisonSnapshot {
  const technicalReference = referenceForTechnical(input.technical)
  const newsReference = referenceForNews(input.news)
  const reasons: ComparisonReason[] = []
  if (input.technical === null)
    reasons.push({
      code: 'missing_technical_score',
      message: 'Technical score is missing; comparison cannot combine sources.',
    })
  else if (input.technical.status === 'abstain')
    reasons.push({
      code: 'technical_abstention',
      message: 'Technical score abstained and cannot establish a comparison.',
      details: input.technical.abstentionReasons,
    })
  if (input.news === null)
    reasons.push({
      code: 'missing_news_score',
      message: 'News score is missing; comparison cannot combine sources.',
    })
  else if (input.news.status === 'abstain')
    reasons.push({
      code: 'news_abstention',
      message: 'News score abstained and cannot establish a comparison.',
      details: input.news.abstentionReasons,
    })

  const contextIssues = contextIssuesFor(input)
  reasons.push(...contextIssues)
  if (reasons.length === 0) {
    const technical = input.technical!
    const news = input.news!
    if (technical.direction === news.direction) {
      reasons.push({
        code: 'same_direction',
        message: `Both independent scores point ${technical.direction}.`,
      })
    } else {
      reasons.push({
        code: 'different_direction',
        message: `Independent scores point ${technical.direction} and ${news.direction}.`,
      })
    }
  }

  const status: ComparisonStatus =
    reasons.length === 1 && reasons[0]?.code === 'same_direction'
      ? 'agreement'
      : reasons.length === 1 && reasons[0]?.code === 'different_direction'
        ? 'disagreement'
        : 'abstain'
  return withHash({
    version: COMPARISON_VERSION,
    ruleVersion: COMPARISON_RULE_VERSION,
    instrumentId: 'BTC-EUR' as const,
    asOfTimestamp: input.asOfTimestamp,
    eventCutoff: input.eventCutoff,
    horizon: input.horizon,
    status,
    ...(input.technical?.direction === undefined
      ? {}
      : { technicalDirection: input.technical.direction }),
    ...(input.news?.direction === undefined
      ? {}
      : { newsDirection: input.news.direction }),
    technicalReference,
    newsReference,
    reasons,
    combination: {
      enabled: false as const,
      ruleVersion: NO_COMBINATION_RULE_VERSION,
      reason:
        'Combination is deliberately disabled until comparative evidence is reviewed.',
    },
  })
}

function technicalAbstentionReasons(
  input: TechnicalScoreInput,
): readonly ScoreAbstentionReason[] {
  if (input.featureSnapshot === null) return ['missing_technical_evidence']
  const snapshot = input.featureSnapshot
  if (snapshot.asOfTimestamp > input.eventCutoff)
    return ['future_technical_evidence']
  if (!validFreshness(input.freshness)) return ['invalid_technical_evidence']
  if (input.freshness!.isStale || input.freshness!.clockInverted)
    return ['stale_technical_evidence']
  if (!validGaps(input.gaps) || input.gaps!.sequenceAvailable === false)
    return ['uncertain_technical_evidence']
  if (
    input.gaps!.gapCount > 0 ||
    (input.gaps!.rate !== null && input.gaps!.rate > 0)
  )
    return ['uncertain_technical_evidence']
  if (!Number.isFinite(input.referencePrice) || input.referencePrice <= 0)
    return ['invalid_technical_evidence']
  if (
    !snapshot.isClosed ||
    !snapshot.ready ||
    snapshot.warmUp.missingCandles > 0
  )
    return ['uncertain_technical_evidence']
  if (REQUIRED_FEATURES.some((key) => !Number.isFinite(snapshot.values[key])))
    return ['uncertain_technical_evidence']
  return []
}

function newsAbstentionReasons(
  input: NewsScoreInput,
): readonly ScoreAbstentionReason[] {
  const analysis = input.analysis
  if (analysis === null) return ['missing_news_evidence']
  if (analysis.version !== NEWS_ANALYSIS_VERSION)
    return ['invalid_news_evidence']
  if (
    analysis.asOfTimestamp !== input.asOfTimestamp ||
    analysis.eventCutoff !== input.eventCutoff
  )
    return ['cutoff_mismatch']
  if (analysis.requestedHorizon !== input.horizon) return ['horizon_mismatch']
  if (analysis.contentHash !== hashWithoutContentHash(analysis))
    return ['invalid_news_evidence']
  const analyzed = analysis.items.filter(
    (item) => item.status === 'analyzed' && item.horizon === input.horizon,
  )
  if (analyzed.length > 0) return []
  if (analysis.excluded.some((item) => item.reason === 'retracted_evidence'))
    return ['retracted_news_evidence']
  if (
    analysis.items.some(
      (item) => item.status === 'abstain' && item.reason === 'stale_evidence',
    )
  )
    return ['stale_news_evidence']
  if (analysis.excluded.some((item) => item.reason === 'future_evidence'))
    return ['future_news_evidence']
  if (analysis.items.some((item) => item.status === 'abstain'))
    return ['uncertain_news_evidence']
  return ['missing_news_evidence']
}

function contextIssuesFor(input: CompareSignalsInput): ComparisonReason[] {
  const reasons: ComparisonReason[] = []
  for (const [name, score] of [
    ['technical', input.technical],
    ['news', input.news],
  ] as const) {
    if (score === null) continue
    if (
      score.asOfTimestamp !== input.asOfTimestamp ||
      score.eventCutoff !== input.eventCutoff
    )
      reasons.push({
        code: 'cutoff_mismatch',
        message: `${name} score does not use the requested cutoff.`,
      })
    if (score.horizon !== input.horizon)
      reasons.push({
        code: 'horizon_mismatch',
        message: `${name} score does not use the requested horizon.`,
      })
    if (score.contentHash !== hashWithoutContentHash(score))
      reasons.push({
        code: `invalid_${name}_score`,
        message: `${name} score content hash is invalid.`,
      })
  }
  return reasons
}

function referenceForTechnical(
  snapshot: TechnicalScoreSnapshot | null,
): SignalReference | null {
  if (snapshot === null) return null
  return {
    scoreVersion: snapshot.version,
    scoreRuleVersion: snapshot.ruleVersion,
    scoreHash: snapshot.contentHash,
    asOfTimestamp: snapshot.asOfTimestamp,
    eventCutoff: snapshot.eventCutoff,
    horizon: snapshot.horizon,
    freshness: snapshot.freshness,
    gaps: snapshot.gaps,
    ...(snapshot.featureReference === null
      ? {}
      : {
          featureVersion: snapshot.featureReference.version,
          featureHash: snapshot.featureReference.contentHash,
        }),
  }
}

function referenceForNews(
  snapshot: NewsScoreSnapshot | null,
): SignalReference | null {
  if (snapshot === null) return null
  return {
    scoreVersion: snapshot.version,
    scoreRuleVersion: snapshot.ruleVersion,
    scoreHash: snapshot.contentHash,
    asOfTimestamp: snapshot.asOfTimestamp,
    eventCutoff: snapshot.eventCutoff,
    horizon: snapshot.horizon,
    freshness: snapshot.freshness,
    gaps: snapshot.gaps,
    ...(snapshot.analysisReference === null
      ? {}
      : {
          analysisVersion: snapshot.analysisReference.version,
          analysisRuleVersion: snapshot.analysisReference.ruleVersion,
          analysisHash: snapshot.analysisReference.contentHash,
          evidenceReferences: snapshot.evidenceReferences,
          excludedEvidenceReferences: snapshot.excludedEvidenceReferences,
        }),
  }
}

function evidenceReferencesFor(
  analysis: NewsAnalysisSnapshot,
): readonly NewsScoreEvidenceReference[] {
  return analysis.items.map((item) => ({
    evidenceId: item.evidenceId,
    evidenceVersion: item.evidenceVersion,
    contentHash: item.contentHash,
    freshness: item.freshness,
  }))
}

function excludedReferencesFor(
  analysis: NewsAnalysisSnapshot,
): readonly NewsScoreExcludedReference[] {
  return analysis.excluded.map((item) => ({
    evidenceId: item.evidenceId,
    evidenceVersion: item.evidenceVersion,
    contentHash: item.contentHash,
    reason: item.reason,
  }))
}

function freshnessFor(analysis: NewsAnalysisSnapshot): NewsFreshnessSummary {
  const ages = analysis.items.map((item) => item.freshness.ageMs)
  return {
    maxAgeMs: ages.length === 0 ? 0 : Math.max(...ages),
    staleAfterMs:
      analysis.items[0]?.freshness.staleAfterMs ?? Number.POSITIVE_INFINITY,
    staleItemCount: analysis.items.filter((item) => item.freshness.isStale)
      .length,
    itemCount: analysis.items.length,
  }
}

function validFreshness(value: DataFreshness | null): value is DataFreshness {
  return (
    value !== null &&
    Number.isFinite(value.ageMs) &&
    value.ageMs >= 0 &&
    typeof value.isStale === 'boolean' &&
    typeof value.clockInverted === 'boolean'
  )
}

function validGaps(value: GapMetrics | null): value is GapMetrics {
  return (
    value !== null &&
    Number.isSafeInteger(value.gapCount) &&
    value.gapCount >= 0 &&
    Number.isSafeInteger(value.expectedOpportunities) &&
    value.expectedOpportunities >= 0 &&
    (value.rate === null ||
      (Number.isFinite(value.rate) && value.rate >= 0 && value.rate <= 1)) &&
    typeof value.sequenceAvailable === 'boolean'
  )
}

function voteFor(value: number): -1 | 0 | 1 {
  return value > 0 ? 1 : value < 0 ? -1 : 0
}

function probabilitiesForScore(
  score: number,
  opportunities = 4,
): DirectionalProbabilities {
  if (score === 0)
    return { probabilityUp: 0.3, probabilityDown: 0.3, probabilityFlat: 0.4 }
  const strength = Math.min(Math.abs(score) / Math.max(opportunities, 1), 1)
  const winner = 0.45 + 0.1 * strength
  const loser = 0.25 - 0.05 * strength
  const flat = 1 - winner - loser
  return score > 0
    ? { probabilityUp: winner, probabilityDown: loser, probabilityFlat: flat }
    : { probabilityUp: loser, probabilityDown: winner, probabilityFlat: flat }
}

function withHash<T extends object>(
  value: T,
): T & { readonly contentHash: string } {
  return { ...value, contentHash: contentHashFor(value) }
}

function hashWithoutContentHash(value: object): string {
  const { contentHash, ...withoutHash } = value as { contentHash?: string }
  void contentHash
  return contentHashFor(withoutHash)
}
