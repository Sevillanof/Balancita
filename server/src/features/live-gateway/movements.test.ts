import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createMovements } from './movements.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), 'movements-'))
  dirs.push(dir)
  const qwen = join(dir, 'qwen-exit.sqlite')
  const kronos = join(dir, 'kronos.sqlite')
  const q = new DatabaseSync(qwen)
  q.exec(`CREATE TABLE qwen_exit_trade(product_id TEXT, entry_bucket_ms INTEGER, payload TEXT);
    CREATE TABLE qwen_exit_decision(product_id TEXT, bucket_ms INTEGER, payload TEXT);
    CREATE TABLE qwen_exit_open(product_id TEXT, payload TEXT);`)
  q.prepare('INSERT INTO qwen_exit_trade VALUES(?,?,?)').run(
    'PF_XBTUSD',
    1000,
    JSON.stringify({
      side: 'LONG',
      entry_bucket_ms: 1000,
      entry_time_ms: 1060,
      entry_price: '100',
      exit_bucket_ms: 5000,
      exit_time_ms: 5060,
      exit_price: '101',
      exit_reason: 'qwen_close',
      quantity: '1',
      notional_usd: '100',
      pnl_usd: 0.8,
      funding_usd: 0.01,
      funding_status: 'complete',
      reason_code: 'pullback@c25',
    }),
  )
  q.prepare('INSERT INTO qwen_exit_decision VALUES(?,?,?)').run(
    'PF_XBTUSD',
    5000,
    JSON.stringify({
      chosen: 'close',
      probabilities: { close: 0.7, hold: 0.3 },
      bucket_start: 5000,
    }),
  )
  q.prepare('INSERT INTO qwen_exit_open VALUES(?,?)').run(
    'PF_ETHUSD',
    JSON.stringify({ side: 'SHORT', entry_bucket_ms: 9000, net_bp: -20 }),
  )
  q.prepare('INSERT INTO qwen_exit_open VALUES(?,?)').run('PF_SOLUSD', 'null')
  q.close()
  const k = new DatabaseSync(kronos)
  k.exec(`CREATE TABLE decision(product_id TEXT, decision_ms INTEGER, mode TEXT, model TEXT, expected_bp REAL, threshold_bp REAL, side TEXT);
    CREATE TABLE trade(product_id TEXT, decision_ms INTEGER, mode TEXT, payload TEXT);`)
  const d = k.prepare('INSERT INTO decision VALUES(?,?,?,?,?,?,?)')
  d.run('PF_XBTUSD', 100, 'forward', 'k', 50, 20, 'SHORT')
  d.run('PF_XBTUSD', 200, 'forward', 'k', 5, 20, null)
  d.run('PF_XBTUSD', 300, 'forward', 'k', 40, 20, 'LONG')
  d.run('PF_XBTUSD', 50, 'backtest', 'k', 40, 20, 'LONG')
  k.prepare('INSERT INTO trade VALUES(?,?,?,?)').run(
    'PF_XBTUSD',
    100,
    'forward',
    JSON.stringify({
      side: 'SHORT',
      entry_time_ms: 100,
      exit_time_ms: 900,
      entry: '200',
      exit: '190',
      net_bp: 40,
      pnl_usd: 0.4,
    }),
  )
  k.close()
  return { qwenExitDbPath: qwen, kronosDbPath: kronos }
}

describe('movements', () => {
  it('lists Qwen movements newest first with decision, fees and open ones', () => {
    const report = createMovements({ ...fixtures(), clock: () => 7 }).report({})
    if (report.status !== 'ok') throw new Error('expected ok')
    expect(report.items.map((m) => [m.status, m.product_id])).toEqual([
      ['open', 'PF_ETHUSD'],
      ['closed', 'PF_XBTUSD'],
    ])
    const closed = report.items[1]!
    expect(closed).toMatchObject({
      net_usd: 0.8,
      net_pct: 0.8,
      fees_usd: 0.1005,
      funding_usd: 0.01,
      open_reason: 'pullback@c25',
      close_reason: 'qwen_close',
      decision: { answer: 'close', probability: 0.7 },
    })
    expect(report.items[0]).toMatchObject({ net_usd: -0.2, entry_price: null })
    expect(report.summary.qwen).toMatchObject({
      operations: 2,
      open: 1,
      closed: 1,
      wins: 1,
      hit_rate: 1,
      net_usd: 0.6,
    })
  })

  it('lists Kronos forecasts as movements and counts the ones that did not trade', () => {
    const report = createMovements({ ...fixtures() }).report({
      source: 'kronos',
    })
    if (report.status !== 'ok') throw new Error('expected ok')
    expect(report.items.map((m) => [m.opened_at_ms, m.status])).toEqual([
      [300, 'open'],
      [100, 'closed'],
    ])
    expect(report.items[1]).toMatchObject({
      fees_usd: 0.1,
      net_pct: 0.4,
      forecast: { expected_bp: 50, threshold_bp: 20 },
    })
    expect(report.summary.kronos).toMatchObject({
      operations: 2,
      open: 1,
      forecasts_without_trade: 1,
    })
  })

  it('filters by product, date and status and paginates', () => {
    const m = createMovements({ ...fixtures() })
    const open = m.report({ source: 'kronos', status: 'open' })
    expect(open.status === 'ok' && open.page.total).toBe(1)
    const page = m.report({ source: 'kronos', limit: '1', offset: '1' })
    expect(
      page.status === 'ok' && page.items.map((i) => i.opened_at_ms),
    ).toEqual([100])
    const none = m.report({
      source: 'qwen',
      product: 'PF_ETHUSD',
      to: '0000005000',
    })
    expect(none.status === 'ok' && none.page.total).toBe(0)
  })

  it('rejects bad parameters and reports missing DBs as off', () => {
    const m = createMovements({})
    expect(m.report({ source: 'x' })).toEqual({
      status: 'error',
      reason: 'invalid_source',
    })
    expect(m.report({ product: 'btc' })).toEqual({
      status: 'error',
      reason: 'invalid_product',
    })
    expect(m.report({ limit: '0' })).toEqual({
      status: 'error',
      reason: 'invalid_limit',
    })
    expect(m.report({ from: 'nope' })).toEqual({
      status: 'error',
      reason: 'invalid_range',
    })
    const off = m.report({})
    expect(off.status === 'ok' && off.sources).toEqual({
      qwen: 'off',
      kronos: 'off',
    })
  })
})
