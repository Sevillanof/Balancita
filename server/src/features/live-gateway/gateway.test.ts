/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON assertions */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'
import { DatabaseSync } from 'node:sqlite'
import { buildLiveGateway, LIVE_RUN_ID } from './gateway.ts'

const dirs: string[] = []
const closers: Array<() => Promise<void> | void> = []
function dbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-gateway-'))
  dirs.push(dir)
  return join(dir, 'market.sqlite')
}
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const MINUTE = 60_000
const BASE = 1_790_000_000_000 - (1_790_000_000_000 % MINUTE)

function saveCandle(
  store: FuturesMarketStore,
  index: number,
  revision: number,
  closed: boolean,
  close = '90000',
): void {
  const bucket = BASE + index * MINUTE
  store.saveCandleRevision({
    id: `PF_XBTUSD:60000:${bucket}`,
    intervalMs: MINUTE,
    bucketStart: bucket,
    revision,
    knownAt: bucket + MINUTE + (closed ? revision : -30_000),
    ...(closed ? { closeAt: bucket + MINUTE } : {}),
    isClosed: closed,
    coverage: 'observed_trades_only_no_gap_certification',
    open: '89990',
    high: '90010',
    low: '89980',
    close,
    volumeBtc: '1.5',
    tradeCount: 3,
    sourceHash: 'a'.repeat(64),
  })
}

function ticker(seq: number, receivedAt: number, last = '90001.5') {
  return {
    type: 'ticker',
    productId: 'PF_XBTUSD',
    seq,
    epoch: 1,
    eventTime: receivedAt - 1,
    receivedAt,
    persistedAt: receivedAt,
    last,
    mark: '90000',
    suspended: false,
    funding: { status: 'unknown' },
    raw: { feed: 'ticker' },
  }
}

function seedWriter(path: string, closedCandles = 5) {
  const writer = new FuturesMarketStore(path)
  for (let index = 0; index < closedCandles; index += 1)
    saveCandle(writer, index, 1, true)
  writer.append(ticker(1, BASE + closedCandles * MINUTE + 1_000))
  return writer
}

let officialSerial = 0
/** Appends official 1m candles for bucket indexes, as one response each. */
function saveOfficial(
  store: FuturesMarketStore,
  indexes: number[],
  close = '90100',
  receivedAtMs = BASE + 100 * MINUTE,
  productId = 'PF_XBTUSD',
): void {
  officialSerial += 1
  const candles = indexes.map((index) => ({
    intervalMs: MINUTE,
    bucketStart: BASE + index * MINUTE,
    open: '90090',
    high: '90120',
    low: '90080',
    close,
    volumeBtc: '2.5',
  }))
  const rawResponse = JSON.stringify({ officialSerial, productId, candles })
  store.appendOfficialCandles({
    productId,
    intervalMs: MINUTE,
    fromMs: BASE,
    toMs: receivedAtMs,
    receivedAtMs,
    rawResponse,
    sha256: createHash('sha256').update(rawResponse, 'utf8').digest('hex'),
    candles,
  })
}

function demoteToSchema3(path: string): void {
  const raw = new DatabaseSync(path)
  raw.exec('DELETE FROM paper_futures_market_migrations WHERE version>=4')
  raw.close()
}

