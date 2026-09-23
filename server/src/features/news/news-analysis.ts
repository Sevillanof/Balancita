import { createHash } from 'node:crypto'
import {
  type ForecastHorizon,
  type NewsEvidenceRecord,
  type NewsEventTaxonomy,
  type NewsRelevance,
  type TimestampMs,
} from '../../domain/contracts.ts'
import { evaluateNewsSource } from '../../domain/source-policy.ts'
import type { GeminiClient } from '../../platform/gemini/gemini-client.ts'
import {
  NEWS_RELEVANCE_RULE_VERSION,
  NEWS_TAXONOMY_RULE_VERSION,
  classifyNewsRelevance,
  classifyNewsTaxonomy,
  contentHashForNewsEvidence,
} from './rss-normalizer.ts'

export const NEWS_ANALYSIS_VERSION = 'news-analysis.v1'
export const NEWS_ANALYSIS_RULE_VERSION = 'news-impact.v1'
export const NEWS_GEMINI_VERSION = 'news-gemini.v1'
export const NEWS_DISCLAIMER =
  'Análisis informativo e incierto: no es asesoramiento financiero y no ejecuta órdenes.'

export type NewsAnalysisStatus = 'analyzed' | 'abstain'
export type NewsSentiment =
  'positive' | 'negative' | 'mixed' | 'neutral' | 'uncertain'
export type NewsImpact = 'high' | 'medium' | 'low' | 'uncertain'
export type NewsDirection = 'bullish' | 'bearish' | 'neutral' | 'uncertain'

export interface NewsAnalysisInput {
  readonly evidence: readonly NewsEvidenceRecord[]
  readonly asOfTimestamp: TimestampMs
  readonly eventCutoff: TimestampMs
  readonly horizon: ForecastHorizon
  readonly staleAfterMs: number
}

export interface NewsFreshness {
  readonly ageMs: number
  readonly staleAfterMs: number
  readonly isStale: boolean
}

export interface NewsAnalysisItem {
  readonly evidenceId: string
  readonly evidenceVersion: string
  readonly contentHash: string
  readonly relevance: NewsRelevance
  readonly relevanceRuleVersion: string
  readonly taxonomy: NewsEventTaxonomy
  readonly taxonomyRuleVersion: string
  readonly sentiment: NewsSentiment
  readonly impact: NewsImpact
  readonly direction: NewsDirection
  readonly confidence: number
  readonly horizon: ForecastHorizon | null
  readonly status: NewsAnalysisStatus
  readonly reasons: readonly string[]
  readonly reason?: string
  readonly freshness: NewsFreshness
}

export type NewsExclusionReason =
  | 'duplicate_content_hash'
  | 'future_evidence'
  | 'retracted_evidence'
  | 'source_policy_rejected'
  | 'content_hash_mismatch'
  | 'classification_mismatch'
  | 'superseded_version'

export interface NewsAnalysisExclusion {
  readonly evidenceId: string
  readonly evidenceVersion: string
  readonly contentHash: string
  readonly reason: NewsExclusionReason
}

export interface NewsAnalysisSummary {
  readonly totalItems: number
  readonly analyzedItems: number
  readonly abstainedItems: number
  readonly relevantItems: number
}

export interface NewsAnalysisSnapshot {
  readonly version: typeof NEWS_ANALYSIS_VERSION
  readonly ruleVersion: typeof NEWS_ANALYSIS_RULE_VERSION
  readonly instrumentId: 'BTC-EUR'
  readonly asOfTimestamp: TimestampMs
  readonly eventCutoff: TimestampMs
  readonly requestedHorizon: ForecastHorizon
  readonly items: readonly NewsAnalysisItem[]
  readonly excluded: readonly NewsAnalysisExclusion[]
  readonly summary: NewsAnalysisSummary
  readonly contentHash: string
}

