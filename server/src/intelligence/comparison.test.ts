import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  parseTimestampMs,
  type NewsEvidence,
  type NewsEvidenceRecord,
  type TechnicalFeatureSnapshot,
  type TimestampMs,
} from './contracts.ts'
import {
  classifyNewsTaxonomy,
  contentHashForNewsEvidence,
} from './news/rss-normalizer.ts'
import {
  analyzeNews,
  type NewsAnalysisInput,
  type NewsAnalysisSnapshot,
} from './news/news-analysis.ts'
import {
  compareTechnicalAndNews,
  scoreNewsAnalysis,
  scoreTechnicalFeatures,
  type ComparisonContext,
} from './comparison.ts'

const time = (value: number): TimestampMs => {
  const result = parseTimestampMs(value)
  if (!result.valid) throw new Error('test timestamp must be valid')
  return result.value
}

const context: ComparisonContext = {
  asOfTimestamp: time(10_000),
  eventCutoff: time(10_000),
  horizon: '4h',
}

const technicalFeature = (): TechnicalFeatureSnapshot => ({
  version: 'technical-features.v1',
  asOfTimestamp: time(9_000),
  isClosed: true,
  ready: true,
  warmUp: { requiredCandles: 20, availableCandles: 20, missingCandles: 0 },
  values: { sma: 99, rsi: 60, macdHistogram: 1, structuralSlope: 1 },
})

function newsEvidence(
  title: string,
  overrides: Partial<NewsEvidence> = {},
): NewsEvidenceRecord {
  const base: NewsEvidence = {
    instrumentId: 'BTC-EUR',
    source: 'sec',
    sourceLevel: 'official_primary',
    sourceItemId: `sec-${title}`,
    url: 'https://www.sec.gov/newsroom/press-releases/item',
    publishedAt: time(9_000),
    ingestedAt: time(9_100),
    retrievedAt: time(9_200),
    contentHash: '',
    licenseStatus: 'official_public',
    correctionStatus: 'original',
    relevance: 'relevant',
    relevanceRuleVersion: 'news-relevance.v1',
    taxonomy: classifyNewsTaxonomy(title).taxonomy,
    taxonomyRuleVersion: 'news-taxonomy.v1',
    metadata: { title },
    content: { kind: 'metadata_only' },
    ...overrides,
  }
  return {
    ...base,
    contentHash: contentHashForNewsEvidence(base),
    id: `news:sec:${title}`,
    version: '1',
  }
}

function newsSnapshot(
  title: string,
  overrides: Partial<NewsAnalysisInput> = {},
): NewsAnalysisSnapshot {
  const item = newsEvidence(title)
  return analyzeNews({
    evidence: [item],
    asOfTimestamp: time(10_000),
    eventCutoff: time(10_000),
    horizon: '4h',
    staleAfterMs: 2_000,
    ...overrides,
  })
}

function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach((child) => freezeDeep(child))
    Object.freeze(value)
  }
  return value
}

