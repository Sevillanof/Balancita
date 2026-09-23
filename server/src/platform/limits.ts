/**
 * Internal request budget enforced inside the gateway so the app stays under
 * the free-tier caps even if Google's own limits misbehave or lag. Uses
 * sliding one-minute and 24-hour windows so tests can drive the clock without
 * waiting.
 */
export interface RateLimiterOptions {
  maxPerMinute: number
  maxPerDay: number
  now?: () => number
}

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000

export class AnalysisRateLimiter {
  private readonly maxPerMinute: number
  private readonly maxPerDay: number
  private readonly now: () => number
  private minuteHits: number[] = []
  private dayHits: number[] = []

  constructor(options: RateLimiterOptions) {
    if (!Number.isInteger(options.maxPerMinute) || options.maxPerMinute <= 0) {
      throw new RangeError('maxPerMinute must be a positive integer.')
    }
    if (!Number.isInteger(options.maxPerDay) || options.maxPerDay <= 0) {
      throw new RangeError('maxPerDay must be a positive integer.')
    }
    this.maxPerMinute = options.maxPerMinute
    this.maxPerDay = options.maxPerDay
    this.now = options.now ?? (() => Date.now())
  }

  /** Registers one request when under budget; returns false when over either cap. */
  tryConsume(): boolean {
    const now = this.now()
    this.minuteHits = this.minuteHits.filter((hit) => hit > now - MINUTE_MS)
    this.dayHits = this.dayHits.filter((hit) => hit > now - DAY_MS)
    if (
      this.minuteHits.length >= this.maxPerMinute ||
      this.dayHits.length >= this.maxPerDay
    ) {
      return false
    }
    this.minuteHits.push(now)
    this.dayHits.push(now)
    return true
  }
}