export interface NewsGeminiItem {
  readonly evidenceId: string
  readonly evidenceVersion: string
  readonly contentHash: string
  readonly relevance: NewsRelevance
  readonly taxonomy: NewsEventTaxonomy
  readonly sentiment: NewsSentiment
  readonly impact: NewsImpact
  readonly direction: NewsDirection
  readonly confidence: number
  readonly horizon: ForecastHorizon | null
  readonly status: NewsAnalysisStatus
  readonly reasons: readonly string[]
}

export interface NewsGeminiResponse {
  readonly version: typeof NEWS_GEMINI_VERSION
  readonly items: readonly NewsGeminiItem[]
  readonly uncertainty: readonly string[]
  readonly disclaimer: string
}

export interface GeminiNewsAdapterOptions {
  readonly client: GeminiClient
  readonly model: string
  readonly timeoutMs: number
  readonly maxOutputTokens: number
  readonly quota?: { readonly tryConsume: () => boolean }
}

export interface GeminiNewsAnalysisResult {
  readonly source: 'gemini' | 'deterministic'
  readonly snapshot: NewsAnalysisSnapshot
  readonly fallbackReason?:
    | 'manual_opt_in_required'
    | 'gemini_timeout'
    | 'gemini_quota'
    | 'gemini_invalid_json'
    | 'gemini_invalid_response'
    | 'gemini_upstream'
}

const HORIZONS = new Set<ForecastHorizon>(['15m', '1h', '4h', '24h'])
const SENTIMENTS = new Set<NewsSentiment>([
  'positive',
  'negative',
  'mixed',
  'neutral',
  'uncertain',
])
const IMPACTS = new Set<NewsImpact>(['high', 'medium', 'low', 'uncertain'])
const DIRECTIONS = new Set<NewsDirection>([
  'bullish',
  'bearish',
  'neutral',
  'uncertain',
])

type Cue = { readonly label: string; readonly pattern: RegExp }

const POSITIVE_CUES: readonly Cue[] = [
  { label: 'approved', pattern: /\bapprove(?:d|s)?\b/ },
  { label: 'adoption', pattern: /\badopt(?:ed|ion|s)?\b/ },
  { label: 'inflow', pattern: /\binflows?\b/ },
  { label: 'growth', pattern: /\bgrowth\b/ },
  { label: 'integration', pattern: /\bintegration\b/ },
  { label: 'launch', pattern: /\blaunche?[sd]?\b/ },
]

const NEGATIVE_CUES: readonly Cue[] = [
  { label: 'hack', pattern: /\bhack(?:ed|ing)?\b/ },
  { label: 'breach', pattern: /\bbreach(?:ed|es)?\b/ },
  { label: 'exploit', pattern: /\bexploit(?:ed|s)?\b/ },
  { label: 'ban', pattern: /\bbann?ed?\b/ },
  { label: 'enforcement', pattern: /\benforcement\b/ },
  { label: 'sanctions', pattern: /\bsanctions?\b/ },
  { label: 'outage', pattern: /\boutage\b/ },
  { label: 'insolvency', pattern: /\binsolvenc(?:y|ies)\b/ },
  { label: 'bankruptcy', pattern: /\bbankrupt(?:cy|cies)\b/ },
  { label: 'outflow', pattern: /\boutflows?\b/ },
]

const HIGH_IMPACT_CUES: readonly Cue[] = [
  { label: 'hack', pattern: /\bhack(?:ed|ing)?\b/ },
  { label: 'breach', pattern: /\bbreach(?:ed|es)?\b/ },
  { label: 'exploit', pattern: /\bexploit(?:ed|s)?\b/ },
  { label: 'ban', pattern: /\bbann?ed?\b/ },
  { label: 'enforcement', pattern: /\benforcement\b/ },
  { label: 'insolvency', pattern: /\binsolvenc(?:y|ies)\b/ },
  { label: 'bankruptcy', pattern: /\bbankrupt(?:cy|cies)\b/ },
]

