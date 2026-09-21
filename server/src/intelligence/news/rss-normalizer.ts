import { createHash } from 'node:crypto'
import {
  parseTimestampMs,
  type NewsEvidence,
  type NewsEventTaxonomy,
  type NewsEnvelope,
  type NewsRelevance,
  type NewsNormalizer,
  type NewsNormalizerInput,
  type TimestampMs,
} from '../contracts.ts'
import {
  invalid,
  issue,
  valid,
  type ValidationIssue,
  type ValidationResult,
} from '../validation.ts'
import { evaluateNewsSource } from '../source-policy.ts'
import {
  OFFICIAL_RSS_SOURCES,
  type RssNewsItem,
  type RssSourceConfig,
} from './rss-collector.ts'

export const NEWS_RELEVANCE_RULE_VERSION = 'news-relevance.v1'
export const NEWS_TAXONOMY_RULE_VERSION = 'news-taxonomy.v1'

export interface NewsNormalizationTimes {
  readonly ingestedAt: TimestampMs
  readonly retrievedAt?: TimestampMs
}

export interface NewsTaxonomyClassification {
  readonly taxonomy: NewsEventTaxonomy
  readonly certain: boolean
}

export class RssNewsNormalizer implements NewsNormalizer<RssNewsItem> {
  readonly domain = 'news' as const

  normalize(
    input: NewsNormalizerInput<RssNewsItem>,
  ): ValidationResult<NewsEnvelope> {
    return this.normalizeItem(input.raw, {
      ingestedAt: input.evidence.ingestedAt,
      retrievedAt: input.evidence.retrievedAt,
    })
  }

  normalizeItem(
    raw: RssNewsItem,
    times: NewsNormalizationTimes,
  ): ValidationResult<NewsEnvelope> {
    const source = sourceFor(raw.sourceId)
    const issues: ValidationIssue[] = []
    const title = raw.title.trim()
    if (title === '')
      issues.push(issue('empty_title', 'title', 'Title is required.'))

    const linkCandidate =
      raw.link || (isAbsoluteHttpUrl(raw.sourceItemId) ? raw.sourceItemId : '')
    const url = canonicalHttpsUrl(linkCandidate, raw.feedUrl)
    if (url === undefined)
      issues.push(
        issue('invalid_url', 'url', 'News URL must be absolute HTTPS.'),
      )

    const publishedAt = parseNewsDate(raw.publishedAt)
    if (publishedAt === undefined)
      issues.push(
        issue('invalid_date', 'publishedAt', 'Publication date is invalid.'),
      )

    const sourceItemId = raw.sourceItemId.trim() || url
    if (sourceItemId === undefined || sourceItemId === '')
      issues.push(
        issue(
          'empty_source_item_id',
          'sourceItemId',
          'Source item identity is required.',
        ),
      )

    const retrievedAt = times.retrievedAt ?? raw.retrievedAt
    const timeIssues = [
      parseTimestampMs(times.ingestedAt, 'ingestedAt'),
      parseTimestampMs(retrievedAt, 'retrievedAt'),
    ]
    for (const result of timeIssues) {
      if (!result.valid) issues.push(...result.issues)
    }
    if (
      issues.length > 0 ||
      source === undefined ||
      url === undefined ||
      publishedAt === undefined ||
      sourceItemId === undefined
    )
      return invalid(issues)

    const searchableText = [
      title,
      raw.description ?? '',
      raw.category ?? '',
    ].join(' ')
    const relevance = classifyNewsRelevance(searchableText)
    const taxonomy = classifyNewsTaxonomy(searchableText)
    const correctionStatus = correctionStatusFor(searchableText)
    const evidenceWithoutHash: NewsEvidence = {
      instrumentId: 'BTC-EUR',
      source: source.sourceId,
      sourceLevel: source.sourceLevel,
      sourceItemId,
      url,
      publishedAt,
      ingestedAt: times.ingestedAt,
      retrievedAt: retrievedAt as TimestampMs,
      contentHash: '',
      licenseStatus: source.licenseStatus,
      correctionStatus,
      ...(correctionStatus === 'original'
        ? {}
        : { correctionOfSourceItemId: sourceItemId }),
      relevance,
      relevanceRuleVersion: NEWS_RELEVANCE_RULE_VERSION,
      taxonomy: taxonomy.taxonomy,
      taxonomyRuleVersion: NEWS_TAXONOMY_RULE_VERSION,
      metadata: {
        title,
        ...(raw.author === undefined ? {} : { author: raw.author }),
        ...(raw.category === undefined ? {} : { category: raw.category }),
        feedUrl: raw.feedUrl,
      },
      content: { kind: 'metadata_only' },
    }
    const evidence: NewsEvidence = {
      ...evidenceWithoutHash,
      contentHash: contentHashForNewsEvidence(evidenceWithoutHash),
    }
    const policy = evaluateNewsSource(evidence)
    return policy.accepted && policy.evidence !== undefined
      ? valid({
          instrumentId: 'BTC-EUR',
          status: 'live',
          evidence: policy.evidence,
        })
      : invalid(policy.reasons)
  }
}

