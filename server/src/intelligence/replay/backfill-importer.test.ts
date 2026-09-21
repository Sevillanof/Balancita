import { afterEach, describe, expect, it } from 'vitest'
import type { TimestampMs } from '../contracts.ts'
import { createKrakenCatchUpClient } from '../market/kraken-market-collector.ts'
import {
  KRAKEN_TIME_AND_SALES_CSV,
  KRAKEN_TIME_AND_SALES_WITH_CONFLICT_CSV,
  krakenTradesResponse,
} from './__fixtures__/kraken-time-and-sales.ts'
import {
  alignWindows,
  importBackfill,
  type BackfillImportOptions,
} from './backfill-importer.ts'
import {
  createArchiveBackfillSource,
  parseTimeAndSalesCsv,
} from './kraken-archive.ts'
import { createRestBackfillSource } from './kraken-trades-source.ts'
import {
  ReplayImportError,
  type BackfillSource,
  type BackfillSourcePage,
  type BackfillSourceRequest,
  type BackfillWindow,
  type ReplayTrade,
  type ReplayTradeOrigin,
} from './replay-contracts.ts'

const T0 = 1_789_984_800_000
const MINUTE = 60_000
const CLOCK = T0 + 999_000

class ScriptedSource implements BackfillSource {
  readonly origin: ReplayTradeOrigin
  readonly requests: BackfillSourceRequest[] = []
  private calls = 0
  private readonly handler: (
    request: BackfillSourceRequest,
    call: number,
  ) => BackfillSourcePage | Promise<BackfillSourcePage>

  constructor(
    origin: ReplayTradeOrigin,
    handler: (
      request: BackfillSourceRequest,
      call: number,
    ) => BackfillSourcePage | Promise<BackfillSourcePage>,
  ) {
    this.origin = origin
    this.handler = handler
  }

  async fetchPage(request: BackfillSourceRequest): Promise<BackfillSourcePage> {
    this.requests.push(request)
    return this.handler(request, this.calls++)
  }
}

const windows: readonly BackfillWindow[] = [
  {
    index: 0,
    startTime: T0 as TimestampMs,
    endTime: (T0 + MINUTE) as TimestampMs,
  },
  {
    index: 1,
    startTime: (T0 + MINUTE) as TimestampMs,
    endTime: (T0 + 2 * MINUTE) as TimestampMs,
  },
]

function trade(input: {
  tradeId: number
  eventTime: number
  price?: number
  qty?: number
  side?: 'buy' | 'sell'
  orderType?: 'limit' | 'market'
  origin?: ReplayTradeOrigin
}): ReplayTrade {
  return {
    instrumentId: 'BTC-EUR',
    source: 'kraken',
    tradeId: input.tradeId,
    eventTime: input.eventTime as TimestampMs,
    receivedTime: CLOCK as TimestampMs,
    price: input.price ?? 60_000,
    qty: input.qty ?? 0.5,
    side: input.side ?? 'buy',
    ...(input.orderType === undefined ? {} : { orderType: input.orderType }),
    origin: input.origin ?? 'archive',
  }
}

const archiveTrades: readonly ReplayTrade[] = [
  trade({ tradeId: 100, eventTime: T0 + 1_000 }),
  trade({ tradeId: 101, eventTime: T0 + 2_000 }),
  trade({ tradeId: 104, eventTime: T0 + MINUTE + 1_000 }),
  trade({ tradeId: 105, eventTime: T0 + MINUTE + 2_000 }),
]

function archiveFor(trades: readonly ReplayTrade[]): ScriptedSource {
  return new ScriptedSource('archive', ({ window }) => ({
    trades: trades.filter(
      (entry) =>
        entry.eventTime >= window.startTime && entry.eventTime < window.endTime,
    ),
    hasMore: false,
  }))
}

function importOptions(
  overrides: Partial<BackfillImportOptions> = {},
): BackfillImportOptions {
  return {
    windows,
    archive: archiveFor(archiveTrades),
    clock: () => CLOCK as TimestampMs,
    maxAttempts: 3,
    backoffMs: 100,
    sleep: async () => {},
    ...overrides,
  }
}

const directories: string[] = []

afterEach(() => {
  directories.splice(0)
})