export function analyzeNews(input: NewsAnalysisInput): NewsAnalysisSnapshot {
  const excluded: NewsAnalysisExclusion[] = []
  const items: NewsAnalysisItem[] = []
  const uniqueEvidence = removeExactDuplicates(input.evidence, excluded)
  const latest = latestVersions(uniqueEvidence, excluded)
  const seenHashes = new Set<string>()

  for (const evidence of latest) {
    const reference = referenceFor(evidence)
    if (evidence.correctionStatus === 'retracted') {
      excluded.push({ ...reference, reason: 'retracted_evidence' })
      continue
    }

    const policy = evaluateNewsSource(evidence)
    if (!policy.accepted) {
      excluded.push({ ...reference, reason: 'source_policy_rejected' })
      continue
    }
    if (
      contentHashForNewsEvidence(evidenceOnly(evidence)) !==
      evidence.contentHash
    ) {
      excluded.push({ ...reference, reason: 'content_hash_mismatch' })
      continue
    }
    if (seenHashes.has(evidence.contentHash)) {
      excluded.push({ ...reference, reason: 'duplicate_content_hash' })
      continue
    }
    seenHashes.add(evidence.contentHash)
    if (
      evidence.publishedAt > input.eventCutoff ||
      evidence.ingestedAt > input.eventCutoff
    ) {
      excluded.push({ ...reference, reason: 'future_evidence' })
      continue
    }

    const text = allowedText(evidence)
    const relevance = classifyNewsRelevance(text)
    const taxonomy = classifyNewsTaxonomy(text)
    if (
      evidence.relevanceRuleVersion !== NEWS_RELEVANCE_RULE_VERSION ||
      evidence.taxonomyRuleVersion !== NEWS_TAXONOMY_RULE_VERSION ||
      evidence.relevance !== relevance ||
      evidence.taxonomy !== taxonomy.taxonomy
    ) {
      excluded.push({ ...reference, reason: 'classification_mismatch' })
      continue
    }

    const freshness = freshnessFor(evidence.publishedAt, input)
    const assessment = assessmentFor(
      text,
      relevance,
      taxonomy.taxonomy,
      evidence,
    )
    if (freshness.isStale && assessment.status === 'analyzed') {
      items.push({
        ...reference,
        ...assessment,
        status: 'abstain',
        confidence: 0,
        direction: 'uncertain',
        horizon: null,
        reason: 'stale_evidence',
        reasons: [
          ...assessment.reasons,
          'Evidence exceeds the freshness boundary.',
        ],
        freshness,
      })
    } else {
      items.push({ ...reference, ...assessment, freshness })
    }
  }

  const withoutHash: Omit<NewsAnalysisSnapshot, 'contentHash'> = {
    version: NEWS_ANALYSIS_VERSION,
    ruleVersion: NEWS_ANALYSIS_RULE_VERSION,
    instrumentId: 'BTC-EUR',
    asOfTimestamp: input.asOfTimestamp,
    eventCutoff: input.eventCutoff,
    requestedHorizon: input.horizon,
    items,
    excluded: [...excluded].sort(compareExclusions),
    summary: summaryFor(items),
  }
  return { ...withoutHash, contentHash: hashOf(withoutHash) }
}

export class GeminiNewsAnalysisAdapter {
  private readonly client: GeminiClient
  private readonly model: string
  private readonly timeoutMs: number
  private readonly maxOutputTokens: number
  private readonly quota: GeminiNewsAdapterOptions['quota']

  constructor(options: GeminiNewsAdapterOptions) {
    this.client = options.client
    this.model = options.model
    this.timeoutMs = options.timeoutMs
    this.maxOutputTokens = options.maxOutputTokens
    this.quota = options.quota
  }

