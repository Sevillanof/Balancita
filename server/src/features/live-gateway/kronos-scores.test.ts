import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createKronosScores, type KronosProduct } from './kronos-scores.ts'

const HOUR = 3_600_000
const T0 = 1_791_446_400_000
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

type Decision = [string, number, string, string | null]
type Trade = [string, number, string, Record<string, unknown>]

/** Same schema as `python/kronos_lab` writes (STRICT, append-only). */
function seed(decisions: Decision[], trades: Trade[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-kronos-'))
  dirs.push(dir)
  const path = join(dir, 'kronos.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE decision(
    product_id TEXT NOT NULL, decision_ms INTEGER NOT NULL, mode TEXT NOT NULL, model TEXT NOT NULL,
    expected_bp REAL NOT NULL, threshold_bp REAL NOT NULL, side TEXT, PRIMARY KEY(product_id, decision_ms)) STRICT;
  CREATE TABLE trade(
    product_id TEXT NOT NULL, decision_ms INTEGER NOT NULL, mode TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(product_id, decision_ms)) STRICT;`)
  const addDecision = db.prepare(
    'INSERT INTO decision VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const [product, ms, mode, side] of decisions)
    addDecision.run(product, ms, mode, 'Kronos-small', 50, 20, side)
  const addTrade = db.prepare('INSERT INTO trade VALUES (?, ?, ?, ?)')
  for (const [product, ms, mode, payload] of trades)
    addTrade.run(product, ms, mode, JSON.stringify(payload))
  db.close()
  return path
}

function closed(
  ms: number,
  side: 'LONG' | 'SHORT',
  entry: string,
  exit: string,
  netBp: number,
): Record<string, unknown> {
  return {
    side,
    entry_time_ms: ms,
    entry_bucket_ms: ms,
    exit_time_ms: ms + 4 * HOUR,
    entry,
    exit,
    net_bp: netBp,
    pnl_usd: netBp / 100,
  }
}

const decisions: Decision[] = [
  ['PF_XBTUSD', T0, 'backtest', 'LONG'],
  ['PF_XBTUSD', T0 + HOUR, 'forward', 'LONG'],
  ['PF_XBTUSD', T0 + 5 * HOUR, 'forward', 'SHORT'],
  ['PF_XBTUSD', T0 + 9 * HOUR, 'forward', null],
  ['PF_XBTUSD', T0 + 10 * HOUR, 'forward', 'LONG'],
  ['PF_ETHUSD', T0 + HOUR, 'forward', 'SHORT'],
]
const trades: Trade[] = [
  ['PF_XBTUSD', T0, 'backtest', closed(T0, 'LONG', '1', '2', 999)],
  [
    'PF_XBTUSD',
    T0 + HOUR,
    'forward',
    closed(T0 + HOUR, 'LONG', '100', '101', 80),
  ],
  [
    'PF_XBTUSD',
    T0 + 5 * HOUR,
    'forward',
    closed(T0 + 5 * HOUR, 'SHORT', '101', '102', -120),
  ],
]

describe('kronos scores', () => {
  it('maps forward decisions and trades of one product to the Qwen shape', async () => {
    const scores = createKronosScores({
      dbPath: seed(decisions, trades),
      clock: () => T0 + 11 * HOUR,
    })
    const result = await scores.report('PF_XBTUSD')
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') return
    expect(result.generated_at).toBe(T0 + 11 * HOUR)
    expect(result.products).toHaveLength(1)
    const product = result.products[0] as KronosProduct
    expect(product.product_id).toBe('PF_XBTUSD')
    expect(product.horizon_min).toBe(240)
    expect(product.decisions).toEqual({
      decisions: 4,
      scored: 2,
      pending: 1,
      hits: 1,
      misses: 1,
      points: 0,
      hit_rate: 0.5,
      mean_net_bp: -20,
      total_net_bp: -40,
    })
    expect(product.by_option.buy).toMatchObject({
      decisions: 2,
      scored: 1,
      pending: 1,
      hits: 1,
      hit_rate: 1,
    })
    expect(product.by_option.sell).toMatchObject({
      decisions: 1,
      scored: 1,
      misses: 1,
      hit_rate: 0,
    })
    expect(product.by_option.hold).toMatchObject({
      decisions: 1,
      scored: 0,
      hit_rate: null,
    })
    expect(product).not.toHaveProperty('baseline')
    expect(product.trading).toEqual({
      trades: 2,
      wins: 1,
      hit_rate: 0.5,
      pnl_usd: -0.4,
      return_pct: -0.4,
      max_drawdown: { pct: -1.1905, at_ms: T0 + 9 * HOUR },
    })
    expect(product.rows).toEqual([])
    expect(product.trades).toEqual([
      {
        side: 'LONG',
        entry_time_ms: T0 + HOUR,
        entry_price: '100',
        exit_time_ms: T0 + 5 * HOUR,
        exit_price: '101',
        exit_reason: 'time_stop',
        net_bp: 80,
        pnl_usd: 0.8,
      },
      expect.objectContaining({ side: 'SHORT', net_bp: -120 }),
    ])
    expect(product.open_position).toEqual({
      side: 'LONG',
      entry_time_ms: T0 + 10 * HOUR,
      entry_price: null,
      mark_price: null,
      net_bp: null,
      pnl_usd: null,
    })
  })

  it('reports no open position once its 4 h horizon passed', async () => {
    const scores = createKronosScores({
      dbPath: seed(decisions, trades),
      clock: () => T0 + 15 * HOUR,
    })
    const result = await scores.report('PF_XBTUSD')
    if (result.status !== 'ok') throw new Error(result.reason)
    expect((result.products[0] as KronosProduct).open_position).toBeNull()
  })

  it('lists every product without a filter and rejects bad products', async () => {
    const scores = createKronosScores({ dbPath: seed(decisions, trades) })
    const all = await scores.report()
    if (all.status !== 'ok') throw new Error(all.reason)
    expect(
      all.products.map((item) => (item as KronosProduct).product_id),
    ).toEqual(['PF_ETHUSD', 'PF_XBTUSD'])
    expect(await scores.report('bad')).toEqual({
      status: 'error',
      reason: 'invalid_product',
    })
  })

  it('reports off when the database does not exist', async () => {
    const scores = createKronosScores({
      dbPath: join(tmpdir(), 'balancita-missing', 'kronos.sqlite'),
    })
    expect(await scores.report('PF_XBTUSD')).toEqual({
      status: 'off',
      reason: 'kronos_db_missing',
    })
  })

  it('reuses a report within the cache window', async () => {
    let now = T0 + 11 * HOUR
    const path = seed(decisions, trades)
    const scores = createKronosScores({ dbPath: path, clock: () => now })
    const first = await scores.report('PF_XBTUSD')
    rmSync(path)
    now += 1_000
    expect(await scores.report('PF_XBTUSD')).toBe(first)
    now += 15_000
    expect((await scores.report('PF_XBTUSD')).status).toBe('off')
  })
})
