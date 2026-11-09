import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ETH_BOOK_SAMPLE_MS,
  ETH_BOOK_SAMPLE_ENV,
  ethBookSampleMsFromEnv,
  ethExtraMarketFeed,
} from './capture-book-sample.ts'

describe('ETH book sample cadence (operacion-mejoras S1)', () => {
  it('defaults to one snapshot every 10 s', () => {
    expect(DEFAULT_ETH_BOOK_SAMPLE_MS).toBe(10_000)
    expect(ethBookSampleMsFromEnv({})).toBe(10_000)
    expect(ethBookSampleMsFromEnv({ [ETH_BOOK_SAMPLE_ENV]: '' })).toBe(10_000)
  })

  it('is overridden by FUTURES_ETH_BOOK_SAMPLE_MS (milliseconds)', () => {
    expect(ETH_BOOK_SAMPLE_ENV).toBe('FUTURES_ETH_BOOK_SAMPLE_MS')
    expect(ethBookSampleMsFromEnv({ [ETH_BOOK_SAMPLE_ENV]: '30000' })).toBe(
      30_000,
    )
    expect(ethBookSampleMsFromEnv({ [ETH_BOOK_SAMPLE_ENV]: ' 5000 ' })).toBe(
      5_000,
    )
    expect(ethBookSampleMsFromEnv({ [ETH_BOOK_SAMPLE_ENV]: '1000' })).toBe(
      1_000,
    )
  })

  it('ignores a value that is not a number or is below the 1 s sampler tick', () => {
    for (const bad of ['abc', '0', '-10000', '999', 'NaN', 'Infinity', '1e999'])
      expect(ethBookSampleMsFromEnv({ [ETH_BOOK_SAMPLE_ENV]: bad }), bad).toBe(
        10_000,
      )
  })

  it('applies only to the ETH feed, keeping the band and the level cap of the stored format', () => {
    const feed = ethExtraMarketFeed({})
    expect(feed).toEqual({ productId: 'PF_ETHUSD', bookSampleMs: 10_000 })
    // No band / level override: the +-0.1 % band and the 100-level cap stay the live-capture defaults.
    expect(feed).not.toHaveProperty('bookBand')
    expect(feed).not.toHaveProperty('bookMaxLevels')
    expect(
      ethExtraMarketFeed({ [ETH_BOOK_SAMPLE_ENV]: '20000' }).bookSampleMs,
    ).toBe(20_000)
  })
})