  async analyze(
    input: NewsAnalysisInput,
    options: { readonly manual?: boolean } = {},
  ): Promise<GeminiNewsAnalysisResult> {
    const deterministic = analyzeNews(input)
    if (options.manual !== true)
      return {
        source: 'deterministic',
        snapshot: deterministic,
        fallbackReason: 'manual_opt_in_required',
      }

    const eligibleItems = deterministic.items
    if (eligibleItems.length === 0)
      return { source: 'deterministic', snapshot: deterministic }
    if (this.quota !== undefined && !this.quota.tryConsume())
      return {
        source: 'deterministic',
        snapshot: deterministic,
        fallbackReason: 'gemini_quota',
      }

    let text: string
    try {
      text = await this.client.generateStructuredText({
        model: this.model,
        prompt: buildNewsPrompt(input, eligibleItems),
        maxOutputTokens: this.maxOutputTokens,
        signal: AbortSignal.timeout(this.timeoutMs),
        jsonSchema: NEWS_GEMINI_JSON_SCHEMA,
      })
    } catch (cause) {
      return {
        source: 'deterministic',
        snapshot: deterministic,
        fallbackReason: reasonForGeminiError(cause),
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        source: 'deterministic',
        snapshot: deterministic,
        fallbackReason: 'gemini_invalid_json',
      }
    }
    const validated = validateGeminiResponse(parsed, deterministic, input)
    if (!validated.valid)
      return {
        source: 'deterministic',
        snapshot: deterministic,
        fallbackReason: 'gemini_invalid_response',
      }

    const items = deterministic.items.map((baseline) => {
      const modelItem = validated.itemsById.get(baseline.evidenceId)
      if (modelItem === undefined) return baseline
      return {
        ...baseline,
        ...modelItem,
        relevanceRuleVersion: NEWS_RELEVANCE_RULE_VERSION,
        taxonomyRuleVersion: NEWS_TAXONOMY_RULE_VERSION,
        freshness: baseline.freshness,
      }
    })
    const withoutHash: Omit<NewsAnalysisSnapshot, 'contentHash'> = {
      ...deterministic,
      items,
      summary: summaryFor(items),
    }
    return {
      source: 'gemini',
      snapshot: { ...withoutHash, contentHash: hashOf(withoutHash) },
    }
  }
}

const NEWS_GEMINI_JSON_SCHEMA = {
  type: 'object',
  properties: {
    version: { type: 'string' },
    items: { type: 'array' },
    uncertainty: { type: 'array', items: { type: 'string' } },
    disclaimer: { type: 'string' },
  },
  required: ['version', 'items', 'uncertainty', 'disclaimer'],
  additionalProperties: false,
} as const

