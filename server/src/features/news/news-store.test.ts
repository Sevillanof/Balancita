import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MarketStore } from '../market-data/market-store.ts'
import {
  parseTimestampMs,
  type NewsEvidence,
  type TimestampMs,
} from '../../domain/contracts.ts'
import { contentHashForNewsEvidence } from './rss-normalizer.ts'

const directories: string[] = []

const time = (value: number): TimestampMs => {
  const result = parseTimestampMs(value)
  if (!result.valid) throw new Error('test timestamp must be valid')
  return result.value
}

function makePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-news-store-'))
  directories.push(directory)
  return join(directory, 'market.sqlite')
}

function evidence(overrides: Partial<NewsEvidence> = {}): NewsEvidence {
  const base: NewsEvidence = {
    instrumentId: 'BTC-EUR',
    source: 'sec',
    sourceLevel: 'official_primary',
    sourceItemId: 'sec-1',
    url: 'https://www.sec.gov/newsroom/press-releases/2026-1',
    publishedAt: time(1_000),
    ingestedAt: time(1_100),
    retrievedAt: time(1_150),
    contentHash: '',
    licenseStatus: 'official_public',
    correctionStatus: 'original',
    relevance: 'relevant',
    relevanceRuleVersion: 'news-relevance.v1',
    taxonomy: 'regulation',
    taxonomyRuleVersion: 'news-taxonomy.v1',
    metadata: { title: 'Bitcoin and EUR regulation' },
    content: { kind: 'metadata_only' },
    ...overrides,
  }
  return { ...base, contentHash: contentHashForNewsEvidence(base) }
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('MarketStore news evidence schema v3', () => {
  it('migrates v2, inserts idempotently, and survives restart', () => {
    const path = makePath()
    const first = new MarketStore({ path })
    expect(first.schemaVersion()).toBe(6)
    const item = evidence()
    const inserted = first.insertNewsEvidence(item)
    const duplicate = first.insertNewsEvidence(item)

    expect(inserted.outcome).toBe('inserted')
    expect(duplicate).toEqual({ ...inserted, outcome: 'duplicate' })
    expect(first.listNewsEvidence()).toHaveLength(1)
    expect(JSON.stringify(first.listNewsEvidence())).not.toContain('article')
    first.close()

    const second = new MarketStore({ path })
    expect(
      second.listNewsEvidence({ source: 'sec', relevance: 'relevant' }),
    ).toHaveLength(1)
    second.close()
  })

  it('appends corrections and retractions without overwriting prior evidence', () => {
    const store = new MarketStore({ path: makePath() })
    const original = evidence()
    const corrected = evidence({
      correctionStatus: 'corrected',
      correctionOfSourceItemId: 'sec-1',
      metadata: { title: 'Corrected Bitcoin and EUR regulation' },
    })
    const retracted = evidence({
      correctionStatus: 'retracted',
      correctionOfSourceItemId: 'sec-1',
      metadata: { title: 'Retracted Bitcoin and EUR regulation' },
    })

    expect(store.insertNewsEvidence(original).version).toBe('1')
    expect(store.insertNewsEvidence(corrected).version).toBe('2')
    expect(store.insertNewsEvidence(retracted).version).toBe('3')
    expect(store.listNewsEvidence()).toHaveLength(3)
    expect(store.listNewsEvidence({ relevance: 'relevant' })).toHaveLength(3)
    expect(
      store.listNewsEvidence({ relevance: 'relevant', usableOnly: true }),
    ).toHaveLength(0)
    expect(store.listNewsEvidence()[0]?.correctionStatus).toBe('original')
    store.close()
  })

  it('queries read-only evidence by source, publication window, and relevance', () => {
    const store = new MarketStore({ path: makePath() })
    store.insertNewsEvidence(evidence())
    store.insertNewsEvidence(
      evidence({
        source: 'ecb',
        sourceItemId: 'ecb-1',
        url: 'https://www.ecb.europa.eu/press/pr/1',
        publishedAt: time(2_000),
        ingestedAt: time(2_100),
        retrievedAt: time(2_150),
        metadata: { title: 'Bitcoin and Euro technology' },
        taxonomy: 'technology',
      }),
    )

    expect(
      store.listNewsEvidence({
        source: 'ecb',
        publishedAtFrom: time(1_500),
        publishedAtTo: time(2_500),
        relevance: 'relevant',
      }),
    ).toHaveLength(1)
    store.close()
  })
})
