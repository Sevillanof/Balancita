import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseTimestampMs, type TimestampMs } from '../contracts.ts'
import {
  OFFICIAL_RSS_SOURCES,
  RssNewsCollector,
  type NewsHttpFetcher,
} from './rss-collector.ts'
import {
  NEWS_RELEVANCE_RULE_VERSION,
  NEWS_TAXONOMY_RULE_VERSION,
  RssNewsNormalizer,
  classifyNewsRelevance,
  classifyNewsTaxonomy,
  contentHashForNewsEvidence,
} from './rss-normalizer.ts'

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8')

const time = (value: number): TimestampMs => {
  const result = parseTimestampMs(value)
  if (!result.valid) throw new Error('test timestamp must be valid')
  return result.value
}

function fakeFetcher(body: string, status = 200): NewsHttpFetcher {
  return async (url, init) => {
    void url
    void init
    return { status, body }
  }
}

describe('official RSS news collection', () => {
  it('parses SEC RSS namespaces, relative links, and duplicate items', async () => {
    const source = OFFICIAL_RSS_SOURCES.sec
    const collector = new RssNewsCollector({
      source,
      fetcher: fakeFetcher(fixture('sec.rss')),
      userAgent: 'Balancita/1.0 (+https://example.test/contact)',
      clock: () => time(1_000),
    })

    const items = await collector.collectOnce('BTC-EUR')

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      sourceItemId: 'sec-2026-1',
      link: 'https://www.sec.gov/newsroom/press-releases/2026-1-sec-bitcoin-eur-roundtable',
      title: 'SEC announces Bitcoin and EUR market structure roundtable',
    })
  })

  it('parses Atom links, namespaces, and updated timestamps', async () => {
    const collector = new RssNewsCollector({
      source: OFFICIAL_RSS_SOURCES.ecb,
      fetcher: fakeFetcher(fixture('ecb.atom')),
      userAgent: 'Balancita/1.0 (+https://example.test/contact)',
    })

    const items = await collector.collectOnce('BTC-EUR')

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      sourceItemId: 'https://www.ecb.europa.eu/press/pr/bitcoin-euro',
      link: 'https://www.ecb.europa.eu/press/pr/bitcoin-euro',
      publishedAt: '2026-09-21T14:00:00+02:00',
    })
  })

  it('parses the Federal Reserve official press fixture', async () => {
    const collector = new RssNewsCollector({
      source: OFFICIAL_RSS_SOURCES.fed,
      fetcher: fakeFetcher(fixture('fed.rss')),
      userAgent: 'Balancita/1.0 (+https://example.test/contact)',
      clock: () => 1_000,
    })

    const items = await collector.collectOnce('BTC-EUR')

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      sourceItemId: 'monetary20260916a',
      category: 'Monetary Policy',
      retrievedAt: 1_000,
    })
  })

  it('rejects invalid XML, HTTP errors, and unsupported instruments', async () => {
    const invalidXml = new RssNewsCollector({
      source: OFFICIAL_RSS_SOURCES.fed,
      fetcher: fakeFetcher('<rss><channel>'),
      userAgent: 'Balancita/1.0 (+https://example.test/contact)',
    })
    await expect(invalidXml.collectOnce('BTC-EUR')).rejects.toThrow(
      'invalid XML',
    )

    const httpError = new RssNewsCollector({
      source: OFFICIAL_RSS_SOURCES.fed,
      fetcher: fakeFetcher('unavailable', 503),
      userAgent: 'Balancita/1.0 (+https://example.test/contact)',
    })
    await expect(httpError.collectOnce('BTC-EUR')).rejects.toThrow('HTTP 503')
    await expect(
      invalidXml.collectOnce('ETH-EUR' as 'BTC-EUR'),
    ).rejects.toThrow('BTC-EUR')
  })

  it('propagates abort and timeout without leaving timeout work behind', async () => {
    let receivedSignal: AbortSignal | undefined
    const fetcher: NewsHttpFetcher = async (_url, init) => {
      receivedSignal = init.signal
      return await new Promise<never>((_resolve, reject) => {
        init.signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
      })
    }
    const collector = new RssNewsCollector({
      source: OFFICIAL_RSS_SOURCES.fed,
      fetcher,
      timeoutMs: 5,
      userAgent: 'Balancita/1.0 (+https://example.test/contact)',
    })

    await expect(collector.collectOnce('BTC-EUR')).rejects.toThrow('timed out')
    expect(receivedSignal?.aborted).toBe(true)

    const controller = new AbortController()
    const pending = collector.collectOnce('BTC-EUR', controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
  })
})