function assessmentFor(
  text: string,
  relevance: NewsRelevance,
  taxonomy: NewsEventTaxonomy,
  evidence: NewsEvidenceRecord,
): {
  readonly relevance: NewsRelevance
  readonly relevanceRuleVersion: string
  readonly taxonomy: NewsEventTaxonomy
  readonly taxonomyRuleVersion: string
  readonly sentiment: NewsSentiment
  readonly impact: NewsImpact
  readonly direction: NewsDirection
  readonly confidence: number
  readonly horizon: ForecastHorizon | null
  readonly status: NewsAnalysisStatus
  readonly reasons: readonly string[]
  readonly reason?: string
} {
  const reference = {
    relevance,
    relevanceRuleVersion: NEWS_RELEVANCE_RULE_VERSION,
    taxonomy,
    taxonomyRuleVersion: NEWS_TAXONOMY_RULE_VERSION,
  }
  if (relevance !== 'relevant')
    return {
      ...reference,
      sentiment: 'uncertain',
      impact: 'uncertain',
      direction: 'uncertain',
      confidence: 0,
      horizon: null,
      status: 'abstain',
      reason: `relevance_${relevance}`,
      reasons: [
        'The permitted evidence does not establish both Bitcoin and EUR relevance tokens.',
      ],
    }

  const normalized = text.toLocaleLowerCase('en-US')
  const positive = matchingCues(normalized, POSITIVE_CUES)
  const negative = matchingCues(normalized, NEGATIVE_CUES)
  const highImpact = matchingCues(normalized, HIGH_IMPACT_CUES)
  const hasPositive = positive.length > 0
  const hasNegative = negative.length > 0
  const sentiment: NewsSentiment =
    hasPositive && hasNegative
      ? 'mixed'
      : hasPositive
        ? 'positive'
        : hasNegative
          ? 'negative'
          : 'neutral'
  const direction: NewsDirection =
    hasPositive && hasNegative
      ? 'neutral'
      : hasPositive
        ? 'bullish'
        : hasNegative
          ? 'bearish'
          : 'uncertain'
  const impact: NewsImpact =
    highImpact.length > 0
      ? 'high'
      : hasPositive || hasNegative
        ? 'medium'
        : 'uncertain'
  const certain = direction !== 'uncertain' && impact !== 'uncertain'
  const status: NewsAnalysisStatus = certain ? 'analyzed' : 'abstain'
  const confidence = !certain
    ? 0
    : hasPositive && hasNegative
      ? 0.55
      : evidence.sourceLevel === 'official_primary'
        ? 0.8
        : 0.7
  const matched = [...positive, ...negative]
  const reasons = [
    'The permitted title, category, summary or excerpt contains Bitcoin and EUR relevance tokens.',
    ...(matched.length === 0
      ? ['No explicit directional cue is present; the analysis abstains.']
      : [
          `Directional cue(s) present in the permitted text: ${matched.join(', ')}.`,
        ]),
    ...(highImpact.length > 0
      ? [
          `High-impact cue(s) present in the permitted text: ${highImpact.join(', ')}.`,
        ]
      : ['Impact is not inferred from taxonomy alone.']),
  ]
  return {
    ...reference,
    sentiment,
    impact,
    direction,
    confidence,
    horizon: certain ? horizonFor(taxonomy) : null,
    status,
    ...(status === 'abstain'
      ? { reason: 'insufficient_directional_evidence' }
      : {}),
    reasons,
  }
}

function horizonFor(taxonomy: NewsEventTaxonomy): ForecastHorizon {
  if (taxonomy === 'security' || taxonomy === 'exchange') return '15m'
  if (taxonomy === 'regulation' || taxonomy === 'market_structure') return '4h'
  return '24h'
}

function matchingCues(text: string, cues: readonly Cue[]): string[] {
  return cues.filter((cue) => cue.pattern.test(text)).map((cue) => cue.label)
}

function allowedText(evidence: NewsEvidenceRecord): string {
  const content =
    evidence.content.kind === 'metadata_only' ? '' : evidence.content.text
  return [
    evidence.metadata.title,
    evidence.metadata.category ?? '',
    content,
  ].join(' ')
}

function freshnessFor(
  publishedAt: TimestampMs,
  input: NewsAnalysisInput,
): NewsFreshness {
  const ageMs = input.asOfTimestamp - publishedAt
  return {
    ageMs,
    staleAfterMs: input.staleAfterMs,
    isStale: ageMs > input.staleAfterMs,
  }
}

function referenceFor(evidence: NewsEvidenceRecord): {
  readonly evidenceId: string
  readonly evidenceVersion: string
  readonly contentHash: string
} {
  return {
    evidenceId: evidence.id,
    evidenceVersion: evidence.version,
    contentHash: evidence.contentHash,
  }
}

function evidenceOnly(evidence: NewsEvidenceRecord) {
  const { id, version, ...value } = evidence
  void id
  void version
  return value
}

function latestVersions(
  evidence: readonly NewsEvidenceRecord[],
  excluded: NewsAnalysisExclusion[],
): readonly NewsEvidenceRecord[] {
  const byId = new Map<string, NewsEvidenceRecord[]>()
  for (const item of evidence) {
    const versions = byId.get(item.id) ?? []
    versions.push(item)
    byId.set(item.id, versions)
  }
  const latest: NewsEvidenceRecord[] = []
  for (const versions of byId.values()) {
    const ordered = [...versions].sort(compareVersions)
    const current = ordered.at(-1)
    if (current === undefined) continue
    latest.push(current)
    for (const superseded of ordered.slice(0, -1))
      excluded.push({
        ...referenceFor(superseded),
        reason: 'superseded_version',
      })
  }
  return latest.sort(
    (left, right) =>
      compareStrings(left.id, right.id) ||
      compareStrings(left.version, right.version),
  )
}