async function start(
  path: string,
  extra: Partial<Parameters<typeof buildLiveGateway>[0]> = {},
) {
  const app = await buildLiveGateway({
    marketDbPath: path,
    pollMs: 20,
    ...extra,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  closers.push(() => app.close())
  const port = (app.server.address() as AddressInfo).port
  return { app, port }
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function connect(port: number): {
  socket: WebSocket
  messages: Array<Record<string, unknown>>
  next: (
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs?: number,
  ) => Promise<Record<string, unknown>>
} {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/stream`, {
    origin: 'http://localhost',
  })
  closers.push(() => socket.close())
  const messages: Array<Record<string, unknown>> = []
  const waiters: Array<() => void> = []
  socket.on('message', (raw) => {
    messages.push(JSON.parse(String(raw)) as Record<string, unknown>)
    for (const waiter of waiters.splice(0)) waiter()
  })
  const next = (
    predicate: (message: Record<string, unknown>) => boolean,
    timeoutMs = 3_000,
  ) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const check = () => {
        const found = messages.find(predicate)
        if (found) return resolve(found)
        if (Date.now() > deadline)
          return reject(
            new Error(`timeout; saw ${messages.map((m) => m.type).join(',')}`),
          )
        waiters.push(check)
        setTimeout(check, 25)
      }
      check()
    })
  return { socket, messages, next }
}

describe('live market gateway', () => {
  it('serves Qwen scores and reports them off when not configured', async () => {
    const path = dbPath()
    const writer = seedWriter(path, 5)
    closers.push(() => writer.close())
    const off = await start(path)
    expect((await off.app.inject('/api/qwen/scores')).json()).toEqual({
      status: 'off',
      reason: 'decisions_not_configured',
    })
    const asked: string[] = []
    const on = await start(path, {
      qwenScores: {
        report: async (product = '') => {
          asked.push(product)
          return product === 'bad'
            ? { status: 'error', reason: 'invalid_product' }
            : { status: 'ok', generated_at: 1, products: [] }
        },
      },
    })
    const ok = await on.app.inject('/api/qwen/scores?product=PF_XBTUSD')
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ status: 'ok', generated_at: 1, products: [] })
    expect(
      (await on.app.inject('/api/qwen/scores?product=bad')).statusCode,
    ).toBe(400)
    expect(asked).toEqual(['PF_XBTUSD', 'bad'])
  })

  it('serves each pinned product its own view, with its own tickers and candles', async () => {
    const path = dbPath()
    const writer = seedWriter(path, 3)
    closers.push(() => writer.close())
    writer.append({
      ...ticker(1, BASE + 3 * MINUTE + 2_000, '2500.5'),
      productId: 'PF_ETHUSD',
      epoch: 1_000_000,
    })
    saveOfficial(writer, [0, 1], '2499', BASE + 100 * MINUTE, 'PF_ETHUSD')
    const { app, port } = await start(path, {
      clock: () => BASE + 3 * MINUTE + 3_000,
    })
    const btc = (await app.inject('/api/terminal/bootstrap')).json() as any
    const eth = (
      await app.inject('/api/terminal/bootstrap?product=PF_ETHUSD')
    ).json() as any
    expect(btc.product_id).toBe('PF_XBTUSD')
    expect(btc.market.latest_quote.last).toBe('90001.5')
    expect(btc.products).toContain('PF_ETHUSD')
    expect(eth).toMatchObject({
      product_id: 'PF_ETHUSD',
      instrument_id: 'kraken-futures:PF_ETHUSD',
    })
    expect(eth.market.latest_quote.last).toBe('2500.5')
    expect(eth.terminal_market.candles.map((c: any) => c.close)).toEqual([
      '2499',
      '2499',
    ])
    const chart = (
      await app.inject('/api/terminal/chart?product=PF_ETHUSD')
    ).json() as any
    expect(chart.product_id).toBe('PF_ETHUSD')
    expect(
      (await app.inject('/api/terminal/bootstrap?product=PF_NOPE')).statusCode,
    ).toBe(400)
    const stream = new WebSocket(
      `ws://127.0.0.1:${port}/api/terminal/stream?product=PF_ETHUSD`,
      { origin: 'http://localhost' },
    )
    closers.push(() => stream.close())
    const snapshot = await new Promise<any>((resolve, reject) => {
      stream.on('open', () =>
        stream.send(
          JSON.stringify({
            schema_version: 1,
            type: 'subscribe',
            run_id: LIVE_RUN_ID,
          }),
        ),
      )
      stream.on('message', (raw) => resolve(JSON.parse(String(raw))))
      stream.on('error', reject)
    })
    expect(snapshot.instrument_id).toBe('kraken-futures:PF_ETHUSD')
    expect(snapshot.data.state.market.latest_quote.last).toBe('2500.5')
  })

  it('bootstraps closed candles written by another connection without writing', async () => {
    const path = dbPath()
    const writer = seedWriter(path, 5)
    closers.push(() => writer.close())
    const before = sha(path)
    const { app } = await start(path, {
      clock: () => BASE + 5 * MINUTE + 2_000,
    })
    const response = await app.inject('/api/terminal/bootstrap')
    expect(response.statusCode).toBe(200)
    const body = response.json() as Record<string, any>
    expect(body).toMatchObject({
      schema_version: 1,
      mode: 'paper_live',
      source: 'kraken-public-live-stream.v1',
      active_run_id: LIVE_RUN_ID,
      engine: { status: 'off' },
    })
    expect(body.terminal_market.schema_version).toBe(
      'futures-terminal-market.v1',
    )
    expect(body.terminal_market.candles).toHaveLength(5)
    expect(body.terminal_market.candles.every((c: any) => c.closed)).toBe(true)
    expect(body.market.status).toBe('live')
    expect(body.market.last_received_at).toBe(BASE + 5 * MINUTE + 1_000)
    expect(body.market.latest_quote).toMatchObject({ last: '90001.5' })
    // Never writes: the main database file is byte-identical afterwards.
    expect(sha(path)).toBe(before)
    // The handle it uses rejects writes outright.
    const probe = new FuturesMarketStore(path, { readOnly: true })
    expect(() =>
      probe.saveCandleRevision({
        id: 'x',
        intervalMs: MINUTE,
        bucketStart: 0,
        revision: 1,
        knownAt: 1,
        isClosed: false,
        coverage: 'c',
        open: '1',
        high: '1',
        low: '1',
        close: '1',
        volumeBtc: '1',
        tradeCount: 1,
        sourceHash: 'a'.repeat(64),
      }),
    ).toThrow(/readonly/i)
    probe.close()
  })

  it('streams a candle revision appended later by the writer', async () => {
    const path = dbPath()
    const writer = seedWriter(path, 3)
    closers.push(() => writer.close())
    const { port } = await start(path, {
      clock: () => BASE + 3 * MINUTE + 2_000,
    })
    const client = connect(port)
    await new Promise((resolve) => client.socket.once('open', resolve))
    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'subscribe',
        run_id: LIVE_RUN_ID,
      }),
    )
    const snapshot = await client.next((m) => m.type === 'snapshot')
    expect((snapshot.data as any).market.candles).toHaveLength(3)
    expect((snapshot.data as any).state.engine.status).toBe('off')
    saveCandle(writer, 3, 1, false, '90042')
    writer.append(ticker(2, BASE + 3 * MINUTE + 3_000, '90042.5'))
    const update = await client.next(
      (m) =>
        m.type === 'market.updated' && (m.data as any).candle !== undefined,
    )
    expect((update.data as any).candle).toMatchObject({
      interval_ms: MINUTE,
      bucket_start_ms: BASE + 3 * MINUTE,
      closed: false,
      close: '90042',
    })
    // The poller may publish the ticker before the candle revision, so the
    // candle is the next event or a later one, never earlier than the snapshot.
    expect(update.seq as number).toBeGreaterThan(snapshot.seq as number)
    const priced = await client.next(
      (m) => m.type === 'market.updated' && (m.data as any).feed === 'ticker',
    )
    expect((priced.data as any).normalized.last).toBe('90042.5')
    expect((priced.data as any).normalized.raw).toBeUndefined()
    // Closing revision arrives as a closed candle.
    saveCandle(writer, 3, 2, true, '90050')
    const closed = await client.next(
      (m) =>
        m.type === 'market.updated' && (m.data as any).candle?.closed === true,
    )
    expect((closed.data as any).candle.close).toBe('90050')
  })

  describe('history from official candles', () => {
    /** Official 0..19; observed closed 17..21 (17-19 overlap, 20-21 newer). */
    function seedOfficialHistory(path: string) {
      const writer = new FuturesMarketStore(path)
      saveOfficial(
        writer,
        Array.from({ length: 20 }, (_, index) => index),
      )
      for (let index = 17; index <= 21; index += 1)
        saveCandle(writer, index, 1, true, '90000')
      writer.append(ticker(1, BASE + 22 * MINUTE + 1_000))
      return writer
    }
    const clock = () => BASE + 22 * MINUTE + 2_000

    it('serves official candles for every bucket that has one and observed ones only after them', async () => {
      const path = dbPath()
      const writer = seedOfficialHistory(path)
      closers.push(() => writer.close())
      const { app } = await start(path, { clock })
      const body = (await app.inject('/api/terminal/bootstrap')).json() as any
      const candles = body.terminal_market.candles as any[]
      expect(candles.map((c) => c.time_ms)).toEqual(
        Array.from({ length: 22 }, (_, index) => BASE + index * MINUTE),
      )
      expect(candles.every((c) => c.closed === true)).toBe(true)
      // official wins, including the overlap with observed buckets 17-19
      expect(candles.slice(0, 20).map((c) => c.close)).toEqual(
        Array(20).fill('90100'),
      )
      expect(candles.slice(20).map((c) => c.close)).toEqual(['90000', '90000'])
      expect(body.terminal_market.as_of_ms).toBe(BASE + 22 * MINUTE)
    })

    it('has no duplicate buckets and honors the 500 limit, newest kept', async () => {
      const path = dbPath()
      const writer = new FuturesMarketStore(path)
      saveOfficial(
        writer,
        Array.from({ length: 600 }, (_, index) => index),
      )
      saveCandle(writer, 599, 1, true, '90000')
      saveCandle(writer, 600, 1, true, '90000')
      writer.append(ticker(1, BASE + 601 * MINUTE + 1_000))
      closers.push(() => writer.close())
      const { app } = await start(path, {
        clock: () => BASE + 601 * MINUTE + 2_000,
      })
      const body = (await app.inject('/api/terminal/bootstrap')).json() as any
      const times = body.terminal_market.candles.map((c: any) => c.time_ms)
      expect(times).toHaveLength(500)
      expect(new Set(times).size).toBe(500)
      expect(times).toEqual([...times].sort((a, b) => a - b))
      expect(times.at(-1)).toBe(BASE + 600 * MINUTE)
      expect(times[0]).toBe(BASE + 101 * MINUTE)
    })

    it('keeps the forming candle after the official history', async () => {
      const path = dbPath()
      const writer = seedOfficialHistory(path)
      closers.push(() => writer.close())
      saveCandle(writer, 22, 1, false, '90042')
      const { app } = await start(path, { clock })
      const body = (await app.inject('/api/terminal/bootstrap')).json() as any
      const last = body.terminal_market.candles.at(-1)
      expect(last).toMatchObject({
        time_ms: BASE + 22 * MINUTE,
        closed: false,
        close: '90042',
      })
      expect(body.terminal_market.candles.slice(0, 20)[0].close).toBe('90100')
    })

    it('falls back to observed candles on a schema-3 database', async () => {
      const path = dbPath()
      const writer = seedOfficialHistory(path)
      writer.close()
      demoteToSchema3(path)
      const { app } = await start(path, { clock })
      const body = (await app.inject('/api/terminal/bootstrap')).json() as any
      const candles = body.terminal_market.candles as any[]
      expect(candles).toHaveLength(5)
      expect(candles.every((c) => c.close === '90000')).toBe(true)
    })

    it('serves observed candles when no official candle exists yet', async () => {
      const path = dbPath()
      const writer = seedWriter(path, 4)
      closers.push(() => writer.close())
      const { app } = await start(path, {
        clock: () => BASE + 4 * MINUTE + 2_000,
      })
      const body = (await app.inject('/api/terminal/bootstrap')).json() as any
      expect(body.terminal_market.candles).toHaveLength(4)
    })

    it('streams a late official candle as a closed update and ignores observed revisions of that bucket afterwards', async () => {
      const path = dbPath()
      const writer = seedOfficialHistory(path)
      closers.push(() => writer.close())
      const { port } = await start(path, { clock })
      const client = connect(port)
      await new Promise((resolve) => client.socket.once('open', resolve))
      client.socket.send(
        JSON.stringify({
          schema_version: 1,
          type: 'subscribe',
          run_id: LIVE_RUN_ID,
        }),
      )
      await client.next((m) => m.type === 'snapshot')
      saveOfficial(writer, [20], '90111')
      const official = await client.next(
        (m) =>
          m.type === 'market.updated' &&
          (m.data as any).candle?.bucket_start_ms === BASE + 20 * MINUTE,
      )
      expect((official.data as any).candle).toMatchObject({
        interval_ms: MINUTE,
        closed: true,
        close: '90111',
        open: '90090',
        volume_btc: '2.5',
      })
      expect((official.data as any).candle.known_at_ms).toBeGreaterThanOrEqual(
        BASE + 21 * MINUTE,
      )
      // A later observed revision of bucket 20 must not overwrite it.
      saveCandle(writer, 20, 2, true, '95000')
      saveCandle(writer, 22, 1, false, '90042')
      await client.next(
        (m) =>
          m.type === 'market.updated' &&
          (m.data as any).candle?.bucket_start_ms === BASE + 22 * MINUTE,
      )
      const bucket20 = client.messages.filter(
        (m) =>
          m.type === 'market.updated' &&
          (m.data as any).candle?.bucket_start_ms === BASE + 20 * MINUTE,
      )
      expect(bucket20.map((m) => (m.data as any).candle.close)).toEqual([
        '90111',
      ])
    })
    it('serves and streams PF_XBTUSD official candles only, whatever other products share the database', async () => {
      const path = dbPath()
      const writer = seedOfficialHistory(path)
      closers.push(() => writer.close())
      // Another product already in the file at start: same buckets, other prices.
      saveOfficial(
        writer,
        Array.from({ length: 22 }, (_, index) => index),
        '1234',
        BASE + 100 * MINUTE,
        'PF_ETHUSD',
      )
      const { app, port } = await start(path, { clock })
      const body = (await app.inject('/api/terminal/bootstrap')).json() as any
      const candles = body.terminal_market.candles as any[]
      expect(candles).toHaveLength(22)
      expect(candles.slice(0, 20).map((c) => c.close)).toEqual(
        Array(20).fill('90100'),
      )
      expect(candles.some((c) => c.close === '1234')).toBe(false)

      const client = connect(port)
      await new Promise((resolve) => client.socket.once('open', resolve))
      client.socket.send(
        JSON.stringify({
          schema_version: 1,
          type: 'subscribe',
          run_id: LIVE_RUN_ID,
        }),
      )
      await client.next((m) => m.type === 'snapshot')
      // A new ETH candle, then a BTC one: only the BTC one may be streamed.
      saveOfficial(writer, [20], '1235', BASE + 101 * MINUTE, 'PF_ETHUSD')
      saveOfficial(writer, [20], '90111', BASE + 102 * MINUTE)
      await client.next(
        (m) =>
          m.type === 'market.updated' &&
          (m.data as any).candle?.bucket_start_ms === BASE + 20 * MINUTE,
      )
      const closes = client.messages
        .filter(
          (m) =>
            m.type === 'market.updated' &&
            (m.data as any).candle?.bucket_start_ms === BASE + 20 * MINUTE,
        )
        .map((m) => (m.data as any).candle.close)
      expect(closes).toEqual(['90111'])
    })
  })

  it('reports capture as stale but still serves stored history', async () => {
    const path = dbPath()
    const writer = seedWriter(path, 4)
    closers.push(() => writer.close())
    const { app } = await start(path, {
      staleAfterMs: 10_000,
      clock: () => BASE + 4 * MINUTE + 1_000 + 60_000,
    })
    const body = (await app.inject('/api/terminal/bootstrap')).json() as any
    expect(body.market.status).toBe('stale')
    expect(body.market.reason).toBe('capture_stale')
    expect(body.terminal_market.candles).toHaveLength(4)
    expect(body.engine.status).toBe('off')
  })

  it('starts before capture exists and picks the database up later', async () => {
    const path = dbPath()
    const { app } = await start(path, { clock: () => BASE + 2 * MINUTE })
    const empty = (await app.inject('/api/terminal/bootstrap')).json() as any
    expect(empty.market.status).toBe('unavailable')
    expect(empty.terminal_market.candles).toEqual([])
    const writer = seedWriter(path, 2)
    closers.push(() => writer.close())
    const later = (await app.inject('/api/terminal/bootstrap')).json() as any
    expect(later.terminal_market.candles).toHaveLength(2)
  })

  it('rejects paper commands and foreign origins', async () => {
    const path = dbPath()
    const writer = seedWriter(path, 1)
    closers.push(() => writer.close())
    const { port } = await start(path)
    const client = connect(port)
    await new Promise((resolve) => client.socket.once('open', resolve))
    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        run_id: LIVE_RUN_ID,
        command_id: 'c1',
        expected_state_version: 0,
        action: 'paper.start',
      }),
    )
    const rejected = await client.next((m) => m.type === 'protocol.error')
    expect((rejected.data as any).code).toBe('engine_off')
    const evil = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/stream`, {
      origin: 'https://evil.example',
    })
    const failure = await new Promise<string>((resolve) =>
      evil.once('error', (error) => resolve(error.message)),
    )
    expect(failure).toMatch(/403/)
  })
})