describe('news normalization and deterministic rules', () => {
  it('normalizes complete provenance without persisting article descriptions', async () => {
    const collector = new RssNewsCollector({
      source: OFFICIAL_RSS_SOURCES.sec,
      fetcher: fakeFetcher(fixture('sec.rss')),
      userAgent: 'Balancita/1.0 (+https://example.test/contact)',
    })
    const [raw] = await collector.collectOnce('BTC-EUR')
    if (raw === undefined) throw new Error('fixture item missing')
    const normalizer = new RssNewsNormalizer()
    const result = normalizer.normalizeItem(raw, {
      ingestedAt: time(Date.parse('2026-09-21T16:00:01.000Z')),
      retrievedAt: time(Date.parse('2026-09-21T16:00:02.000Z')),
    })

    expect(result.valid).toBe(true)
    if (result.valid) {
      expect(result.value.evidence).toMatchObject({
        source: 'sec',
        sourceLevel: 'official_primary',
        licenseStatus: 'official_public',
        publishedAt: Date.parse('2026-09-21T16:00:00.000Z'),
        ingestedAt: Date.parse('2026-09-21T16:00:01.000Z'),
        retrievedAt: Date.parse('2026-09-21T16:00:02.000Z'),
        relevance: 'relevant',
        taxonomy: 'market_structure',
        relevanceRuleVersion: NEWS_RELEVANCE_RULE_VERSION,
        taxonomyRuleVersion: NEWS_TAXONOMY_RULE_VERSION,
        content: { kind: 'metadata_only' },
      })
      expect(JSON.stringify(result.value)).not.toContain('long article body')
      expect(result.value.evidence.contentHash).toBe(
        contentHashForNewsEvidence(result.value.evidence),
      )
    }
  })

  it('marks invalid dates, missing fields, and non-HTTPS links as invalid', async () => {
    const normalizer = new RssNewsNormalizer()
    const result = normalizer.normalizeItem(
      {
        sourceId: 'fed',
        source: 'Federal Reserve',
        feedUrl: OFFICIAL_RSS_SOURCES.fed.feedUrl,
        sourceItemId: 'missing-fields',
        title: '',
        link: 'http://example.test/item',
        publishedAt: 'not-a-date',
      },
      { ingestedAt: time(2_000), retrievedAt: time(1_500) },
    )

    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['invalid_date', 'invalid_url', 'empty_title']),
      )
    }
  })

  it('uses exact relevance boundaries and keeps macro news non-Bitcoin-specific', () => {
    expect(classifyNewsRelevance('Bitcoin and EUR markets')).toBe('relevant')
    expect(classifyNewsRelevance('BTC outlook')).toBe('uncertain')
    expect(classifyNewsRelevance('Euro area inflation')).toBe('not_relevant')
    expect(classifyNewsRelevance('FOMC statement')).toBe('not_relevant')
  })

  it('classifies taxonomy separately from relevance and abstains unknown rules', () => {
    expect(classifyNewsTaxonomy('FOMC interest rate decision')).toEqual({
      taxonomy: 'macro',
      certain: true,
    })
    expect(classifyNewsTaxonomy('SEC proposes crypto regulation')).toEqual({
      taxonomy: 'regulation',
      certain: true,
    })
    expect(classifyNewsTaxonomy('Bitcoin and EUR event')).toEqual({
      taxonomy: 'other',
      certain: false,
    })
  })
})