function removeExactDuplicates(
  evidence: readonly NewsEvidenceRecord[],
  excluded: NewsAnalysisExclusion[],
): readonly NewsEvidenceRecord[] {
  const seen = new Set<string>()
  const unique: NewsEvidenceRecord[] = []
  for (const item of evidence) {
    const key = `${item.id}\u0000${item.version}\u0000${item.contentHash}`
    if (seen.has(key)) {
      excluded.push({ ...referenceFor(item), reason: 'duplicate_content_hash' })
      continue
    }
    seen.add(key)
    unique.push(item)
  }
  return unique
}

function compareVersions(
  left: NewsEvidenceRecord,
  right: NewsEvidenceRecord,
): number {
  const leftNumber = Number(left.version)
  const rightNumber = Number(right.version)
  if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber))
    return leftNumber - rightNumber
  return compareStrings(left.version, right.version)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareExclusions(
  left: NewsAnalysisExclusion,
  right: NewsAnalysisExclusion,
): number {
  return (
    compareStrings(left.evidenceId, right.evidenceId) ||
    compareStrings(left.evidenceVersion, right.evidenceVersion) ||
    compareStrings(left.contentHash, right.contentHash) ||
    compareStrings(left.reason, right.reason)
  )
}

function summaryFor(items: readonly NewsAnalysisItem[]): NewsAnalysisSummary {
  return {
    totalItems: items.length,
    analyzedItems: items.filter((item) => item.status === 'analyzed').length,
    abstainedItems: items.filter((item) => item.status === 'abstain').length,
    relevantItems: items.filter((item) => item.relevance === 'relevant').length,
  }
}

function hashOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]),
  )
}

function buildNewsPrompt(
  input: NewsAnalysisInput,
  items: readonly NewsAnalysisItem[],
): string {
  const evidence = items.flatMap((item) => {
    const candidate = input.evidence.find(
      (value) =>
        value.id === item.evidenceId &&
        value.version === item.evidenceVersion &&
        value.contentHash === item.contentHash,
    )
    if (candidate === undefined) return []
    return [
      {
        evidenceId: candidate.id,
        evidenceVersion: candidate.version,
        contentHash: candidate.contentHash,
        source: candidate.source,
        sourceLevel: candidate.sourceLevel,
        url: candidate.url,
        publishedAt: candidate.publishedAt,
        ingestedAt: candidate.ingestedAt,
        licenseStatus: candidate.licenseStatus,
        correctionStatus: candidate.correctionStatus,
        relevance: candidate.relevance,
        relevanceRuleVersion: candidate.relevanceRuleVersion,
        taxonomy: candidate.taxonomy,
        taxonomyRuleVersion: candidate.taxonomyRuleVersion,
        metadata: candidate.metadata,
        content: candidate.content,
      },
    ]
  })
  return [
    'Analyze only the supplied, provenance-bearing BTC-EUR news evidence.',
    'Do not invent facts, sources, citations, identifiers, hashes or event details.',
    'Do not use outside knowledge, browsing, tools, social media or article text not included below.',
    'Keep sentiment separate from market impact. Abstain when the permitted evidence is insufficient.',
    'Return only JSON. Every item must reference exactly one supplied evidenceId, evidenceVersion and contentHash.',
    `Use requested horizon ${input.horizon}; an abstention may use null horizon.`,
    `Required disclaimer: ${NEWS_DISCLAIMER}`,
    JSON.stringify({
      version: NEWS_GEMINI_VERSION,
      eventCutoff: input.eventCutoff,
      evidence,
    }),
  ].join('\n')
}

