import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const canonicalCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('./futures-canonical.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./futures-canonical.ts')>()
  return {
    ...original,
    canonicalJson: (value: unknown) => {
      canonicalCalls.count += 1
      return original.canonicalJson(value)
    },
    canonicalHash: (value: unknown) => {
      canonicalCalls.count += 1
      return original.canonicalHash(value)
    },
  }
})

import { FuturesStore } from './futures-store.ts'

const root = new URL('../../../../', import.meta.url).pathname
const snapshot = JSON.parse(
  execFileSync(
    'python3',
    [
      '-c',
      'from balancita_engine.futures_ledger import FuturesLedger;import json;print(json.dumps(FuturesLedger("2000").snapshot("1000")))',
    ],
    {
      cwd: root,
      env: { ...process.env, PYTHONPATH: `${root}/python` },
      encoding: 'utf8',
    },
  ),
) as Record<string, unknown>

const fill = (runId: string, workId: string, id: string) => ({
  event_version: 1,
  id,
  fill_id: id,
  run_id: runId,
  work_id: workId,
  type: 'fill',
  instrument_id: 'kraken-futures:PF_XBTUSD',
  side: 'long',
  quantity_btc: '1',
  price_usd_per_btc: '1000',
  fee_usd: '0.2',
  liquidity: 'maker',
  cost_version: 'kraken-futures-eea-btcusd-base.v1',
})

const appendWork = (store: FuturesStore, runId: string, index: number) => {
  const workId = `${runId}-work-${index}`
  store.recordWork({
    workId,
    runId,
    cycleKey: `${workId}:cycle`,
    expectedVersion: index,
    snapshot: { snapshot_version: 'fixture.v1', index },
  })
  store.applyResult({
    protocol_version: 1,
    run_id: runId,
    work_id: workId,
    applied_state_version: index + 1,
    result: snapshot,
    events: [fill(runId, workId, `fill-${runId}-${index}`)],
  } as never)
}

const seededStore = (runId: string, works: number) => {
  const store = new FuturesStore(':memory:')
  store.createRun({
    runId,
    config: {
      ledger_version: 'linear-usd-ledger.v1',
      decimal_precision: 50,
      leverage: '1',
    },
    seed: { cash_usd: '2000' },
    instrument: { instrument_id: 'kraken-futures:PF_XBTUSD' },
    costs: {
      version: 'kraken-futures-eea-btcusd-base.v1',
      maker: '0.0002',
      taker: '0.0005',
    },
  })
  for (let index = 0; index < works; index += 1)
    appendWork(store, runId, index)
  return store
}

const rawDb = (store: FuturesStore) =>
  (store as unknown as { db: DatabaseSync }).db

describe('BP-03c immutable run history', () => {
  beforeEach(() => {
    canonicalCalls.count = 0
  })

  it.each([
    ['paper_futures_runs', 'frozen_json', "'{}'"],
    ['paper_futures_work', 'snapshot_hash', "'bad'"],
    ['paper_futures_records', 'payload_hash', "'bad'"],
    ['paper_futures_applied', 'result_hash', "'bad'"],
    ['paper_futures_events', 'payload_json', "'{}'"],
    ['paper_futures_ledger', 'payload_json', "'{}'"],
    ['paper_futures_fill_ids', 'work_id', "'other'"],
    ['paper_futures_outbox', 'payload_json', "'{}'"],
  ])('rejects UPDATE on %s', (table, column, value) => {
    const store = seededStore('imm-update', 1)
    expect(() =>
      rawDb(store).exec(`UPDATE ${table} SET ${column}=${value}`),
    ).toThrow()
    store.close()
  })

  it.each([
    'paper_futures_work',
    'paper_futures_records',
    'paper_futures_applied',
    'paper_futures_events',
    'paper_futures_ledger',
    'paper_futures_fill_ids',
    'paper_futures_outbox',
  ])('rejects DELETE on %s', (table) => {
    const store = seededStore('imm-delete', 1)
    expect(() => rawDb(store).exec(`DELETE FROM ${table}`)).toThrow(
      /append-only|immutable/,
    )
    store.close()
  })

  it('detects out-of-band tampering of an old row at full verification', () => {
    const store = seededStore('imm-oob', 3)
    expect(store.verifyRun('imm-oob')).toBe(true)
    const db = rawDb(store)
    db.exec('DROP TRIGGER paper_futures_records_no_update')
    db.exec(
      "UPDATE paper_futures_records SET payload_hash='bad' WHERE seq=(SELECT MIN(seq) FROM paper_futures_records)",
    )
    expect(store.verifyRun('imm-oob')).toBe(false)
    store.close()
  })

  it('incremental verification rejects a corrupted newly appended link', () => {
    const store = seededStore('imm-inc', 3)
    expect(store.getRunProjection('imm-inc')).toBeDefined()
    appendWork(store, 'imm-inc', 3)
    const db = rawDb(store)
    db.exec('DROP TRIGGER paper_futures_records_no_update')
    db.exec(
      "UPDATE paper_futures_records SET previous_hash=printf('%064d',7) WHERE seq=(SELECT MAX(seq) FROM paper_futures_records)",
    )
    expect(() => store.getRunProjection('imm-inc')).toThrow(/integrity/)
    store.close()
  })

  it('accepts legitimately appended rows incrementally after the boundary', () => {
    const store = seededStore('imm-ok', 2)
    expect(store.getRunProjection('imm-ok')).toBeDefined()
    appendWork(store, 'imm-ok', 2)
    expect(store.getRunProjection('imm-ok')?.state_version).toBe(3)
    expect(store.verifyRun('imm-ok')).toBe(true)
    store.close()
  })

  it('does not re-canonicalise old history on hot projection reads', () => {
    const small = seededStore('imm-cost-small', 20)
    const large = seededStore('imm-cost-large', 120)
    small.getRunProjection('imm-cost-small')
    large.getRunProjection('imm-cost-large')
    const measure = (store: FuturesStore, runId: string) => {
      canonicalCalls.count = 0
      store.getRunProjection(runId)
      return canonicalCalls.count
    }
    const smallCalls = measure(small, 'imm-cost-small')
    const largeCalls = measure(large, 'imm-cost-large')
    expect(largeCalls).toBeLessThan(smallCalls + 10)
    expect(largeCalls).toBeLessThan(40)
    small.close()
    large.close()
  })
})
