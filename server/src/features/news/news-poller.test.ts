import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  GeminiClient,
  GeminiGenerateParams,
} from '../../platform/gemini/gemini-client.ts'
import type { TimestampMs } from '../../domain/contracts.ts'
import { MarketStore } from '../market-data/market-store.ts'
import { OFFICIAL_RSS_SOURCES, type NewsHttpFetcher } from './rss-collector.ts'
import { NewsPollingService } from './news-poller.ts'

const directories: string[] = []
const now = Date.parse('2026-09-21T17:00:00.000Z') as TimestampMs
const fixture = readFileSync(
  new URL('./__fixtures__/sec.rss', import.meta.url),
  'utf8',
)

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function makeStore(): MarketStore {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-news-poller-'))
  directories.push(directory)
  return new MarketStore({ path: join(directory, 'market.sqlite') })
}

class FakeGemini implements GeminiClient {
  readonly calls: GeminiGenerateParams[] = []

  async generateStructuredText(params: GeminiGenerateParams): Promise<string> {
    this.calls.push(params)
    return JSON.stringify({
      summary: 'Resumen generado para la noticia.',
      tradeIntent: 'neutral',
      important: true,
    })
  }
}

describe('NewsPollingService', () => {
  it('uses injected fetch and clock, applies the official normalizer, and isolates feed failures', async () => {
    const store = makeStore()
    const calls: string[] = []
    const fetcher: NewsHttpFetcher = async (url) => {
      calls.push(url)
      return url === OFFICIAL_RSS_SOURCES.sec.feedUrl
        ? { status: 200, body: fixture }
        : Promise.reject(new Error('feed unavailable'))
    }
    const service = new NewsPollingService({
      store,
      sources: [OFFICIAL_RSS_SOURCES.sec, OFFICIAL_RSS_SOURCES.fed],
      fetcher,
      userAgent: 'Balancita/test',
      clock: () => now,
      staleAfterMs: 60_000,
    })

    await service.pollOnce()

    expect(calls).toEqual([
      OFFICIAL_RSS_SOURCES.sec.feedUrl,
      OFFICIAL_RSS_SOURCES.fed.feedUrl,
    ])
    expect(store.newsEvidenceCount()).toBe(1)
    expect(service.getSnapshot(now)).toMatchObject({
      status: 'error',
      items: [{ source: 'sec', licenseStatus: 'official_public' }],
    })
    expect(service.getSnapshot((now + 60_001) as TimestampMs).status).toBe(
      'stale',
    )
    store.close()
  })

  it('keeps one current corrected version while preserving append-only evidence', async () => {
    const store = makeStore()
    let body = fixture
    const fetcher: NewsHttpFetcher = async () => ({ status: 200, body })
    const service = new NewsPollingService({
      store,
      sources: [OFFICIAL_RSS_SOURCES.sec],
      fetcher,
      userAgent: 'Balancita/test',
      clock: () => now,
      staleAfterMs: 60_000,
    })

    await service.pollOnce()
    body = fixture.replaceAll(
      'market structure roundtable',
      'corrected market structure roundtable',
    )
    const second = await service.pollOnce()

    expect(second).toMatchObject({ insertedCount: 1, duplicateCount: 0 })
    expect(store.newsEvidenceCount()).toBe(2)
    expect(service.getSnapshot(now).items).toMatchObject([
      {
        version: '2',
        title:
          'SEC announces Bitcoin and EUR corrected market structure roundtable',
      },
    ])
    store.close()
  })

  it('projects Gemini presentation metadata without changing stored evidence', async () => {
    const store = makeStore()
    const client = new FakeGemini()
    const service = new NewsPollingService({
      store,
      sources: [OFFICIAL_RSS_SOURCES.sec],
      fetcher: async () => ({ status: 200, body: fixture }),
      userAgent: 'Balancita/test',
      clock: () => now,
      staleAfterMs: 60_000,
      geminiClient: client,
      model: 'test-model',
      maxOutputTokens: 100,
      presentationTimeoutMs: 100,
    })

    await service.pollOnce()
    const first = service.getSnapshot(now)
    const second = service.getSnapshot(now)

    expect(first.items[0]).toMatchObject({
      summary: 'Resumen generado para la noticia.',
      tradeIntent: 'neutral',
      important: true,
    })
    expect(second.items).toEqual(first.items)
    expect(client.calls).toHaveLength(1)
    expect(store.listNewsEvidence()[0]?.content.kind).toBe('metadata_only')
    store.close()
  })
})
