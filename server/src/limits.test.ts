import { describe, expect, it } from 'vitest'
import { AnalysisRateLimiter } from './limits.ts'

const MINUTE = 60_000
const DAY = 86_400_000

describe('AnalysisRateLimiter', () => {
  it('allows up to the per-minute cap and rejects the next request', () => {
    const now = 1_000_000
    const limiter = new AnalysisRateLimiter({
      maxPerMinute: 15,
      maxPerDay: 500,
      now: () => now,
    })
    for (let index = 0; index < 15; index += 1) {
      expect(limiter.tryConsume()).toBe(true)
    }
    expect(limiter.tryConsume()).toBe(false)
  })

  it('releases the minute slot after the window rolls over', () => {
    let now = 1_000_000
    const limiter = new AnalysisRateLimiter({
      maxPerMinute: 2,
      maxPerDay: 500,
      now: () => now,
    })
    expect(limiter.tryConsume()).toBe(true)
    expect(limiter.tryConsume()).toBe(true)
    expect(limiter.tryConsume()).toBe(false)

    now += MINUTE + 1
    expect(limiter.tryConsume()).toBe(true)
  })

  it('enforces the daily cap independently of the minute window', () => {
    let now = 1_000_000
    const limiter = new AnalysisRateLimiter({
      maxPerMinute: 100,
      maxPerDay: 3,
      now: () => now,
    })
    expect(limiter.tryConsume()).toBe(true)
    expect(limiter.tryConsume()).toBe(true)
    expect(limiter.tryConsume()).toBe(true)
    expect(limiter.tryConsume()).toBe(false)

    now += MINUTE + 1
    expect(limiter.tryConsume()).toBe(false)
  })

  it('releases the daily slot after the 24h window expires', () => {
    let now = 1_000_000
    const limiter = new AnalysisRateLimiter({
      maxPerMinute: 100,
      maxPerDay: 1,
      now: () => now,
    })
    expect(limiter.tryConsume()).toBe(true)
    expect(limiter.tryConsume()).toBe(false)

    now += DAY + 1
    expect(limiter.tryConsume()).toBe(true)
  })

  it('rejects an invalid configuration up front', () => {
    expect(
      () =>
        new AnalysisRateLimiter({
          maxPerMinute: 0,
          maxPerDay: 1,
          now: () => 0,
        }),
    ).toThrow(RangeError)
    expect(
      () =>
        new AnalysisRateLimiter({
          maxPerMinute: 1,
          maxPerDay: -1,
          now: () => 0,
        }),
    ).toThrow(RangeError)
  })
})
