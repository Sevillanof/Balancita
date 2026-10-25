import {
  expired,
  plan,
  type IndicatorCatalog,
  type SeriesKind,
} from './catalog.ts'
import { HOUR_MS, MINUTE_MS, type PositioningStore } from './store.ts'
import type { PositioningSource } from './source.ts'

const MAX_PAGES_PER_SERIES = 40

export class PositioningCollector {
  private readonly store: PositioningStore
  private readonly source: PositioningSource
  private readonly catalog: IndicatorCatalog
  private readonly clock: () => number
  private readonly pause: (ms: number) => Promise<void>
  private readonly requestGapMs: number
  private readonly log: (line: string) => void
  private stopped = false

  constructor(options: {
    store: PositioningStore
    source: PositioningSource
    catalog: IndicatorCatalog
    clock?: () => number
    pause?: (ms: number) => Promise<void>
    requestGapMs?: number
    log?: (line: string) => void
  }) {
    this.store = options.store
    this.source = options.source
    this.catalog = options.catalog
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
   * One pass over what the active indicator cards ask for: fetches only what
   * is newer than the stored data (history on the first pass), a failing series
   * never stops the others, and series of long-archived cards are deleted.
   * Returns the number of series that failed.
   */
  async syncOnce(): Promise<number> {
    let failures = 0
    const now = this.clock()
    for (const { productId, kind } of expired(this.catalog, now)) {
      const removed = this.store.deleteSeries(productId, kind)
      if (removed > 0)
        this.log(
          `${productId} ${kind}: archived indicator deleted (${removed} rows)`,
        )
    }
    for (const { productId, kind, fromMs } of plan(this.catalog, now)) {
      if (this.stopped) return failures
      try {
        await this.syncSeries(productId, kind, fromMs)
      } catch (error) {
        failures += 1
        this.log(
          `${productId} ${kind} unavailable: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      this.store.trimBefore(productId, kind, fromMs)
    }
    return failures
  }

  private async syncSeries(
    productId: string,
    series: SeriesKind,
    fromMs: number,
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
      const start = Math.max(
        fromMs,
        latest === undefined ? 0 : latest + interval,
      )
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
