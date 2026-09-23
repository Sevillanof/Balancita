import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  parseTimestampMs,
  type NewsEvidence,
  type NewsEvidenceRecord,
  type TimestampMs,
} from '../../domain/contracts.ts'
import {
  classifyNewsTaxonomy,
  contentHashForNewsEvidence,
} from './rss-normalizer.ts'
import {
  OFFICIAL_RSS_SOURCES,
  RssNewsCollector,
  type NewsHttpFetcher,
} from './rss-collector.ts'
import { RssNewsNormalizer } from './rss-normalizer.ts'
import {
  NEWS_ANALYSIS_VERSION,
  NEWS_DISCLAIMER,
  GeminiNewsAnalysisAdapter,
  analyzeNews,
  type NewsAnalysisInput,
  type NewsGeminiResponse,
} from './news-analysis.ts'
import type {
  GeminiClient,
  GeminiGenerateParams,
} from '../../platform/gemini/gemini-client.ts'

const time = (value: number): TimestampMs => {
  const result = parseTimestampMs(value)
  if (!result.valid) throw new Error('test timestamp must be valid')
  return result.value
}

function evidence(
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

function input(
  evidenceItems: readonly NewsEvidenceRecord[],
  overrides: Partial<NewsAnalysisInput> = {},
): NewsAnalysisInput {
  return {
    evidence: evidenceItems,
    asOfTimestamp: time(10_000),
    eventCutoff: time(10_000),
    horizon: '4h',
    staleAfterMs: 2_000,
    ...overrides,
  }
}

class FakeGeminiClient implements GeminiClient {
  generateStructuredText =
    vi.fn<(params: GeminiGenerateParams) => Promise<string>>()
}

describe('deterministic news analysis', () => {
  it('consumes an accepted Phase E RSS fixture without article text', async () => {
    const body = readFileSync(
      new URL('./__fixtures__/sec.rss', import.meta.url),
      'utf8',
    )
    const fetcher: NewsHttpFetcher = async () => ({ status: 200, body })
    const collector = new RssNewsCollector({
      source: OFFICIAL_RSS_SOURCES.sec,
      fetcher,
      userAgent: 'Balancita/1.0 (+https://example.test/contact)',
    })
    const [raw] = await collector.collectOnce('BTC-EUR')
    if (raw === undefined) throw new Error('fixture item missing')
    const normalized = new RssNewsNormalizer().normalizeItem(raw, {
      ingestedAt: time(Date.parse('2026-09-21T16:00:01.000Z')),
      retrievedAt: time(Date.parse('2026-09-21T16:00:02.000Z')),
    })
    if (!normalized.valid)
      throw new Error('fixture evidence should be accepted')
    const record: NewsEvidenceRecord = {
      ...normalized.value.evidence,
      id: `news:sec:${normalized.value.evidence.sourceItemId}`,
      version: '1',
    }

    const snapshot = analyzeNews(
      input([record], {
        asOfTimestamp: time(Date.parse('2026-09-21T16:00:03.000Z')),
        eventCutoff: time(Date.parse('2026-09-21T16:00:03.000Z')),
      }),
    )

    expect(snapshot.items[0]?.contentHash).toBe(record.contentHash)
    expect(JSON.stringify(snapshot)).not.toContain('long article body')
  })

  it('analyzes relevant evidence with separate sentiment, impact and provenance', () => {
    const item = evidence('Bitcoin EUR ETF approved for regulated market')
    const snapshot = analyzeNews(input([item]))

    expect(snapshot.version).toBe(NEWS_ANALYSIS_VERSION)
    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]).toMatchObject({
      evidenceId: item.id,
      evidenceVersion: item.version,
      contentHash: item.contentHash,
      relevance: 'relevant',
      taxonomy: 'market_structure',
      sentiment: 'positive',
      impact: 'medium',
      direction: 'bullish',
      confidence: 0.8,
      horizon: '4h',
      status: 'analyzed',
    })
    expect(snapshot.items[0]?.reasons.join(' ')).toContain('approved')
    expect(snapshot.items[0]?.freshness).toEqual({
      ageMs: 1_000,
      staleAfterMs: 2_000,
      isStale: false,
    })
    expect(snapshot.items[0]?.evidenceId).toBe(item.id)
    expect(snapshot.items[0]?.contentHash).toBe(item.contentHash)
  })

  it('abstains for not relevant and uncertain BTC-EUR evidence', () => {
    const notRelevant = evidence('Euro area inflation statement', {
      relevance: 'not_relevant',
    })
    const uncertain = evidence('Bitcoin protocol update', {
      sourceItemId: 'sec-uncertain',
      metadata: { title: 'Bitcoin protocol update' },
      relevance: 'uncertain',
    })
    const snapshot = analyzeNews(input([notRelevant, uncertain]))

    expect(snapshot.items.map((item) => item.status)).toEqual([
      'abstain',
      'abstain',
    ])
    expect(snapshot.items.map((item) => item.relevance)).toEqual(
      expect.arrayContaining(['not_relevant', 'uncertain']),
    )
    expect(snapshot.items.every((item) => item.confidence === 0)).toBe(true)
    expect(snapshot.items.every((item) => item.direction === 'uncertain')).toBe(
      true,
    )
  })

  it('keeps taxonomy deterministic and does not infer direction from taxonomy alone', () => {
    const macro = evidence('Bitcoin EUR central bank monetary policy statement')
    const technology = evidence(
      'Bitcoin EUR blockchain network software notice',
      {
        sourceItemId: 'sec-technology',
        url: 'https://www.sec.gov/newsroom/press-releases/technology',
        taxonomy: 'technology',
      },
    )
    const snapshot = analyzeNews(input([macro, technology]))

    expect(
      snapshot.items.find((item) => item.taxonomy === 'macro'),
    ).toMatchObject({
      taxonomy: 'macro',
      impact: 'uncertain',
      direction: 'uncertain',
      horizon: null,
      status: 'abstain',
    })
    expect(
      snapshot.items.find((item) => item.taxonomy === 'technology'),
    ).toMatchObject({
      taxonomy: 'technology',
      impact: 'uncertain',
      direction: 'uncertain',
      horizon: null,
      status: 'abstain',
    })
  })

  it('rejects retracted, unverified and license-restricted evidence', () => {
    const retracted = evidence('Bitcoin EUR retracted notice', {
      correctionStatus: 'retracted',
      correctionOfSourceItemId: 'sec-original',
    })
    const social = evidence('Bitcoin EUR social rumor', {
      source: 'social',
      sourceLevel: 'unverified_social',
      licenseStatus: 'unknown',
    })
    const licensedWithoutPermission = evidence('Bitcoin EUR licensed report', {
      source: 'wire',
      sourceLevel: 'licensed_reporting',
      licenseStatus: 'permission_required',
    })
    const snapshot = analyzeNews(
      input([retracted, social, licensedWithoutPermission]),
    )

    expect(snapshot.items).toHaveLength(0)
    expect(snapshot.excluded.map((item) => item.reason)).toEqual(
      expect.arrayContaining([
        'retracted_evidence',
        'source_policy_rejected',
        'source_policy_rejected',
      ]),
    )
    expect(snapshot.excluded.map((item) => item.contentHash)).toEqual(
      expect.arrayContaining([
        retracted.contentHash,
        social.contentHash,
        licensedWithoutPermission.contentHash,
      ]),
    )
  })

  it('deduplicates hashes without increasing confidence and excludes future or stale evidence', () => {
    const duplicate = evidence('Bitcoin EUR exchange outage')
    const stale = evidence('Bitcoin EUR exchange outage stale', {
      sourceItemId: 'sec-stale',
      publishedAt: time(1_000),
      ingestedAt: time(1_100),
      retrievedAt: time(1_200),
      metadata: { title: 'Bitcoin EUR exchange outage stale' },
    })
    const future = evidence('Bitcoin EUR exchange outage future', {
      sourceItemId: 'sec-future',
      publishedAt: time(9_000),
      ingestedAt: time(10_001),
      retrievedAt: time(10_002),
      metadata: { title: 'Bitcoin EUR exchange outage future' },
    })
    const snapshot = analyzeNews(
      input([duplicate, duplicate, stale, future], { staleAfterMs: 2_000 }),
    )

    expect(snapshot.items).toHaveLength(2)
    expect(
      snapshot.items.filter((item) => item.status === 'analyzed'),
    ).toHaveLength(1)
    expect(
      snapshot.items.find((item) => item.evidenceId === stale.id),
    ).toMatchObject({
      status: 'abstain',
      reason: 'stale_evidence',
    })
    expect(snapshot.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'duplicate_content_hash' }),
        expect.objectContaining({ reason: 'future_evidence' }),
      ]),
    )
    const analyzed = snapshot.items.find((item) => item.status === 'analyzed')
    expect(analyzed?.confidence).toBe(0.8)
  })

  it('produces an auditable snapshot hash without reading a global clock', () => {
    const item = evidence('Bitcoin EUR exchange listing approved')
    const first = analyzeNews(input([item]))
    const second = analyzeNews(input([item]))

    expect(first).toEqual(second)
    expect(first.asOfTimestamp).toBe(10_000)
    expect(first.eventCutoff).toBe(10_000)
    expect(first.contentHash).toMatch(/^[a-f0-9]{64}$/)
    expect(first.items[0]?.evidenceId).toBe(item.id)
    expect(first.items[0]?.contentHash).toBe(item.contentHash)
  })
})

