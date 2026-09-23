import { describe, expect, it } from 'vitest'
import { parseTimestampMs, type NewsEvidence } from './contracts.ts'
import { evaluateNewsSource } from './source-policy.ts'

const time = (value: number) => {
  const result = parseTimestampMs(value)
  if (!result.valid) throw new Error('test timestamp must be valid')
  return result.value
}

const validEvidence: NewsEvidence = {
  instrumentId: 'BTC-EUR',
  source: 'European Central Bank',
  sourceLevel: 'official_primary',
  sourceItemId: 'ecb-1',
  url: 'https://www.ecb.europa.eu/press/pr/date/html/index.en.html',
  publishedAt: time(1_000),
  ingestedAt: time(1_100),
  retrievedAt: time(1_200),
  contentHash: 'sha256:abc123',
  licenseStatus: 'official_public',
  correctionStatus: 'original',
  relevance: 'relevant',
  relevanceRuleVersion: 'news-relevance.v1',
  taxonomy: 'macro',
  taxonomyRuleVersion: 'news-taxonomy.v1',
  metadata: { title: 'Bitcoin and EUR policy' },
  content: { kind: 'excerpt', text: 'Permitted fragment.' },
}

describe('news source policy', () => {
  it('accepts complete official provenance for BTC-EUR', () => {
    const decision = evaluateNewsSource(validEvidence)
    expect(decision.accepted).toBe(true)
    expect(decision.reasons).toEqual([])
  })

  it('requires licensed provenance and excludes unverified social sources', () => {
    const licensed = evaluateNewsSource({
      ...validEvidence,
      sourceLevel: 'licensed_reporting',
      licenseStatus: 'licensed',
    })
    expect(licensed.accepted).toBe(true)

    const social = evaluateNewsSource({
      ...validEvidence,
      sourceLevel: 'unverified_social',
    })
    expect(social.accepted).toBe(false)
    expect(social.reasons.map((reason) => reason.code)).toContain(
      'source_level_excluded',
    )

    const unverifiedLicense = evaluateNewsSource({
      ...validEvidence,
      sourceLevel: 'licensed_reporting',
      licenseStatus: 'unknown',
    })
    expect(unverifiedLicense.accepted).toBe(true)
  })

  it('rejects non-HTTPS URLs, unsupported pairs, empty hashes, and impossible ordering', () => {
    const invalid = evaluateNewsSource({
      ...validEvidence,
      instrumentId: 'ETH-EUR',
      url: 'http://example.com/news',
      publishedAt: time(1_300),
      contentHash: ' ',
    })
    expect(invalid.accepted).toBe(false)
    expect(invalid.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        'unsupported_instrument',
        'url_must_be_https',
        'published_after_ingested',
        'empty_content_hash',
      ]),
    )
  })

  it('requires explicit correction and license states', () => {
    const invalid = evaluateNewsSource({
      ...validEvidence,
      licenseStatus: 'unknown',
      correctionStatus: 'unknown',
    })
    expect(invalid.accepted).toBe(false)
    expect(invalid.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining([
        'license_status_not_permitted',
        'invalid_correction_status',
      ]),
    )
  })

  it('accepts a referenced retraction for append-only historical storage', () => {
    const retracted = evaluateNewsSource({
      ...validEvidence,
      correctionStatus: 'retracted',
      correctionOfSourceItemId: validEvidence.sourceItemId,
    })

    expect(retracted.accepted).toBe(true)
    expect(retracted.evidence?.correctionStatus).toBe('retracted')
  })

  it('rejects malformed external input with structured reasons instead of throwing', () => {
    const decision = evaluateNewsSource({ source: ' ', url: 42 })
    expect(decision.accepted).toBe(false)
    expect(decision.reasons.map((reason) => reason.code)).toEqual(
      expect.arrayContaining(['empty_source', 'invalid_url']),
    )
  })
})
