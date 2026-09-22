import type { TimestampMs } from '../contracts.ts'
import type { MarketStore } from '../market/market-store.ts'
import {
  OFFICIAL_RSS_SOURCES,
  RssNewsCollector,
  type NewsHttpFetcher,
  type RssSourceConfig,
} from './rss-collector.ts'
import { RssNewsNormalizer } from './rss-normalizer.ts'
import { createNewsSnapshot, type IntelligenceNewsSnapshot } from '../stream.ts'
import type { GeminiClient } from '../../gemini-client.ts'
import { NewsPresentationService } from './news-presentation.ts'

export interface NewsPollingServiceOptions {
  readonly store: MarketStore
  readonly sources?: readonly RssSourceConfig[]
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
  private readonly normalizer = new RssNewsNormalizer()
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
    this.presentation = new NewsPresentationService({
      client: options.geminiClient,
      model: options.model ?? 'gemini-3.5-flash-lite',
      maxOutputTokens: options.maxOutputTokens ?? 256,
      timeoutMs: options.presentationTimeoutMs ?? 15_000,
      clock: this.clock,
    })
    this.collectors = (
      options.sources ?? Object.values(OFFICIAL_RSS_SOURCES)
    ).map(
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
        this.collectors.map(async (collector) => {
          try {
            const items = await collector.collect('BTC-EUR')
            let insertedCount = 0
            let duplicateCount = 0
            for (const raw of items) {
              const normalized = this.normalizer.normalizeItem(raw, {
                ingestedAt,
                retrievedAt: raw.retrievedAt,
              })
              if (!normalized.valid) continue
              const result = this.store.insertNewsEvidence(
                normalized.value.evidence,
              )
              if (result.outcome === 'inserted') insertedCount += 1
              else duplicateCount += 1
            }
            return {
              source: collector.source,
              insertedCount,
              duplicateCount,
              error: undefined,
            }
          } catch (error) {
            return {
              source: collector.source,
              insertedCount: 0,
              duplicateCount: 0,
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
      if (successful > 0) this.lastSuccessfulAt = ingestedAt
      await this.presentation.prepare(
        this.store
          .listNewsEvidence({ usableOnly: true })
          .filter((item) => isUtcToday(item.publishedAt, ingestedAt)),
      )
      this.onChange()
      return {
        insertedCount: outcomes.reduce(
          (total, outcome) => total + outcome.insertedCount,
          0,
        ),
        duplicateCount: outcomes.reduce(
          (total, outcome) => total + outcome.duplicateCount,
          0,
        ),
        failedSources: this.failedSources,
      }
    } finally {
      this.running = false
    }
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