function validateGeminiResponse(
  value: unknown,
  deterministic: NewsAnalysisSnapshot,
  input: NewsAnalysisInput,
):
  | { readonly valid: true; readonly itemsById: Map<string, NewsGeminiItem> }
  | { readonly valid: false } {
  if (!isRecord(value)) return { valid: false }
  if (value.version !== NEWS_GEMINI_VERSION) return { valid: false }
  if (
    !Array.isArray(value.items) ||
    !Array.isArray(value.uncertainty) ||
    !value.uncertainty.every((reason) => typeof reason === 'string')
  )
    return { valid: false }
  if (!validDisclaimer(value.disclaimer)) return { valid: false }
  const expected = new Map(
    deterministic.items.map((item) => [item.evidenceId, item]),
  )
  const itemsById = new Map<string, NewsGeminiItem>()
  for (const candidate of value.items) {
    if (!isRecord(candidate)) return { valid: false }
    const item = candidate as Partial<NewsGeminiItem>
    const baseline =
      typeof item.evidenceId === 'string'
        ? expected.get(item.evidenceId)
        : undefined
    if (
      baseline === undefined ||
      typeof item.evidenceVersion !== 'string' ||
      item.evidenceVersion !== baseline.evidenceVersion ||
      typeof item.contentHash !== 'string' ||
      item.contentHash !== baseline.contentHash ||
      item.relevance !== baseline.relevance ||
      item.taxonomy !== baseline.taxonomy ||
      !SENTIMENTS.has(item.sentiment as NewsSentiment) ||
      !IMPACTS.has(item.impact as NewsImpact) ||
      !DIRECTIONS.has(item.direction as NewsDirection) ||
      typeof item.confidence !== 'number' ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1 ||
      (item.horizon !== null &&
        !HORIZONS.has(item.horizon as ForecastHorizon)) ||
      (item.horizon !== null && item.horizon !== input.horizon) ||
      (item.status !== 'analyzed' && item.status !== 'abstain') ||
      !Array.isArray(item.reasons) ||
      !item.reasons.every((reason) => typeof reason === 'string') ||
      (item.status === 'abstain' && item.confidence !== 0)
    )
      return { valid: false }
    if (item.status === 'analyzed' && item.horizon === null)
      return { valid: false }
    if (item.status === 'abstain' && item.direction !== 'uncertain')
      return { valid: false }
    if (item.status === 'analyzed' && item.confidence === 0)
      return { valid: false }
    if (baseline.relevance !== 'relevant' && item.status !== 'abstain')
      return { valid: false }
    if (baseline.freshness.isStale && item.status !== 'abstain')
      return { valid: false }
    const evidenceId = item.evidenceId
    if (typeof evidenceId !== 'string' || itemsById.has(evidenceId))
      return { valid: false }
    itemsById.set(evidenceId, item as NewsGeminiItem)
  }
  if (itemsById.size !== expected.size) return { valid: false }
  if (Array.from(expected.keys()).some((id) => !itemsById.has(id)))
    return { valid: false }
  if (input.horizon === undefined) return { valid: false }
  return { valid: true, itemsById }
}

function validDisclaimer(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false
  const normalized = value.toLocaleLowerCase('en-US')
  return (
    (normalized.includes('asesoramiento financiero') ||
      normalized.includes('financial advice')) &&
    (normalized.includes('ejecuta órdenes') ||
      normalized.includes('execute orders') ||
      normalized.includes('executes orders'))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function reasonForGeminiError(
  cause: unknown,
): GeminiNewsAnalysisResult['fallbackReason'] {
  if (isTimeoutCause(cause)) return 'gemini_timeout'
  if (isQuotaCause(cause)) return 'gemini_quota'
  return 'gemini_upstream'
}

function isTimeoutCause(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    (cause.name === 'TimeoutError' || cause.name === 'AbortError')
  )
}

function isQuotaCause(cause: unknown): boolean {
  if (!isRecord(cause)) return false
  return cause.status === 429 || cause.statusCode === 429 || cause.code === 429
}
