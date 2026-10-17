import { describe, expect, it } from 'vitest'
import { createTickerPollClient, parseRestTickers } from './ticker-poll.ts'

const body = JSON.stringify({
  result: 'success',
  serverTime: '2026-10-17T12:20:04.297Z',
  tickers: [
    {
      symbol: 'PF_ETHUSD',
      last: 2577.6,
      lastTime: '2026-10-17T12:19:51.284373141Z',
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
        server_time: '2026-10-17T12:20:04.297Z',
        last_time: '2026-10-17T12:19:51.284373141Z',
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

describe('ticker poll connection renewal', () => {
  it('asks for a new connection after a failure and stops once a request succeeds', async () => {
    const headers: unknown[] = []
    let fail = true
    const failures: string[] = []
    let recovered = 0
    const client = createTickerPollClient({
      fetch: async (_url, init) => {
        headers.push((init?.headers as Record<string, string>).connection)
        if (fail) throw new Error('socket hang up')
        return new Response(JSON.stringify({ result: 'success', tickers: [] }))
      },
      onFailure: (reason) => failures.push(reason),
      onRecovered: () => (recovered += 1),
    })
    await expect(client.fetch(['PF_ETHUSD'])).rejects.toThrow()
    fail = false
    await client.fetch(['PF_ETHUSD'])
    await client.fetch(['PF_ETHUSD'])
    expect(headers).toEqual([undefined, 'close', undefined])
    expect(failures).toEqual(['socket hang up'])
    expect(recovered).toBe(1)
  })

  it('also renews while the capture reports a general connectivity problem', async () => {
    const headers: unknown[] = []
    const client = createTickerPollClient({
      fetch: async (_url, init) => {
        headers.push((init?.headers as Record<string, string>).connection)
        return new Response(JSON.stringify({ result: 'success', tickers: [] }))
      },
      freshConnections: () => true,
    })
    await client.fetch(['PF_ETHUSD'])
    expect(headers).toEqual(['close'])
  })
})