export function classifyNewsRelevance(text: string): NewsRelevance {
  const normalized = text.toLocaleLowerCase('en-US')
  const hasBitcoin = /\b(?:btc|bitcoin)\b/.test(normalized)
  const hasEuro = /\b(?:eur|euro|euros)\b/.test(normalized)
  if (hasBitcoin && hasEuro) return 'relevant'
  if (hasBitcoin) return 'uncertain'
  return 'not_relevant'
}

export function classifyNewsTaxonomy(text: string): NewsTaxonomyClassification {
  const normalized = text.toLocaleLowerCase('en-US')
  const rules: readonly [NewsEventTaxonomy, RegExp][] = [
    [
      'security',
      /\b(?:hack|hacked|breach|exploit|stolen|theft|vulnerability|cyber)\b/,
    ],
    [
      'market_structure',
      /\b(?:market structure|clearing|settlement|etf|custody|liquidity)\b/,
    ],
    [
      'regulation',
      /\b(?:regulat(?:ion|ory|e)|enforcement|compliance|law|rule|sec)\b/,
    ],
    ['exchange', /\b(?:exchange|trading venue|order book|coinbase|binance)\b/],
    [
      'technology',
      /\b(?:blockchain|protocol|network|software|tokeni[sz]|wallet)\b/,
    ],
    [
      'macro',
      /\b(?:fomc|interest rate|inflation|monetary policy|gdp|cpi|central bank)\b/,
    ],
  ]
  const match = rules.find(([, pattern]) => pattern.test(normalized))
  return match === undefined
    ? { taxonomy: 'other', certain: false }
    : { taxonomy: match[0], certain: true }
}

export function contentHashForNewsEvidence(evidence: NewsEvidence): string {
  const withoutHash = Object.fromEntries(
    Object.entries(evidence).filter(([key]) => key !== 'contentHash'),
  )
  return createHash('sha256').update(canonicalJson(withoutHash)).digest('hex')
}

function sourceFor(sourceId: string): RssSourceConfig | undefined {
  return Object.values(OFFICIAL_RSS_SOURCES).find(
    (source) => source.sourceId === sourceId,
  )
}

function parseNewsDate(value: string | undefined): TimestampMs | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed < 0)
    return undefined
  return parsed as TimestampMs
}

function canonicalHttpsUrl(value: string, base: string): string | undefined {
  try {
    const url = new URL(value, base)
    if (url.protocol !== 'https:' || url.hostname === '') return undefined
    url.hash = ''
    url.hostname = url.hostname.toLowerCase()
    if (url.port === '443') url.port = ''
    return url.href
  } catch {
    return undefined
  }
}

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

function correctionStatusFor(
  text: string,
): 'original' | 'corrected' | 'retracted' {
  if (/\b(?:retracted|withdrawn)\b/i.test(text)) return 'retracted'
  if (/\b(?:corrected|correction|amended|superseded)\b/i.test(text))
    return 'corrected'
  return 'original'
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
