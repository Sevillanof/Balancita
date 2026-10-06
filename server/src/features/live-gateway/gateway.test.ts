/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON assertions */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'
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
    expect(update.seq as number).toBe((snapshot.seq as number) + 1)
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
