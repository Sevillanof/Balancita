/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON assertions */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from '../kraken-futures/futures-market-store.ts'
import { buildLiveGateway, LIVE_RUN_ID } from './gateway.ts'
import { AccountDb, NOW, VerdictsDb } from './paper-engine-fixtures.ts'

const dirs: string[] = []
const closers: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const sync = closers as Array<() => void>

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-gateway-engine-'))
  dirs.push(dir)
  return dir
}

function marketDb(dir: string): string {
  const path = join(dir, 'market.sqlite')
  const writer = new FuturesMarketStore(path)
  writer.append({
    type: 'ticker',
    productId: 'PF_XBTUSD',
    seq: 1,
    epoch: 1,
    eventTime: NOW - 1,
    receivedAt: NOW,
    persistedAt: NOW,
    last: '100111',
    mark: '100111',
    suspended: false,
    funding: { status: 'unknown' },
    raw: { feed: 'ticker' },
  })
  closers.push(() => writer.close())
  return path
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

async function start(extra: Parameters<typeof buildLiveGateway>[0]) {
  const app = await buildLiveGateway({
    pollMs: 20,
    clock: () => NOW + 1_000,
    ...extra,
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  closers.push(() => app.close())
  return { app, port: (app.server.address() as AddressInfo).port }
}

function connect(port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/stream`, {
    origin: 'http://localhost',
  })
  closers.push(() => socket.close())
  const messages: Array<Record<string, any>> = []
  socket.on('message', (raw) => messages.push(JSON.parse(String(raw))))
  const opened = new Promise((resolve) => socket.once('open', resolve))
  const until = async (
    predicate: (messages: Array<Record<string, any>>) => boolean,
    timeoutMs = 3_000,
  ) => {
    const deadline = Date.now() + timeoutMs
    while (!predicate(messages)) {
      if (Date.now() > deadline)
        throw new Error(`timeout; saw ${messages.map((m) => m.type).join(',')}`)
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
  }
  const subscribe = async () => {
    await opened
    socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'subscribe',
        run_id: LIVE_RUN_ID,
      }),
    )
    await until((all) => all.some((m) => m.type === 'snapshot'))
  }
  return { socket, messages, until, subscribe, opened }
}

describe('live gateway serving paper execution state', () => {
  it('serves account, position, orders, fills and analyses in the snapshot, read-only', async () => {
    const dir = scratch()
    const market = marketDb(dir)
    const account = new AccountDb(dir, sync)
    const verdicts = new VerdictsDb(dir, sync)
    account.enter('o1')
    verdicts.add(NOW - 120_000, 'WAIT')
    verdicts.add(NOW - 60_000, 'LONG')
    const before = [sha(account.path), sha(verdicts.path)]
    const { app, port } = await start({
      marketDbPath: market,
      accountDbPath: account.path,
      verdictsDbPath: verdicts.path,
    })
    const bootstrap = (
      await app.inject('/api/terminal/bootstrap')
    ).json() as any
    expect(bootstrap.engine).toMatchObject({
      status: 'running',
      commands: 'unavailable',
    })
    const client = connect(port)
    await client.subscribe()
    const snapshot = client.messages.find((m) => m.type === 'snapshot')!
    expect(snapshot.run_id).toBe(LIVE_RUN_ID)
    const state = snapshot.data.state
    expect(state.engine.status).toBe('running')
    expect(state.position).toMatchObject({
      side: 'long',
      quantity_btc: '0.0099',
    })
    // marked to the ticker's 100111 mark: 9999.50494555 + 0.0099 * 100
    expect(state.account.equity_usd).toBe('10000.49494555')
    expect(state.orders).toHaveLength(1)
    expect(state.fills).toHaveLength(1)
    expect(state.analyses.map((a: any) => a.action)).toEqual(['WAIT', 'LONG'])
    expect(snapshot.data.market.candles).toEqual([])
    expect([sha(account.path), sha(verdicts.path)]).toEqual(before)
  })

  it('streams verdicts and D events in contiguous order after the snapshot', async () => {
    const dir = scratch()
    const market = marketDb(dir)
    const account = new AccountDb(dir, sync)
    const verdicts = new VerdictsDb(dir, sync)
    const { port } = await start({
      marketDbPath: market,
      accountDbPath: account.path,
      verdictsDbPath: verdicts.path,
    })
    const client = connect(port)
    await client.subscribe()
    const snapshot = client.messages.find((m) => m.type === 'snapshot')!
    verdicts.add(NOW - 60_000, 'LONG')
    account.enter('o1')
    await client.until((all) => all.some((m) => m.type === 'position.updated'))
    const streamed = client.messages.filter(
      (m) => m.type !== 'snapshot' && m.type !== 'heartbeat',
    )
    const fresh = streamed.filter((m) => m.seq > snapshot.seq)
    expect(fresh.map((m) => m.seq)).toEqual(
      fresh.map((_, index) => snapshot.seq + 1 + index),
    )
    const order = fresh
      .map((m) => m.type)
      .filter((type) => type !== 'market.updated' && type !== 'engine.status')
    expect(order).toEqual([
      'analysis.completed',
      'order.updated',
      'order.updated',
      'fill.created',
      'account.updated',
      'position.updated',
    ])
    expect(new Set(fresh.map((m) => m.run_id))).toEqual(new Set([LIVE_RUN_ID]))
    expect(fresh.find((m) => m.type === 'engine.status')?.data).toMatchObject({
      status: 'running',
    })
  })

  it('reports starting when the account DB is missing and resyncs clients once it appears', async () => {
    const dir = scratch()
    const market = marketDb(dir)
    const accountPath = join(dir, 'account.sqlite')
    const { app, port } = await start({
      marketDbPath: market,
      accountDbPath: accountPath,
      verdictsDbPath: join(dir, 'verdicts.sqlite'),
    })
    const starting = (await app.inject('/api/terminal/bootstrap')).json() as any
    expect(starting.engine).toMatchObject({
      status: 'starting',
      reason: 'account_db_not_ready',
    })
    const client = connect(port)
    await client.subscribe()
    expect(
      client.messages.find((m) => m.type === 'snapshot')!.data.state.orders,
    ).toEqual([])
    const account = new AccountDb(dir, sync)
    account.enter('o1')
    await client.until((all) => all.some((m) => m.type === 'resync.required'))
    const running = (await app.inject('/api/terminal/bootstrap')).json() as any
    expect(running.engine.status).toBe('running')
  })

  it('keeps rejecting paper commands, with a reason that names the missing channel', async () => {
    const dir = scratch()
    const account = new AccountDb(dir, sync)
    account.enter('o1')
    const { port } = await start({
      marketDbPath: marketDb(dir),
      accountDbPath: account.path,
    })
    const client = connect(port)
    await client.subscribe()
    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        run_id: LIVE_RUN_ID,
        command_id: 'c1',
        expected_state_version: 0,
        action: 'paper.close',
      }),
    )
    await client.until((all) => all.some((m) => m.type === 'protocol.error'))
    expect(
      client.messages.find((m) => m.type === 'protocol.error')!.data.code,
    ).toBe('commands_unavailable')
  })

  it('serves the dev supervisor health file under /api/health', async () => {
    const dir = scratch()
    const processHealthPath = join(dir, 'dev-health.json')
    writeFileSync(
      processHealthPath,
      JSON.stringify({
        updated_at_ms: 1,
        processes: { verdict: { status: 'restarting', restarts: 2 } },
      }),
    )
    const { app } = await start({
      marketDbPath: marketDb(dir),
      processHealthPath,
    })
    const health = (await app.inject('/api/health')).json() as any
    expect(health.processes.verdict).toMatchObject({ status: 'restarting' })
    const absent = await start({ marketDbPath: marketDb(scratch()) })
    expect(
      ((await absent.app.inject('/api/health')).json() as any).processes,
    ).toBeNull()
  })

  it('keeps the engine off when no account DB is configured', async () => {
    const dir = scratch()
    const { app } = await start({ marketDbPath: marketDb(dir) })
    const bootstrap = (
      await app.inject('/api/terminal/bootstrap')
    ).json() as any
    expect(bootstrap.engine).toMatchObject({ status: 'off' })
    const health = (await app.inject('/api/health')).json() as any
    expect(health.engine.status).toBe('off')
  })

  it('reports the engine unavailable with python_unavailable when dev found no Python', async () => {
    const dir = scratch()
    const { app, port } = await start({
      marketDbPath: marketDb(dir),
      engineUnavailableReason: 'python_unavailable',
    })
    const expected = {
      status: 'unavailable',
      reason: 'python_unavailable',
      commands: 'unavailable',
    }
    const bootstrap = (
      await app.inject('/api/terminal/bootstrap')
    ).json() as any
    expect(bootstrap.engine).toMatchObject(expected)
    const health = (await app.inject('/api/health')).json() as any
    expect(health.engine).toMatchObject(expected)
    const client = connect(port)
    await client.subscribe()
    const snapshot = client.messages.find((m) => m.type === 'snapshot')!
    expect(snapshot.data.state.engine).toMatchObject(expected)
    expect(snapshot.data.state.analyses).toBeUndefined()
    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        run_id: LIVE_RUN_ID,
        command_id: 'c1',
        expected_state_version: 0,
        action: 'paper.close',
      }),
    )
    await client.until((all) => all.some((m) => m.type === 'protocol.error'))
    expect(
      client.messages.find((m) => m.type === 'protocol.error')!.data.code,
    ).toBe('commands_unavailable')
  })

  it('keeps the distinct python_sqlite_too_old reason', async () => {
    const dir = scratch()
    const { app } = await start({
      marketDbPath: marketDb(dir),
      engineUnavailableReason: 'python_sqlite_too_old',
    })
    const bootstrap = (
      await app.inject('/api/terminal/bootstrap')
    ).json() as any
    expect(bootstrap.engine).toMatchObject({
      status: 'unavailable',
      reason: 'python_sqlite_too_old',
    })
  })
})