describe('backfill window alignment', () => {
  it('aligns windows to interval boundaries covering the requested range', () => {
    const aligned = alignWindows(T0 + 30_000, T0 + 150_000, MINUTE)
    expect(aligned).toEqual([
      { index: 0, startTime: T0, endTime: T0 + MINUTE },
      { index: 1, startTime: T0 + MINUTE, endTime: T0 + 2 * MINUTE },
      { index: 2, startTime: T0 + 2 * MINUTE, endTime: T0 + 3 * MINUTE },
    ])
    expect(() => alignWindows(T0, T0, MINUTE)).toThrow(ReplayImportError)
  })
})

describe('Kraken Time & Sales archive parsing', () => {
  it('parses archive rows into trades preserving event and received time', () => {
    const parsed = parseTimeAndSalesCsv(KRAKEN_TIME_AND_SALES_CSV, {
      clock: () => CLOCK as TimestampMs,
    })
    expect(parsed.map((entry) => entry.tradeId)).toEqual([100, 101, 104, 105])
    expect(parsed[0]).toMatchObject({
      eventTime: T0 + 1_000,
      receivedTime: CLOCK,
      price: 60_000,
      qty: 0.5,
      side: 'buy',
      orderType: 'limit',
      origin: 'archive',
      source: 'kraken',
    })
    expect(parsed[1]).toMatchObject({ side: 'sell', orderType: 'market' })
  })

  it('keeps conflicting archive rows so the importer can reject them', () => {
    const parsed = parseTimeAndSalesCsv(
      KRAKEN_TIME_AND_SALES_WITH_CONFLICT_CSV,
      {
        clock: () => CLOCK as TimestampMs,
      },
    )
    expect(parsed.map((entry) => entry.tradeId)).toEqual([100, 101, 101])
  })

  it('rejects malformed archive rows instead of fabricating trades', () => {
    expect(() =>
      parseTimeAndSalesCsv(
        'timestamp,price,volume,type,order_type,misc,trade_id\nnope',
        {
          clock: () => CLOCK as TimestampMs,
        },
      ),
    ).toThrow(ReplayImportError)
  })
})

