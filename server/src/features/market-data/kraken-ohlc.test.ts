import { describe, expect, it } from 'vitest'
import { collectKrakenOhlc } from './kraken-ohlc.ts'

describe('collectKrakenOhlc', () => {
  it('requests one 720-candle-bounded window, excludes the unfinished final bar, and counts gaps', async () => {
    const requests: URL[] = []
    const fixture = {
      result: {
        XBTEUR: [
          [60, '10', '11', '9', '10', '10', '1', 2],
          [120, '10', '11', '9', '10', '10', '1', 2],
          [240, '10', '11', '9', '10', '10', '1', 2],
          [300, '10', '11', '9', '10', '10', '1', 2],
        ],
        last: 360,
      },
      error: [],
    }
    const result = await collectKrakenOhlc({
      baseUrl: 'https://fixture.invalid/0',
      hours: 1,
      nowSeconds: 359,
      fetch: async (input) => {
        requests.push(new URL(input))
        return new Response(JSON.stringify(fixture))
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.searchParams.get('since')).toBe('0')
    expect(result.candles.map(({ timestamp }) => timestamp)).toEqual([
      60, 120, 240,
    ])
    expect(result.gapsDetected).toBe(1)
  })

  it('rejects lookbacks above the documented 12-hour history limit', async () => {
    await expect(
      collectKrakenOhlc({
        baseUrl: 'https://fixture.invalid',
        hours: 12.01,
        fetch: async () => new Response(),
      }),
    ).rejects.toThrow('hours must be greater than 0 and at most 12.')
  })
})