describe('optional manual Gemini news adapter', () => {
  function validResponse(item: NewsEvidenceRecord): NewsGeminiResponse {
    return {
      version: 'news-gemini.v1',
      items: [
        {
          evidenceId: item.id,
          evidenceVersion: item.version,
          contentHash: item.contentHash,
          relevance: 'relevant',
          taxonomy: 'exchange',
          sentiment: 'negative',
          impact: 'high',
          direction: 'bearish',
          confidence: 0.7,
          horizon: '4h',
          status: 'analyzed',
          reasons: ['The included title contains an explicit negative cue.'],
        },
      ],
      uncertainty: [],
      disclaimer: NEWS_DISCLAIMER,
    }
  }

  it('never calls Gemini without explicit manual opt-in', async () => {
    const client = new FakeGeminiClient()
    const adapter = new GeminiNewsAnalysisAdapter({
      client,
      model: 'gemini-test',
      timeoutMs: 100,
      maxOutputTokens: 512,
    })

    const result = await adapter.analyze(
      input([evidence('Bitcoin EUR exchange outage')]),
    )

    expect(result.source).toBe('deterministic')
    expect(result.fallbackReason).toBe('manual_opt_in_required')
    expect(client.generateStructuredText).not.toHaveBeenCalled()
  })

  it('accepts structured Gemini output only when references and runtime fields match', async () => {
    const item = evidence('Bitcoin EUR exchange outage')
    const client = new FakeGeminiClient()
    client.generateStructuredText.mockResolvedValue(
      JSON.stringify(validResponse(item)),
    )
    const adapter = new GeminiNewsAnalysisAdapter({
      client,
      model: 'gemini-test',
      timeoutMs: 100,
      maxOutputTokens: 512,
    })

    const result = await adapter.analyze(input([item]), { manual: true })

    expect(result.source).toBe('gemini')
    expect(result.snapshot.items[0]).toMatchObject({
      evidenceId: item.id,
      contentHash: item.contentHash,
      impact: 'high',
      direction: 'bearish',
    })
    expect(client.generateStructuredText).toHaveBeenCalledTimes(1)
    const params = client.generateStructuredText.mock.calls[0]?.[0]
    expect(params?.prompt).toContain(item.id)
    expect(params?.prompt).toContain(item.contentHash)
    expect(params?.prompt).not.toContain('article body')
  })

  it.each([
    ['invalid JSON', 'not json'],
    [
      'unknown reference',
      JSON.stringify({
        ...validResponse(evidence('Bitcoin EUR exchange outage')),
        items: [
          {
            ...validResponse(evidence('Bitcoin EUR exchange outage')).items[0],
            evidenceId: 'invented-id',
          },
        ],
      }),
    ],
    [
      'wrong horizon',
      JSON.stringify({
        ...validResponse(evidence('Bitcoin EUR exchange outage')),
        items: [
          {
            ...validResponse(evidence('Bitcoin EUR exchange outage')).items[0],
            horizon: '15m',
          },
        ],
      }),
    ],
    [
      'missing disclaimer',
      JSON.stringify({
        ...validResponse(evidence('Bitcoin EUR exchange outage')),
        disclaimer: '',
      }),
    ],
  ])('falls back safely on %s', async (_label, response) => {
    const item = evidence('Bitcoin EUR exchange outage')
    const client = new FakeGeminiClient()
    client.generateStructuredText.mockResolvedValue(response)
    const adapter = new GeminiNewsAnalysisAdapter({
      client,
      model: 'gemini-test',
      timeoutMs: 100,
      maxOutputTokens: 512,
    })

    const result = await adapter.analyze(input([item]), { manual: true })

    expect(result.source).toBe('deterministic')
    expect(result.fallbackReason).toMatch(/gemini_/)
    expect(result.snapshot.version).toBe(NEWS_ANALYSIS_VERSION)
  })

  it('falls back for timeout and quota errors and does not expose a secret in the prompt', async () => {
    const item = evidence('Bitcoin EUR exchange outage')
    const client = new FakeGeminiClient()
    client.generateStructuredText.mockRejectedValue({ status: 429 })
    const adapter = new GeminiNewsAnalysisAdapter({
      client,
      model: 'gemini-test',
      timeoutMs: 100,
      maxOutputTokens: 512,
    })

    const result = await adapter.analyze(input([item]), { manual: true })

    expect(result.source).toBe('deterministic')
    expect(result.fallbackReason).toBe('gemini_quota')
    const prompt = client.generateStructuredText.mock.calls[0]?.[0].prompt ?? ''
    expect(prompt).not.toContain('GEMINI_API_KEY')
  })

  it('falls back for an abort timeout', async () => {
    const client = new FakeGeminiClient()
    client.generateStructuredText.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    )
    const adapter = new GeminiNewsAnalysisAdapter({
      client,
      model: 'gemini-test',
      timeoutMs: 100,
      maxOutputTokens: 512,
    })

    const result = await adapter.analyze(
      input([evidence('Bitcoin EUR exchange outage')]),
      { manual: true },
    )

    expect(result.source).toBe('deterministic')
    expect(result.fallbackReason).toBe('gemini_timeout')
  })

  it('honors the existing server quota boundary before calling the client', async () => {
    const client = new FakeGeminiClient()
    const adapter = new GeminiNewsAnalysisAdapter({
      client,
      model: 'gemini-test',
      timeoutMs: 100,
      maxOutputTokens: 512,
      quota: { tryConsume: () => false },
    })

    const result = await adapter.analyze(
      input([evidence('Bitcoin EUR exchange outage')]),
      { manual: true },
    )

    expect(result.fallbackReason).toBe('gemini_quota')
    expect(client.generateStructuredText).not.toHaveBeenCalled()
  })
})