describe('REST trade source', () => {
  it('maps fixture REST rows into backfill trades bounded by the window', async () => {
    const client = createKrakenCatchUpClient({
      restBaseUrl: 'https://api.kraken.com/0',
      fetch: async () =>
        new Response(
          krakenTradesResponse([
            ['60005.00000', '0.2', 1_789_984_803.0, 'b', 'l', '', 102],
            ['60006.00000', '0.1', 1_789_984_804.0, 's', 'm', '', 103],
            ['69999.00000', '0.1', 1_789_984_900.0, 's', 'm', '', 999],
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    })
    const source = createRestBackfillSource({
      client,
      clock: () => CLOCK as TimestampMs,
    })
    const page = await source.fetchPage({
      window: {
        index: 0,
        startTime: (T0 + 2_000) as TimestampMs,
        endTime: (T0 + MINUTE) as TimestampMs,
      },
      cursor: { windowIndex: 0, lastTradeId: 101, lastEventTime: null },
      attempt: 1,
      sinceTradeId: 101,
    })
    expect(page.trades.map((entry) => entry.tradeId)).toEqual([102, 103])
    expect(page.trades[0]).toMatchObject({
      origin: 'rest',
      receivedTime: CLOCK,
      price: 60_005,
      side: 'buy',
    })
  })
})

describe('cursor-based backfill import', () => {
  it('imports aligned windows and resolves a trade-id gap through REST catch-up', async () => {
    const rest = new ScriptedSource('rest', () => ({
      trades: [
        trade({ tradeId: 102, eventTime: T0 + 3_000, origin: 'rest' }),
        trade({ tradeId: 103, eventTime: T0 + 4_000, origin: 'rest' }),
      ],
      hasMore: false,
    }))

    const result = await importBackfill(importOptions({ rest }))

    expect(result.trades.map((entry) => entry.tradeId)).toEqual([
      100, 101, 102, 103, 104, 105,
    ])
    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]).toMatchObject({
      kind: 'trade_id',
      previousTradeId: 101,
      nextTradeId: 104,
      missingTradeIds: [102, 103],
      resolved: true,
      resolution: 'rest_catch_up',
    })
    expect(rest.requests[0]?.sinceTradeId).toBe(101)
    expect(result.cursor).toMatchObject({ windowIndex: 2, lastTradeId: 105 })
    expect(result.conflicts).toEqual([])
  })

  it('records an unresolved gap when catch-up cannot fill it, never silently', async () => {
    const delays: number[] = []
    const rest = new ScriptedSource('rest', () => {
      throw new Error('rest unavailable')
    })

    const result = await importBackfill(
      importOptions({
        rest,
        sleep: async (delay) => {
          delays.push(delay)
        },
      }),
    )

    expect(result.trades.map((entry) => entry.tradeId)).toEqual([
      100, 101, 104, 105,
    ])
    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]).toMatchObject({
      missingTradeIds: [102, 103],
      resolved: false,
      resolution: 'unresolved',
    })
    expect(delays).toEqual([100, 200])
    expect(rest.requests).toHaveLength(3)
  })

  it('retries a transient source failure with bounded backoff', async () => {
    const delays: number[] = []
    const archive = new ScriptedSource('archive', ({ window }, call) => {
      if (call < 2) throw new Error('transient archive failure')
      return {
        trades: archiveTrades.filter(
          (entry) =>
            entry.eventTime >= window.startTime &&
            entry.eventTime < window.endTime,
        ),
        hasMore: false,
      }
    })

    const result = await importBackfill(
      importOptions({
        archive,
        sleep: async (delay) => {
          delays.push(delay)
        },
      }),
    )

    expect(result.trades).toHaveLength(4)
    expect(delays).toEqual([100, 200])
    expect(archive.requests).toHaveLength(4)
  })

  it('deduplicates identical trade ids and rejects conflicting duplicates', async () => {
    const archive = archiveFor([
      trade({ tradeId: 100, eventTime: T0 + 1_000 }),
      trade({ tradeId: 100, eventTime: T0 + 1_000 }),
      trade({ tradeId: 101, eventTime: T0 + 2_000, price: 60_001 }),
      trade({ tradeId: 101, eventTime: T0 + 2_000, price: 69_999 }),
    ])

    const result = await importBackfill(importOptions({ archive }))

    expect(result.duplicateCount).toBe(1)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toMatchObject({
      tradeId: 101,
      existing: { price: 60_001 },
      incoming: { price: 69_999 },
    })
    expect(result.trades.map((entry) => entry.tradeId)).toEqual([100, 101])
  })

  it('resumes from a cursor without refetching completed windows', async () => {
    const archive = archiveFor(archiveTrades)
    const result = await importBackfill(
      importOptions({
        archive,
        startingCursor: {
          windowIndex: 1,
          lastTradeId: 101,
          lastEventTime: (T0 + 2_000) as TimestampMs,
        },
      }),
    )

    expect(archive.requests.map((request) => request.window.index)).toEqual([1])
    expect(result.trades.map((entry) => entry.tradeId)).toEqual([104, 105])
    expect(result.cursor.windowIndex).toBe(2)
  })

  it('rejects windows that are unordered or overlapping', async () => {
    await expect(
      importBackfill(
        importOptions({
          windows: [
            {
              index: 1,
              startTime: (T0 + MINUTE) as TimestampMs,
              endTime: (T0 + 2 * MINUTE) as TimestampMs,
            },
            {
              index: 0,
              startTime: T0 as TimestampMs,
              endTime: (T0 + MINUTE) as TimestampMs,
            },
          ],
        }),
      ),
    ).rejects.toThrow(ReplayImportError)
  })

  it('uses the archive source by default and never calls a private endpoint', async () => {
    const source = createArchiveBackfillSource({
      csv: KRAKEN_TIME_AND_SALES_CSV,
      clock: () => CLOCK as TimestampMs,
    })
    expect(source.origin).toBe('archive')
    const page = await source.fetchPage({
      window: windows[1] as BackfillWindow,
      cursor: { windowIndex: 1, lastTradeId: 101, lastEventTime: null },
      attempt: 1,
    })
    expect(page.trades.map((entry) => entry.tradeId)).toEqual([104, 105])
    expect(JSON.stringify(page)).not.toMatch(/private|AddOrder|Balance/i)
  })
})