describe('phase G signal scoring and comparison', () => {
  it('scores technical evidence separately with exact feature, freshness and gap references', () => {
    const snapshot = scoreTechnicalFeatures({
      featureSnapshot: technicalFeature(),
      referencePrice: 100,
      freshness: { ageMs: 100, isStale: false, clockInverted: false },
      gaps: {
        gapCount: 0,
        expectedOpportunities: 20,
        rate: 0,
        sequenceAvailable: true,
      },
      ...context,
    })

    expect(snapshot).toMatchObject({
      version: 'technical-score.v1',
      ruleVersion: 'technical-direction.v1',
      status: 'scored',
      direction: 'up',
      featureReference: {
        version: 'technical-features.v1',
        asOfTimestamp: 9_000,
        contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      freshness: { ageMs: 100, isStale: false, clockInverted: false },
      gaps: { gapCount: 0, sequenceAvailable: true },
    })
    expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(snapshot.reasons.join(' ')).toContain('four')
  })

  it.each([
    ['missing', 'missing_technical_evidence'],
    ['stale', 'stale_technical_evidence'],
    ['uncertain gap', 'uncertain_technical_evidence'],
  ])('abstains without fabricating %s technical data', (_label, reason) => {
    const result = scoreTechnicalFeatures({
      featureSnapshot: _label === 'missing' ? null : technicalFeature(),
      referencePrice: 100,
      freshness: {
        ageMs: _label === 'stale' ? 3_000 : 100,
        isStale: _label === 'stale',
        clockInverted: false,
      },
      gaps: {
        gapCount: _label === 'uncertain gap' ? 1 : 0,
        expectedOpportunities: 20,
        rate: _label === 'uncertain gap' ? 0.05 : 0,
        sequenceAvailable: true,
      },
      ...context,
    })

    expect(result.status).toBe('abstain')
    expect(result.abstentionReasons).toContain(reason)
    expect(result.probabilities).toBeUndefined()
  })

  it('scores news separately and preserves analysis plus evidence references', () => {
    const analysis = newsSnapshot('Bitcoin EUR ETF approved')
    const snapshot = scoreNewsAnalysis({ analysis, ...context })

    expect(snapshot).toMatchObject({
      version: 'news-score.v1',
      ruleVersion: 'news-impact.v1',
      status: 'scored',
      direction: 'up',
      analysisReference: {
        version: 'news-analysis.v1',
        ruleVersion: 'news-impact.v1',
        contentHash: analysis.contentHash,
        eventCutoff: 10_000,
      },
      evidenceReferences: [
        expect.objectContaining({
          evidenceId: analysis.items[0]?.evidenceId,
          evidenceVersion: '1',
          contentHash: analysis.items[0]?.contentHash,
        }),
      ],
      freshness: { maxAgeMs: 1_000, staleItemCount: 0 },
      gaps: null,
    })
    expect(snapshot.contentHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    ['missing', null, 'missing_news_evidence'],
    [
      'uncertain',
      newsSnapshot('Bitcoin EUR central bank statement'),
      'uncertain_news_evidence',
    ],
    [
      'stale',
      newsSnapshot('Bitcoin EUR ETF approved stale', { staleAfterMs: 500 }),
      'stale_news_evidence',
    ],
    [
      'retracted',
      analyzeNews({
        evidence: [
          newsEvidence('Bitcoin EUR retracted notice', {
            correctionStatus: 'retracted',
          }),
        ],
        asOfTimestamp: time(10_000),
        eventCutoff: time(10_000),
        horizon: '4h',
        staleAfterMs: 2_000,
      }),
      'retracted_news_evidence',
    ],
  ])(
    'distinguishes %s news evidence abstention',
    (_label, analysis, reason) => {
      const result = scoreNewsAnalysis({ analysis, ...context })
      expect(result.status).toBe('abstain')
      expect(result.abstentionReasons).toContain(reason)
      expect(result.probabilities).toBeUndefined()
    },
  )

  it('emits exact agreement, disagreement and abstention without a combined signal', () => {
    const technical = scoreTechnicalFeatures({
      featureSnapshot: technicalFeature(),
      referencePrice: 100,
      freshness: { ageMs: 100, isStale: false, clockInverted: false },
      gaps: {
        gapCount: 0,
        expectedOpportunities: 20,
        rate: 0,
        sequenceAvailable: true,
      },
      ...context,
    })
    const bullishNews = scoreNewsAnalysis({
      analysis: newsSnapshot('Bitcoin EUR ETF approved'),
      ...context,
    })
    const bearishNews = scoreNewsAnalysis({
      analysis: newsSnapshot('Bitcoin EUR ETF enforcement'),
      ...context,
    })

    expect(
      compareTechnicalAndNews({ technical, news: bullishNews, ...context }),
    ).toMatchObject({
      status: 'agreement',
      reasons: [{ code: 'same_direction' }],
      combination: { enabled: false, ruleVersion: 'no-combination.v1' },
    })
    expect(
      compareTechnicalAndNews({ technical, news: bearishNews, ...context }),
    ).toMatchObject({
      status: 'disagreement',
      reasons: [{ code: 'different_direction' }],
    })
    const abstained = compareTechnicalAndNews({
      technical,
      news: null,
      ...context,
    })
    expect(abstained).toMatchObject({
      status: 'abstain',
      reasons: [{ code: 'missing_news_score' }],
      technicalReference: expect.objectContaining({
        featureVersion: 'technical-features.v1',
        featureHash: technical.featureReference!.contentHash,
        scoreHash: technical.contentHash,
      }),
      newsReference: null,
    })
    expect('probabilities' in abstained).toBe(false)

    const newsOnly = compareTechnicalAndNews({
      technical: null,
      news: bullishNews,
      ...context,
    })
    expect(newsOnly).toMatchObject({
      status: 'abstain',
      reasons: [{ code: 'missing_technical_score' }],
      technicalReference: null,
      newsReference: expect.objectContaining({
        analysisVersion: 'news-analysis.v1',
        analysisHash: bullishNews.analysisReference?.contentHash,
      }),
    })
  })

  it('abstains on cutoff mismatch, validates hashes, and does not mutate immutable inputs', () => {
    const feature = freezeDeep(technicalFeature())
    const analysis = freezeDeep(newsSnapshot('Bitcoin EUR ETF approved'))
    const beforeFeature = JSON.stringify(feature)
    const beforeAnalysis = JSON.stringify(analysis)
    const technical = scoreTechnicalFeatures({
      featureSnapshot: feature,
      referencePrice: 100,
      freshness: { ageMs: 100, isStale: false, clockInverted: false },
      gaps: {
        gapCount: 0,
        expectedOpportunities: 20,
        rate: 0,
        sequenceAvailable: true,
      },
      ...context,
    })
    const news = scoreNewsAnalysis({ analysis, ...context })
    const mismatch = compareTechnicalAndNews({
      technical,
      news,
      ...context,
      eventCutoff: time(10_001),
    })

    expect(mismatch.status).toBe('abstain')
    expect(mismatch.reasons.map((reason) => reason.code)).toContain(
      'cutoff_mismatch',
    )
    expect(JSON.stringify(feature)).toBe(beforeFeature)
    expect(JSON.stringify(analysis)).toBe(beforeAnalysis)

    const source = readFileSync(
      new URL('./comparison.ts', import.meta.url),
      'utf8',
    )
    expect(source).not.toContain('OrderExecutionProvider')
    expect(source).not.toContain('generateStructuredText')
    expect(source).not.toContain('fetch(')
  })
})
