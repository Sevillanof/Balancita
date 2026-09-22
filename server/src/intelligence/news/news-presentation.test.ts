import { describe, expect, it } from 'vitest'
import type { GeminiClient, GeminiGenerateParams } from '../../gemini-client.ts'
import type { NewsEvidenceRecord, TimestampMs } from '../contracts.ts'
import { contentHashForNewsEvidence } from './rss-normalizer.ts'
import {
  NewsPresentationService,
  type NewsPresentation,
} from './news-presentation.ts'

function evidence(
  overrides: Partial<NewsEvidenceRecord> = {},
): NewsEvidenceRecord {
  const base = {
    id: 'news:sec:one',
    version: '1',
    instrumentId: 'BTC-EUR' as const,
    source: 'sec',
    sourceLevel: 'official_primary' as const,
    sourceItemId: 'one',
    url: 'https://www.sec.gov/news/one',
    publishedAt: Date.parse('2026-09-22T17:00:00.000Z') as TimestampMs,
    ingestedAt: Date.parse('2026-09-22T17:01:00.000Z') as TimestampMs,
    retrievedAt: Date.parse('2026-09-22T17:01:00.000Z') as TimestampMs,
    contentHash: '',
    licenseStatus: 'official_public' as const,
    correctionStatus: 'original' as const,
    relevance: 'relevant' as const,
    relevanceRuleVersion: 'news-relevance.v1',
    taxonomy: 'regulation' as const,
    taxonomyRuleVersion: 'news-taxonomy.v1',
    metadata: { title: 'La SEC publica una actualización sobre Bitcoin y EUR' },
    content: { kind: 'metadata_only' as const },
    ...overrides,
  }
  return { ...base, contentHash: contentHashForNewsEvidence(base) }
}

class FakeGemini implements GeminiClient {
  calls: GeminiGenerateParams[] = []
  response = JSON.stringify({
    summary: 'La SEC publicó una actualización normativa sobre Bitcoin y EUR.',
    tradeIntent: 'neutral',
    important: true,
  })
  error: unknown

  async generateStructuredText(params: GeminiGenerateParams): Promise<string> {
    this.calls.push(params)
    if (this.error !== undefined) throw this.error
    return this.response
  }
}

function service(client?: GeminiClient) {
  return new NewsPresentationService({
    client,
    model: 'test-model',
    maxOutputTokens: 200,
    timeoutMs: 100,
  })
}

describe('NewsPresentationService', () => {
  it('accepts a valid Spanish presentation and caches by evidence identity', async () => {
    const client = new FakeGemini()
    const summarizer = service(client)
    const item = evidence()

    const first = await summarizer.present(item)
    const second = await summarizer.present(item)

    expect(first).toEqual<NewsPresentation>({
      summary:
        'La SEC publicó una actualización normativa sobre Bitcoin y EUR.',
      tradeIntent: 'neutral',
      important: true,
    })
    expect(second).toEqual(first)
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]?.prompt).toContain('no es asesoramiento financiero')
  })

  it('rejects summaries over five sentences and uses deterministic fallback', async () => {
    const client = new FakeGemini()
    client.response = JSON.stringify({
      summary: 'Uno. Dos. Tres. Cuatro. Cinco. Seis.',
      tradeIntent: 'buy',
      important: false,
    })

    await expect(service(client).present(evidence())).resolves.toMatchObject({
      summary: 'La SEC publica una actualización sobre Bitcoin y EUR',
      tradeIntent: 'sell',
      important: true,
    })
  })

  it.each([
    ['malformed JSON', 'not-json'],
    [
      'invalid intent',
      JSON.stringify({
        summary: 'Resumen válido.',
        tradeIntent: 'hold',
        important: false,
      }),
    ],
    [
      'empty summary',
      JSON.stringify({ summary: '', tradeIntent: 'neutral', important: false }),
    ],
  ])('falls back for %s', async (_label, response) => {
    const client = new FakeGemini()
    client.response = response

    await expect(service(client).present(evidence())).resolves.toMatchObject({
      summary: 'La SEC publica una actualización sobre Bitcoin y EUR',
      tradeIntent: 'sell',
      important: true,
    })
  })

  it('falls back without a client or after an upstream failure', async () => {
    const noKey = await service().present(evidence())
    const client = new FakeGemini()
    client.error = new Error('quota')
    const failed = await service(client).present(evidence())

    expect(noKey).toEqual(failed)
    expect(noKey.summary).not.toBe('')
    expect(noKey.tradeIntent).toBe('sell')
  })

  it('uses permitted content for the deterministic summary and maps relevance safely', async () => {
    const result = await service().present(
      evidence({
        relevance: 'not_relevant',
        taxonomy: 'other',
        content: { kind: 'excerpt', text: 'Descripción permitida del feed.' },
      }),
    )

    expect(result).toEqual({
      summary: 'Descripción permitida del feed.',
      tradeIntent: 'neutral',
      important: false,
    })
  })
})
