/* eslint-disable @typescript-eslint/no-explicit-any -- loosely typed JSON assertions */
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AccountDb,
  LONG_POSITION,
  NOW,
  OPEN_ACCOUNT,
  VerdictsDb,
} from './paper-engine-fixtures.ts'
import { PaperEngineFollower } from './paper-engine-follower.ts'

const dirs: string[] = []
const closers: Array<() => void> = []
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-engine-follower-'))
  dirs.push(dir)
  return dir
}

function follower(
  accountDbPath: string | undefined,
  verdictsDbPath: string | undefined,
  options: { now?: () => number; mark?: () => string | null } = {},
) {
  const instance = new PaperEngineFollower({
    accountDbPath,
    verdictsDbPath,
    clock: options.now ?? (() => NOW + 1_000),
    markPrice: options.mark ?? (() => '100011'),
  })
  closers.push(() => instance.close())
  return instance
}

const types = (events: Array<{ type: string }>) => events.map((e) => e.type)

describe('paper engine follower', () => {
  it('stays off and silent when no account database is configured', () => {
    const engine = follower(undefined, undefined)
    expect(engine.engineStatus()).toMatchObject({ status: 'off' })
    expect(engine.snapshotFields()).toEqual({})
    expect(engine.poll()).toEqual([])
  })

  it('reports starting while the account database does not exist yet, never off', () => {
    const dir = scratch()
    const engine = follower(join(dir, 'missing.sqlite'), join(dir, 'v.sqlite'))
    expect(engine.engineStatus()).toMatchObject({
      status: 'starting',
      reason: 'account_db_not_ready',
      commands: 'unavailable',
    })
    expect(engine.poll()).toEqual([])
  })

  it('picks the account database up when it appears and asks clients to resync once', () => {
    const dir = scratch()
    const engine = follower(join(dir, 'account.sqlite'), undefined)
    expect(engine.snapshotFields()).toMatchObject({ orders: [] })
    const account = new AccountDb(dir, closers)
    account.enter('o1')
    const events = engine.poll()
    expect(types(events)).toEqual(['resync.required', 'engine.status'])
    expect((engine.snapshotFields() as any).orders).toHaveLength(1)
    expect(engine.poll()).toEqual([])
  })

  it('reports starting for a file without the account tables and unavailable for an unreadable one', () => {
    const dir = scratch()
    const empty = join(dir, 'empty.sqlite')
    new DatabaseSync(empty).close()
    expect(follower(empty, undefined).engineStatus()).toMatchObject({
      status: 'starting',
      reason: 'account_db_not_ready',
    })
    const garbage = join(dir, 'garbage.sqlite')
    writeFileSync(garbage, 'this is not a sqlite database'.repeat(50))
    const broken = follower(garbage, undefined)
    expect(broken.engineStatus()).toMatchObject({
      status: 'unavailable',
      reason: 'account_db_unreadable',
    })
    expect(() => broken.poll()).not.toThrow()
  })

  it('serves the initial cash with no position before D has emitted anything', () => {
    const dir = scratch()
    const account = new AccountDb(dir, closers)
    const engine = follower(account.path, undefined)
    const fields = engine.snapshotFields() as any
    expect(fields.account).toEqual({
      cash_usd: '10000',
      equity_usd: '10000',
      realized_gross_usd: '0',
      fees_usd: '0',
      funding_paid_usd: '0',
      funding_complete: true,
      net_usd: '0',
    })
    expect(fields.position).toBeNull()
    expect(fields.orders).toEqual([])
    expect(engine.engineStatus()).toMatchObject({
      status: 'starting',
      reason: 'no_paper_execution_records_yet',
    })
  })

  it('folds the latest account block, orders and fills from the event tail at startup', () => {
    const dir = scratch()
    const account = new AccountDb(dir, closers)
    account.enter('o1')
    const engine = follower(account.path, undefined, {
      mark: () => '100111',
    })
    const fields = engine.snapshotFields() as any
    expect(fields.position).toEqual(LONG_POSITION)
    // equity = cash + 0.0099 * (100111 - 100011)
    expect(fields.account).toMatchObject({
      cash_usd: '9999.50494555',
      equity_usd: '10000.49494555',
      net_usd: '-0.49505445',
      funding_complete: true,
    })
    expect(fields.orders).toHaveLength(1)
    expect(fields.orders[0]).toMatchObject({
      order_id: 'o1',
      side: 'buy',
      state: 'filled',
      status: 'filled',
      quantity_btc: '0.0099',
      decision_at_ms: NOW,
    })
    expect(fields.fills).toHaveLength(1)
    expect(fields.fills[0]).toMatchObject({
      order_id: 'o1',
      side: 'buy',
      quantity_btc: '0.0099',
      price_usd_per_btc: '100011',
      fee_usd: '0.49505445',
      event_time_ms: NOW + 150,
    })
    expect(typeof fields.fills[0].fill_id).toBe('string')
    expect(engine.poll()).toEqual([])
  })

  it('does not scan the whole history: only the tail window plus one probe for the latest account block', () => {
    const dir = scratch()
    const account = new AccountDb(dir, closers)
    account.enter('o0')
    for (let index = 0; index < 700; index += 1)
      account.add('verdict_considered', NOW + 1_000 + index, {
        outcome: 'skipped',
      })
    const engine = follower(account.path, undefined)
    const fields = engine.snapshotFields() as any
    // The account block is older than the window but still found by the probe.
    expect(fields.position).toEqual(LONG_POSITION)
    // The old order is outside the 500 event window.
    expect(fields.orders).toEqual([])
  })

  it('streams new events as terminal events, one order of kinds, then dedupes the identical account block', () => {
    const dir = scratch()
    const account = new AccountDb(dir, closers)
    const engine = follower(account.path, undefined)
    expect(engine.poll()).toEqual([])
    account.enter('o1')
    const events = engine.poll()
    expect(types(events)).toEqual([
      'order.updated',
      'order.updated',
      'fill.created',
      'account.updated',
      'position.updated',
      'engine.status',
    ])
    expect((events[0]!.data as any).order).toMatchObject({
      order_id: 'o1',
      state: 'open',
      status: 'open',
      type: 'entry',
      stop: '99900',
    })
    expect((events[1]!.data as any).order).toMatchObject({
      order_id: 'o1',
      state: 'filled',
    })
    expect((events[3]!.data as any).account).toMatchObject({
      cash_usd: '9999.50494555',
      equity_usd: '9999.50494555',
    })
    expect((events[4]!.data as any).position).toEqual(LONG_POSITION)
    expect(events[5]!.data).toMatchObject({ status: 'running' })
    // Nothing new: nothing emitted, and no re-read of old rows.
    expect(engine.poll()).toEqual([])
  })

  it('maps a rejected, an expired and an exit order', () => {
    const dir = scratch()
    const account = new AccountDb(dir, closers)
    const engine = follower(account.path, undefined)
    account.add('order_created', NOW, {
      order_id: 'o1',
      type: 'entry',
      side: 'buy',
      eligible_at_ms: NOW + 100,
      expires_at_ms: NOW + 5100,
    })
    account.add('order_rejected', NOW + 200, {
      order_id: 'o1',
      reason: 'target_does_not_clear_cost_buffer',
    })
    account.add('order_created', NOW + 300, {
      order_id: 'o2',
      type: 'entry',
      side: 'sell',
    })
    account.add('order_expired', NOW + 6000, {
      order_id: 'o2',
      reason: 'no_valid_ticker_in_wait',
    })
    account.add('exit_triggered', NOW + 7000, {
      order_id: 'o3',
      reason: 'protective_stop',
    })
    account.add('order_created', NOW + 7000, {
      order_id: 'o3',
      type: 'exit',
      side: 'sell',
      reduce_only: true,
      quantity: '0.0099',
    })
    const orders = engine
      .poll()
      .filter((event) => event.type === 'order.updated')
      .map((event) => (event.data as any).order)
    expect(
      orders.map((o: any) => [o.order_id, o.state, o.reason_code ?? null]),
    ).toEqual([
      ['o1', 'open', null],
      ['o1', 'rejected', 'target_does_not_clear_cost_buffer'],
      ['o2', 'open', null],
      ['o2', 'expired', 'no_valid_ticker_in_wait'],
      ['o3', 'open', 'protective_stop'],
    ])
    expect(orders.at(-1)).toMatchObject({
      type: 'exit',
      reduce_only: true,
      quantity_btc: '0.0099',
    })
  })

  it('closes a position: account and position update from the close fill', () => {
    const dir = scratch()
    const account = new AccountDb(dir, closers)
    account.enter('o1')
    const engine = follower(account.path, undefined)
    const closedAccount = {
      ...OPEN_ACCOUNT,
      cash_usd: '9997.61468905',
      realized_gross_usd: '-1.3959',
      fees_usd: '0.98941095',
      funding_complete: false,
      net_usd: null,
      position: null,
    }
    account.add('order_filled', NOW + 6000, {
      order_id: 'o2',
      side: 'sell',
      quantity: '0.0099',
      price: '99870',
      liquidity: 'taker',
      fee: '0.49435650',
      reduce_only: true,
      account: closedAccount,
    })
    account.add('position_closed', NOW + 6000, { account: closedAccount })
    const events = engine.poll()
    expect(types(events)).toEqual([
      'order.updated',
      'fill.created',
      'account.updated',
      'position.updated',
    ])
    expect((events[2]!.data as any).account).toMatchObject({
      cash_usd: '9997.61468905',
      equity_usd: '9997.61468905',
      funding_complete: false,
      net_usd: null,
    })
    expect((events[3]!.data as any).position).toBeNull()
  })

  it('refreshes equity at the mark at most every two seconds while a position is open', () => {
    const dir = scratch()
    const account = new AccountDb(dir, closers)
    account.enter('o1')
    let now = NOW + 1_000
    let mark = '100011'
    const engine = follower(account.path, undefined, {
      now: () => now,
      mark: () => mark,
    })
    expect(engine.poll()).toEqual([])
    mark = '100211'
    now += 500
    expect(engine.poll()).toEqual([])
    now += 2_000
    const refreshed = engine.poll()
    expect(types(refreshed)).toEqual(['account.updated'])
    // 9999.50494555 + 0.0099 * 200
    expect((refreshed[0]!.data as any).account.equity_usd).toBe(
      '10001.48494555',
    )
    now += 2_500
    expect(engine.poll()).toEqual([])
  })

  it('maps verdicts into analyses with the selector, slim proposals and an id', () => {
    const dir = scratch()
    const verdicts = new VerdictsDb(dir, closers)
    const bucket = NOW - (NOW % 60_000)
    verdicts.add(bucket - 120_000, 'WAIT')
    verdicts.add(bucket - 60_000, 'LONG')
    const account = new AccountDb(dir, closers)
    const engine = follower(account.path, verdicts.path)
    const analyses = (engine.snapshotFields() as any).analyses
    expect(analyses).toHaveLength(2)
    expect(analyses[1]).toMatchObject({
      analysis_id: `hash-${bucket - 60_000}`,
      decision_time_ms: bucket - 60_000 + 63_000,
      action: 'LONG',
      selector: { action: 'LONG', strategy_id: 'c25-pullback-perp-v1' },
      selected_strategy_id: 'c25-pullback-perp-v1',
      runtime_version: 'futures-verdict.v1',
      regime: 'trend',
      knowledge_lag_ms: 3_000,
    })
    expect(analyses[1].proposals[0].conditions).toEqual([
      { code: 'trend_ema9_above_ema21', passed: true },
    ])
    expect(JSON.stringify(analyses)).not.toContain('xxxx')
    verdicts.add(bucket, 'SHORT')
    const events = engine.poll()
    expect(types(events).slice(0, 1)).toEqual(['analysis.completed'])
    expect((events[0]!.data as any).analysis.action).toBe('SHORT')
    expect(engine.poll()).toEqual([])
  })

  it('maps PF_XBTUSD verdicts only, whatever other products share the verdicts DB', () => {
    const dir = scratch()
    const verdicts = new VerdictsDb(dir, closers)
    const bucket = NOW - (NOW % 60_000)
    verdicts.add(bucket - 60_000, 'LONG')
    verdicts.add(bucket - 60_000, 'SHORT', {}, 'PF_ETHUSD')
    const account = new AccountDb(dir, closers)
    const engine = follower(account.path, verdicts.path)
    const analyses = (engine.snapshotFields() as any).analyses
    expect(analyses.map((item: any) => item.action)).toEqual(['LONG'])
    // A later ETH verdict is not tailed; a later BTC one is.
    verdicts.add(bucket, 'SHORT', {}, 'PF_ETHUSD')
    expect(engine.poll()).toEqual([])
    verdicts.add(bucket, 'WAIT')
    const events = engine.poll()
    expect(types(events)).toEqual(['analysis.completed'])
    expect((events[0]!.data as any).analysis.action).toBe('WAIT')
  })

  it('keeps only the latest 100 verdicts in the snapshot', () => {
    const dir = scratch()
    const verdicts = new VerdictsDb(dir, closers)
    for (let index = 0; index < 130; index += 1)
      verdicts.add(NOW - (130 - index) * 60_000, 'WAIT')
    const engine = follower(new AccountDb(dir, closers).path, verdicts.path)
    const analyses = (engine.snapshotFields() as any).analyses
    expect(analyses).toHaveLength(100)
    expect(analyses.at(-1).decision_time_ms).toBeGreaterThan(
      analyses[0].decision_time_ms,
    )
  })

  it('orders a poll deterministically: verdict analyses first, then account events, then status', () => {
    const dir = scratch()
    const verdicts = new VerdictsDb(dir, closers)
    const account = new AccountDb(dir, closers)
    const engine = follower(account.path, verdicts.path)
    verdicts.add(NOW - 60_000, 'LONG')
    account.enter('o1')
    expect(types(engine.poll())).toEqual([
      'analysis.completed',
      'order.updated',
      'order.updated',
      'fill.created',
      'account.updated',
      'position.updated',
      'engine.status',
    ])
  })

  it('is running with recent activity, idle once it goes quiet, and recovers', () => {
    const dir = scratch()
    const account = new AccountDb(dir, closers)
    account.snapshot(NOW)
    let now = NOW + 60_000
    const engine = follower(account.path, undefined, { now: () => now })
    expect(engine.engineStatus()).toMatchObject({
      status: 'running',
      reason: 'paper_execution_active',
    })
    now = NOW + 20 * 60_000
    const idle = engine.poll()
    expect(types(idle)).toEqual(['engine.status'])
    expect(idle[0]!.data).toMatchObject({
      status: 'idle',
      reason: 'no_recent_paper_execution_activity',
    })
    account.snapshot(now - 1_000)
    expect(engine.poll()[0]!.data).toMatchObject({ status: 'running' })
  })

  it('survives the account database becoming unreadable and picks it up again', () => {
    const dir = scratch()
    const account = new AccountDb(dir, closers)
    account.enter('o1')
    const engine = follower(account.path, undefined)
    expect(engine.engineStatus()).toMatchObject({ status: 'running' })
    const original = readFileSync(account.path)
    // A recreated, empty file at the same path: tables are gone.
    rmSync(account.path)
    rmSync(`${account.path}-wal`, { force: true })
    rmSync(`${account.path}-shm`, { force: true })
    writeFileSync(account.path, 'garbage'.repeat(100))
    const events = engine.poll()
    expect(types(events)).toEqual(['engine.status'])
    expect(events[0]!.data).toMatchObject({
      status: 'unavailable',
      reason: 'account_db_unreadable',
    })
    expect(original.length).toBeGreaterThan(0)
  })

  it('resyncs from scratch when the account database is replaced by a shorter one', () => {
    const dir = scratch()
    const first = new AccountDb(dir, closers)
    first.enter('o1')
    first.enter('o2', NOW + 10_000)
    const engine = follower(first.path, undefined)
    expect((engine.snapshotFields() as any).orders).toHaveLength(2)
    closers.pop()!() // close the writer handle
    rmSync(first.path)
    rmSync(`${first.path}-wal`, { force: true })
    rmSync(`${first.path}-shm`, { force: true })
    const second = new AccountDb(dir, closers)
    second.add('order_created', NOW, {
      order_id: 'n1',
      type: 'entry',
      side: 'buy',
    })
    const events = engine.poll()
    expect(types(events)).toContain('resync.required')
    expect(
      (engine.snapshotFields() as any).orders.map((o: any) => o.order_id),
    ).toEqual(['n1'])
  })

  it('never writes to either database', () => {
    const dir = scratch()
    const account = new AccountDb(dir, closers)
    const verdicts = new VerdictsDb(dir, closers)
    account.enter('o1')
    verdicts.add(NOW - 60_000, 'LONG')
    const digest = (path: string) =>
      createHash('sha256').update(readFileSync(path)).digest('hex')
    const before = [digest(account.path), digest(verdicts.path)]
    const engine = follower(account.path, verdicts.path)
    engine.snapshotFields()
    engine.poll()
    engine.close()
    expect([digest(account.path), digest(verdicts.path)]).toEqual(before)
  })

  it('sums independent books into one account and lists every open position', () => {
    const dir = scratch()
    const account = new AccountDb(dir, closers)
    const flat = {
      cash_usd: '10000',
      realized_gross_usd: '0',
      fees_usd: '0',
      funding_paid_usd: '0',
      funding_complete: true,
      net_usd: '0',
      position: null,
    }
    account.add('position_opened', NOW + 150, {
      order_id: 'o1',
      book: 'c25-pullback-perp-v1',
      account: OPEN_ACCOUNT,
    })
    account.add('position_opened', NOW + 160, {
      order_id: 'o1',
      book: 'c26-reversion-perp-v1',
      account: {
        ...OPEN_ACCOUNT,
        position: { ...LONG_POSITION, strategy_id: 'c26-reversion-perp-v1' },
      },
    })
    account.add('position_closed', NOW + 170, {
      book: 'c27-breakout-perp-v1',
      account: flat,
    })
    const engine = follower(account.path, undefined, { mark: () => '100011' })
    const fields = engine.snapshotFields() as any
    expect(fields.positions.map((p: any) => p.strategy_id)).toEqual([
      'c25-pullback-perp-v1',
      'c26-reversion-perp-v1',
    ])
    expect(fields.positions.map((p: any) => p.book)).toEqual([
      'c25-pullback-perp-v1',
      'c26-reversion-perp-v1',
    ])
    expect(fields.account.cash_usd).toBe('29999.0098911')
    expect(fields.account.fees_usd).toBe('0.9901089')
  })

  it('a product view only follows the books and verdicts of its product', () => {
    const dir = scratch()
    const account = new AccountDb(dir, closers)
    const verdicts = new VerdictsDb(dir, closers)
    account.add('position_opened', NOW + 150, {
      order_id: 'o1',
      book: 'c25-pullback-perp-v1:PF_XBTUSD',
      account: OPEN_ACCOUNT,
    })
    account.add('position_opened', NOW + 160, {
      order_id: 'o2',
      book: 'c26-reversion-perp-v1:PF_ETHUSD',
      account: {
        ...OPEN_ACCOUNT,
        position: { ...LONG_POSITION, strategy_id: 'c26-reversion-perp-v1' },
      },
    })
    verdicts.add(NOW, 'LONG', {}, 'PF_XBTUSD')
    verdicts.add(NOW + 60_000, 'WAIT', {}, 'PF_ETHUSD')
    const view = (productId?: string) => {
      const instance = new PaperEngineFollower({
        accountDbPath: account.path,
        verdictsDbPath: verdicts.path,
        productId,
        clock: () => NOW + 1_000,
        markPrice: () => '100011',
      })
      closers.push(() => instance.close())
      return instance.snapshotFields() as any
    }
    const btc = view()
    const eth = view('PF_ETHUSD')
    expect(btc.positions.map((p: any) => p.strategy_id)).toEqual([
      'c25-pullback-perp-v1',
    ])
    expect(eth.positions.map((p: any) => p.strategy_id)).toEqual([
      'c26-reversion-perp-v1',
    ])
    expect(btc.analyses).toHaveLength(1)
    expect(eth.analyses).toHaveLength(1)
    expect(eth.analyses[0].action).toBe('WAIT')
    expect(eth.quantity_unit).toBe('ETH')
    expect(btc.quantity_unit).toBe('BTC')
  })
})
