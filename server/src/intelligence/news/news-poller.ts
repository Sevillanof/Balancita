import type { TimestampMs } from '../contracts.ts'
import type { MarketStore } from '../market/market-store.ts'
import {
  OFFICIAL_RSS_SOURCES,
  RssNewsCollector,
  type NewsHttpFetcher,
  type RssNewsItem,
  type RssSourceConfig,
} from './rss-collector.ts'
import { RssNewsNormalizer } from './rss-normalizer.ts'
import { createNewsSnapshot, type IntelligenceNewsSnapshot } from '../stream.ts'
import type { GeminiClient } from '../../gemini-client.ts'
import { NewsPresentationService } from './news-presentation.ts'

export interface NewsPollingServiceOptions {
  readonly store: MarketStore
  readonly sources?: readonly RssSourceConfig[]
  readonly normalizerSources?: readonly RssSourceConfig[]
  readonly fetcher?: NewsHttpFetcher
  readonly userAgent: string
  readonly timeoutMs?: number
  readonly clock?: () => TimestampMs
  readonly staleAfterMs: number
  readonly geminiClient?: GeminiClient
  readonly model?: string
  readonly maxOutputTokens?: number
  readonly presentationTimeoutMs?: number
  readonly onChange?: () => void
}

export interface NewsPollingResult {
  readonly insertedCount: number
  readonly duplicateCount: number
  readonly failedSources: readonly string[]
}

export class NewsPollingService {
  private readonly store: MarketStore
  private readonly collectors: readonly RssNewsCollector[]
  private readonly normalizer: RssNewsNormalizer
  private readonly clock: () => TimestampMs
  private readonly staleAfterMs: number
  private readonly onChange: () => void
  private readonly presentation: NewsPresentationService
  private running = false
  private lastSuccessfulAt: TimestampMs | null = null
  private failedSources: readonly string[] = []
  private lastError: string | undefined

  constructor(options: NewsPollingServiceOptions) {
    if (options.staleAfterMs <= 0)
      throw new Error('News polling stale threshold must be positive.')
    this.store = options.store
    this.clock = options.clock ?? (() => Date.now() as TimestampMs)
    this.staleAfterMs = options.staleAfterMs
    this.onChange = options.onChange ?? (() => undefined)
    const rssSources = options.sources ?? Object.values(OFFICIAL_RSS_SOURCES)
    this.normalizer = new RssNewsNormalizer({
      sources: options.normalizerSources ?? rssSources,
    })
    this.presentation = new NewsPresentationService({
      client: options.geminiClient,
      model: options.model ?? 'gemini-3.5-flash-lite',
      maxOutputTokens: options.maxOutputTokens ?? 256,
      timeoutMs: options.presentationTimeoutMs ?? 15_000,
      clock: this.clock,
    })
    this.collectors = rssSources.map(
      (source) =>
        new RssNewsCollector({
          source,
          userAgent: options.userAgent,
          fetcher: options.fetcher,
          timeoutMs: options.timeoutMs,
          clock: this.clock,
        }),
    )
  }

  async pollOnce(): Promise<NewsPollingResult> {
    return this.pollCollectors(this.collectors)
  }

  async ingestExternal(
    items: readonly RssNewsItem[],
    source = items[0]?.sourceId ?? 'external-news',
  ): Promise<NewsPollingResult> {
    try {
      const ingestedAt = this.clock()
      const result = await this.ingestItems(items, ingestedAt)
      this.lastSuccessfulAt = ingestedAt
      this.failedSources = this.failedSources.filter((item) => item !== source)
      return { ...result, failedSources: this.failedSources }
    } catch (error) {
      this.recordFailure(source, error)
      throw error
    }
  }

  private async pollCollectors(
    collectors: readonly RssNewsCollector[],
  ): Promise<NewsPollingResult> {
    if (this.running)
      return {
        insertedCount: 0,
        duplicateCount: 0,
        failedSources: this.failedSources,
      }
    this.running = true
    try {
      const ingestedAt = this.clock()
      const outcomes = await Promise.all(
        collectors.map(async (collector) => {
          try {
            const items = await collector.collect('BTC-EUR')
            return { source: collector.source, items, error: undefined }
          } catch (error) {
            return {
              source: collector.source,
              items: [] as readonly RssNewsItem[],
              error: error instanceof Error ? error.message : String(error),
            }
          }
        }),
      )
      const failures = outcomes.filter((outcome) => outcome.error !== undefined)
      const successful = outcomes.length - failures.length
      this.failedSources = failures.map((outcome) => outcome.source)
      this.lastError =
        failures.length === 0
          ? undefined
          : failures
              .map((outcome) => `${outcome.source}: ${outcome.error}`)
              .join('; ')
      let insertedCount = 0
      let duplicateCount = 0
      for (const outcome of outcomes) {
        if (outcome.error !== undefined) continue
        const result = await this.ingestItems(outcome.items, ingestedAt, false)
        insertedCount += result.insertedCount
        duplicateCount += result.duplicateCount
      }
      if (successful > 0) this.lastSuccessfulAt = ingestedAt
      await this.preparePresentation(ingestedAt)
      this.onChange()
      return {
        insertedCount,
        duplicateCount,
        failedSources: this.failedSources,
      }
    } finally {
      this.running = false
    }
  }

  private async ingestItems(
    items: readonly RssNewsItem[],
    ingestedAt: TimestampMs,
    publish = true,
  ): Promise<Pick<NewsPollingResult, 'insertedCount' | 'duplicateCount'>> {
    let insertedCount = 0
    let duplicateCount = 0
    for (const raw of items) {
      const normalized = this.normalizer.normalizeItem(raw, {
        ingestedAt,
        retrievedAt: raw.retrievedAt,
      })
      if (!normalized.valid) continue
      const result = this.store.insertNewsEvidence(normalized.value.evidence)
      if (result.outcome === 'inserted') insertedCount += 1
      else duplicateCount += 1
    }
    if (publish) {
      await this.preparePresentation(ingestedAt)
      this.onChange()
    }
    return { insertedCount, duplicateCount }
  }

  private async preparePresentation(ingestedAt: TimestampMs): Promise<void> {
    await this.presentation.prepare(
      this.store
        .listNewsEvidence({ usableOnly: true })
        .filter((item) => isUtcToday(item.publishedAt, ingestedAt)),
    )
  }

  private recordFailure(source: string, error: unknown): void {
    this.failedSources = [...new Set([...this.failedSources, source])]
    this.lastError = `${source}: ${error instanceof Error ? error.message : String(error)}`
    this.onChange()
  }

  getSnapshot(displayedAt: TimestampMs): IntelligenceNewsSnapshot {
    const status =
      this.lastSuccessfulAt === null
        ? this.failedSources.length > 0
          ? 'error'
          : 'loading'
        : displayedAt - this.lastSuccessfulAt > this.staleAfterMs
          ? 'stale'
          : this.failedSources.length > 0
            ? 'error'
            : 'ready'
    return createNewsSnapshot({
      evidence: this.store.listNewsEvidence({ usableOnly: true }),
      displayedAt,
      status,
      lastSuccessfulAt: this.lastSuccessfulAt ?? undefined,
      error: this.lastError,
      staleAfterMs: this.staleAfterMs,
      presentation: (item) => this.presentation.get(item),
    })
  }
}

function isUtcToday(publishedAt: TimestampMs, reference: TimestampMs): boolean {
  const date = new Date(reference)
  const start = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  )
  return publishedAt >= start && publishedAt < start + 86_400_000
}
