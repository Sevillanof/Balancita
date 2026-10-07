import { describe, expect, it } from 'vitest'
import { createTickerPollClient, parseRestTickers } from './ticker-poll.ts'

const body = JSON.stringify({
  result: 'success',
  tickers: [
    {
      symbol: 'PF_ETHUSD',
      last: 2577.6,
      bid: 2577.7,
      ask: 2577.8,
      bidSize: 2.097,
      askSize: 1.818,
      markPrice: 2577.36834692919,
      indexPrice: 2577.43,
      fundingRate: -0.005628493164,
      relativeFundingRate: -2.18355e-6,
      suspended: false,
    },
    { symbol: 'PF_SOLUSD', bid: 10, ask: 9, markPrice: 9.5 },
    { symbol: 'PF_ADAUSD', bid: 1, ask: 2 },
    { symbol: 'FI_XBTUSD_261225', bid: 1, ask: 2, markPrice: 1.5 },
    { symbol: 'PF_XRPUSD', bid: 1, ask: 2, markPrice: 1.5 },
  ],
})

describe('REST ticker poll', () => {
  it('keeps requested products with a valid quote, shaped like the WebSocket tickers', () => {
    const events = parseRestTickers(body, {
      products: ['PF_ETHUSD', 'PF_SOLUSD', 'PF_ADAUSD'],
      receivedAtMs: 1_000,
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'ticker',
      productId: 'PF_ETHUSD',
      bid: '2577.7',
      ask: '2577.8',
      mark: '2577.36834692919',
      suspended: false,
      funding: { status: 'observed', rate: '-0.005628493164' },
      raw: {
        bid_size: '2.097',
        ask_size: '1.818',
        relative_funding_rate: '-0.00000218355',
      },
    })
  })

  it('fetches through the injected client and rejects bad responses', async () => {
    const client = createTickerPollClient({
      fetch: async () => new Response(body),
      clock: () => 5,
    })
    expect(await client.fetch(['PF_XRPUSD'])).toHaveLength(1)
    const failing = createTickerPollClient({
      fetch: async () => new Response('x', { status: 503 }),
    })
    await expect(failing.fetch(['PF_XRPUSD'])).rejects.toThrow(/503/)
    expect(() =>
      parseRestTickers('{}', { products: [], receivedAtMs: 1 }),
    ).toThrow()
  })
})
