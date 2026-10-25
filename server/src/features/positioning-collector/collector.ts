import { HOUR_MS, MINUTE_MS, type PositioningStore } from './store.ts'
import type { PositioningSource } from './source.ts'

/** First hour Kraken has account positioning for (Jan 2024) and mark/spot candles (Mar 2022). */
export const POSITIONING_HISTORY_FROM_MS = Date.UTC(2024, 0, 1)
export const PREMIUM_HISTORY_FROM_MS = Date.UTC(2022, 2, 1)
/** Minute-level premium kept for the live chart. */
export const PREMIUM_MINUTES_KEPT_MS = 7 * 24 * HOUR_MS
const MAX_PAGES_PER_SERIES = 40

export class PositioningCollector {
  private readonly store: PositioningStore
  private readonly source: PositioningSource
  private readonly products: readonly string[]
  private readonly clock: () => number
  private readonly pause: (ms: number) => Promise<void>
  private readonly requestGapMs: number
  private readonly log: (line: string) => void
  private stopped = false

  constructor(options: {
    store: PositioningStore
    source: PositioningSource
    products: readonly string[]
    clock?: () => number
    pause?: (ms: number) => Promise<void>
    requestGapMs?: number
    log?: (line: string) => void
  }) {
    this.store = options.store
    this.source = options.source
    this.products = options.products
    this.clock = options.clock ?? Date.now
    this.pause =
      options.pause ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.requestGapMs = options.requestGapMs ?? 250
    this.log = options.log ?? (() => undefined)
  }

  stop(): void {
    this.stopped = true
    this.source.abortInFlight()
  }

  /**
   * One pass over every product and series: fetches only what is newer than
   * the stored data (history on the first pass), a failing series never stops
   * the others. Returns the number of series that failed.
   */
  async syncOnce(): Promise<number> {
    let failures = 0
    for (const productId of this.products)
      for (const series of ['all', 'top', 'hour', 'minute'] as const) {
        if (this.stopped) return failures
        try {
          await this.syncSeries(productId, series)
        } catch (error) {
          failures += 1
          this.log(
            `${productId} ${series} unavailable: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    this.store.pruneMinutes(this.clock(), PREMIUM_MINUTES_KEPT_MS)
    return failures
  }

  private async syncSeries(
    productId: string,
    series: 'all' | 'top' | 'hour' | 'minute',
  ): Promise<void> {
    let requested = false
    let cursor = 0
    for (let page = 0; page < MAX_PAGES_PER_SERIES; page += 1) {
      if (this.stopped) return
      const now = this.clock()
      const interval = series === 'minute' ? MINUTE_MS : HOUR_MS
      const latest =
        series === 'all' || series === 'top'
          ? this.store.latestPositioning(productId, series)
          : this.store.latestPremium(productId, interval)
      // The newest bucket is already stored: nothing closed since.
      if (latest !== undefined && latest + 2 * interval > now) return
      const start =
        series === 'minute'
          ? Math.max(now - PREMIUM_MINUTES_KEPT_MS, (latest ?? 0) + interval)
          : latest === undefined
            ? series === 'hour'
              ? PREMIUM_HISTORY_FROM_MS
              : POSITIONING_HISTORY_FROM_MS
            : latest + interval
      const from = Math.max(start, cursor)
      if (requested) await this.pause(this.requestGapMs)
      requested = true
      if (series === 'hour' || series === 'minute') {
        const result = await this.source.premium(productId, interval, from)
        this.store.putPremium(result.rows)
        cursor = result.nextFromMs
        if (!result.more) return
        continue
      }
      const metric = series === 'all' ? 'long-short-info' : 'top-traders'
      const result = await this.source.accounts(productId, metric, from)
      for (const point of result.points) {
        const values = point.values
        if (series === 'all')
          this.store.putAll(productId, point.bucketStart, {
            percent: Number(values.longPercent),
            longCount: Number(values.longCount),
            shortCount: Number(values.shortCount),
          })
        else
          this.store.putTop(productId, point.bucketStart, {
            percent: Number(values['top20Percent.longPercent']),
            longCount: Number(values['top20Percent.longCount']),
            shortCount: Number(values['top20Percent.shortCount']),
            openInterest: Number(values['top20Percent.openInterest']),
          })
      }
      const moved = this.store.latestPositioning(productId, series)
      if (!result.more || moved === latest) return
    }
  }
}
