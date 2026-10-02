import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { FuturesStore } from './futures-store.ts'

const frozenRun = (store: FuturesStore, runId: string, workId: string) => {
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
  store.recordWork({
    workId,
    runId,
    cycleKey: `${workId}:cycle`,
    expectedVersion: 0,
    snapshot: { snapshot_version: 'fixture.v1' },
  })
}

const pythonSnapshot = (
  program = 'ledger=FuturesLedger("2000"); print(json.dumps(ledger.snapshot("1000")))',
) => {
  const root = new URL('../../../../', import.meta.url).pathname
  const output = execFileSync(
    'python3',
    [
      '-c',
      [
        'from balancita_engine.futures_ledger import FuturesLedger',
        'import json',
        program,
      ].join(';'),
    ],
    {
      cwd: root,
      env: { ...process.env, PYTHONPATH: `${root}/python` },
      encoding: 'utf8',
    },
  )
  return JSON.parse(output) as Record<string, unknown>
}

const resultFor = (
  runId: string,
  workId: string,
  result: Record<string, unknown>,
  events: unknown[] = [],
) => ({
  protocol_version: 1,
  run_id: runId,
  work_id: workId,
  applied_state_version: 1,
  result,
  events,
})

const fillEvent = (runId: string, workId: string, id = 'fill-1') => ({
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

describe('isolated paper-futures SQLite store', () => {
  it('replays committed effects exactly once after reopen; rolls back precommit failures', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paper-futures-'))
    const path = join(directory, 'test.sqlite')
    try {
      const store = new FuturesStore(path)
      store.acceptCommand('cmd-1', { action: 'start' })
      expect(() => store.acceptCommand('cmd-1', { action: 'pause' })).toThrow()
      expect(store.persistCommandResult('cmd-1', { state: 'ready' }).type).toBe(
        'command.result',
      )
      expect(() =>
        store.persistCommandResult('missing', { state: 'ready' }),
      ).toThrow()
      frozenRun(store, 'run-1', 'work-1')
      expect(() =>
        store.createRun({
          runId: 'run-1',
          config: {
            ledger_version: 'linear-usd-ledger.v1',
            decimal_precision: 50,
            leverage: '0.5',
          },
          seed: { cash_usd: '2000' },
          instrument: { instrument_id: 'kraken-futures:PF_XBTUSD' },
          costs: {
            version: 'kraken-futures-eea-btcusd-base.v1',
            maker: '0.0002',
            taker: '0.0005',
          },
        }),
      ).toThrow()
      expect(() =>
        store.recordWork({
          workId: 'work-1',
          runId: 'run-1',
          cycleKey: 'cycle-1',
          expectedVersion: 0,
          snapshot: { snapshot_version: 'different.v1' },
        }),
      ).toThrow()
      const result = resultFor('run-1', 'work-1', pythonSnapshot(), [
        fillEvent('run-1', 'work-1'),
      ])
      expect(() => store.applyResult(result, 'before-commit')).toThrow(
        'Injected pre-commit failure.',
      )
      expect(store.exportRun('run-1').events).toEqual([])
      const receipt = store.applyResult(result)
      expect(receipt.status).toBe('committed')
      expect(store.applyResult(result)).toEqual(receipt)
      expect(() =>
        store.applyResult({
          ...result,
          result: pythonSnapshot(
            'ledger=FuturesLedger("2000"); print(json.dumps(ledger.snapshot("999")))',
          ),
        }),
      ).toThrow('Applied work result conflicts with stored result.')
      store.close()
      const reopened = new FuturesStore(path)
      expect(reopened.exportRun('run-1').receipt).toEqual(receipt)
      expect(reopened.exportRun('run-1').events).toHaveLength(1)
      expect(reopened.verifyRun('run-1')).toBe(true)
      reopened.recordWork({
        workId: 'stale-work',
        runId: 'run-1',
        cycleKey: 'cycle-2',
        expectedVersion: 0,
        snapshot: { snapshot_version: 'fixture.v1' },
      })
      const stale = resultFor('run-1', 'stale-work', pythonSnapshot())
      const superseded = reopened.applyResult(stale)
      expect(superseded.status).toBe('superseded')
      expect(reopened.applyResult(stale)).toEqual(superseded)
      expect(reopened.exportRun('run-1').events).toHaveLength(1)
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('persists a real offline Decimal-ledger result, reopens, exports, and verifies hashes', () => {
    const root = new URL('../../../../', import.meta.url).pathname
    const output = execFileSync(
      'python3',
      [
        '-c',
        [
          'from balancita_engine.futures_ledger import FuturesLedger',
          'import json',
          'l=FuturesLedger("2000"); l.open("long","1","1428.5714285714285714285714285714285714285714285714","maker"); l.close("1","1438.5714285714285714285714285714285714285714285714","taker")',
          'print(json.dumps(l.snapshot("1438.5714285714285714285714285714285714285714285714")))',
        ].join(';'),
      ],
      {
        cwd: root,
        env: { ...process.env, PYTHONPATH: `${root}/python` },
        encoding: 'utf8',
      },
    )
    const ledger = JSON.parse(output) as { realized_net_complete: string }
    expect(ledger.realized_net_complete).toBe('8.995')
    const directory = mkdtempSync(join(tmpdir(), 'paper-futures-ledger-'))
    const path = join(directory, 'isolated.sqlite')
    try {
      const store = new FuturesStore(path)
      frozenRun(store, 'ledger-run', 'ledger-work')
      const result = resultFor('ledger-run', 'ledger-work', ledger, [
        fillEvent('ledger-run', 'ledger-work', 'ledger-fill'),
      ])
      expect(() => store.applyResult(result, 'before-commit')).toThrow(
        'Injected pre-commit failure.',
      )
      expect(store.exportRun('ledger-run').events).toEqual([])
      const receipt = store.applyResult(result)
      store.close()
      const reopened = new FuturesStore(path)
      expect(reopened.applyResult(result)).toEqual(receipt)
      expect(reopened.exportRun('ledger-run').events).toHaveLength(1)
      expect(reopened.verifyRun('ledger-run')).toBe(true)
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('adds only namespaced schema and preserves disposable legacy rows and migration version', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paper-futures-legacy-'))
    const path = join(directory, 'legacy-fixture.sqlite')
    try {
      const fixture = new DatabaseSync(path)
      fixture.exec(
        "CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO schema_migrations VALUES(10,123); CREATE TABLE market_observations(id TEXT PRIMARY KEY, payload TEXT NOT NULL); INSERT INTO market_observations VALUES('legacy','unchanged');",
      )
      fixture.close()
      const store = new FuturesStore(path)
      store.close()
      const check = new DatabaseSync(path)
      expect(
        check.prepare('SELECT version,applied_at FROM schema_migrations').get(),
      ).toEqual({ version: 10, applied_at: 123 })
      expect(
        check.prepare('SELECT id,payload FROM market_observations').get(),
      ).toEqual({ id: 'legacy', payload: 'unchanged' })
      expect(
        check
          .prepare(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'paper_futures_%'",
          )
          .get(),
      ).toEqual({ count: 12 })
      check.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects unversioned, malformed, and semantically invalid financial results before effects', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paper-futures-invalid-'))
    try {
      const store = new FuturesStore(join(directory, 'invalid.sqlite'))
      frozenRun(store, 'invalid-run', 'invalid-work')
      const valid = pythonSnapshot()
      const invalid = [
        { ...valid, amount: null },
        { ...valid, side: 'sideways' },
        { ...valid, amount: '-999' },
        { ...valid, fees_usd: '-1' },
        { ...valid, quantity_btc: '-1' },
        { ...valid, realized_gross_usd: -999 },
        { ...valid, net_complete: null },
        { ...valid, unknown_authoritative_field: 'unexpected' },
      ]
      for (const result of invalid)
        expect(() =>
          store.applyResult(resultFor('invalid-run', 'invalid-work', result)),
        ).toThrow()
      expect(store.exportRun('invalid-run').events).toEqual([])
      const database = (store as unknown as { db: DatabaseSync }).db
      expect(
        database
          .prepare(
            'SELECT state_version FROM paper_futures_runs WHERE run_id=?',
          )
          .get('invalid-run'),
      ).toEqual({ state_version: 0 })
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts actual Decimal output with negative gross PnL and signed funding', () => {
    const snapshot = pythonSnapshot(
      [
        'ledger=FuturesLedger("2000"); ledger.open("long","1","100","maker",at_ms=0)',
        'ledger.observe_funding("actual-1",0,3600000,"0.5")',
        'ledger.accrue_funding(0,3600000)',
        'ledger.close("1","90","taker",at_ms=3600000)',
        'print(json.dumps(ledger.snapshot("90")))',
      ].join(';'),
    )
    expect(snapshot.realized_gross_usd).toBe('-10')
    expect(snapshot.funding_paid).toBe('0.5')
    const directory = mkdtempSync(join(tmpdir(), 'paper-futures-negative-'))
    try {
      const store = new FuturesStore(join(directory, 'negative.sqlite'))
      frozenRun(store, 'negative-run', 'negative-work')
      expect(
        store.applyResult(resultFor('negative-run', 'negative-work', snapshot))
          .status,
      ).toBe('committed')
      expect(store.verifyRun('negative-run')).toBe(true)
      frozenRun(store, 'short-run', 'short-work')
      const shortSnapshot = pythonSnapshot(
        [
          'ledger=FuturesLedger("2000"); ledger.open("short","1","100","maker",at_ms=0)',
          'ledger.observe_funding("actual-short-1",0,3600000,"0.5")',
          'ledger.accrue_funding(0,3600000)',
          'ledger.close("1","110","taker",at_ms=3600000)',
          'print(json.dumps(ledger.snapshot("110")))',
        ].join(';'),
      )
      expect(shortSnapshot.funding_paid).toBe('-0.5')
      expect(
        store.applyResult(resultFor('short-run', 'short-work', shortSnapshot))
          .status,
      ).toBe('committed')
      expect(store.verifyRun('short-run')).toBe(true)
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rejects malformed and misbound versioned events without persisting anything', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paper-futures-events-'))
    try {
      const store = new FuturesStore(join(directory, 'events.sqlite'))
      frozenRun(store, 'event-run', 'event-work')
      const valid = pythonSnapshot()
      const badEvents = [
        [{ ...fillEvent('event-run', 'event-work'), quantity_btc: '-1' }],
        [{ ...fillEvent('other-run', 'event-work') }],
        [{ ...fillEvent('event-run', 'other-work') }],
        [{ ...fillEvent('event-run', 'event-work'), event_version: 2 }],
        [{ ...fillEvent('event-run', 'event-work'), fee_usd: '-0.2' }],
        [{ ...fillEvent('event-run', 'event-work'), side: 'sideways' }],
        [{ id: 'untyped-event', type: 'fill' }],
      ]
      for (const events of badEvents)
        expect(() =>
          store.applyResult(
            resultFor('event-run', 'event-work', valid, events),
          ),
        ).toThrow()
      expect(store.exportRun('event-run').events).toEqual([])
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('creates frozen run and projection atomically and retries after projection failure', () => {
    const directory = mkdtempSync(join(tmpdir(), 'paper-futures-create-'))
    try {
      const store = new FuturesStore(join(directory, 'create.sqlite'))
      const database = (store as unknown as { db: DatabaseSync }).db
      database.exec(
        "CREATE TRIGGER fail_projection BEFORE INSERT ON paper_futures_projections BEGIN SELECT RAISE(ABORT,'projection failure'); END",
      )
      const input = {
        runId: 'atomic-run',
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
      }
      expect(() =>
        store.createRun({
          runId: 'malformed',
          config: {},
          seed: {},
          instrument: {},
          costs: {},
        }),
      ).toThrow()
      expect(() => store.createRun(input)).toThrow('projection failure')
      expect(
        database
          .prepare('SELECT run_id FROM paper_futures_runs WHERE run_id=?')
          .get('atomic-run'),
      ).toBeUndefined()
      database.exec('DROP TRIGGER fail_projection')
      expect(() => store.createRun(input)).not.toThrow()
      expect(() => store.createRun(input)).not.toThrow()
      database.exec(
        "UPDATE paper_futures_projections SET state_json='{}' WHERE run_id='atomic-run'",
      )
      expect(() => store.createRun(input)).toThrow(
        'Existing run projection is inconsistent',
      )
      store.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('verifies the final stored head and immutable frozen/work/event records', () => {
    const tamper = (
      table: string,
      updateSql: string,
      trigger: string,
      runId: string,
    ) => {
      const directory = mkdtempSync(join(tmpdir(), 'paper-futures-verify-'))
      const store = new FuturesStore(join(directory, 'verify.sqlite'))
      frozenRun(store, runId, `${runId}-work`)
      const result = resultFor(runId, `${runId}-work`, pythonSnapshot(), [
        fillEvent(runId, `${runId}-work`, 'fill-verification'),
      ])
      store.applyResult(result)
      expect(store.verifyRun(runId)).toBe(true)
      const database = (store as unknown as { db: DatabaseSync }).db
      database.exec(`DROP TRIGGER ${trigger}; ${updateSql}`)
      expect(store.verifyRun(runId)).toBe(false)
      expect(
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
      ).toBeDefined()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
    const missingRunStore = new FuturesStore(':memory:')
    expect(missingRunStore.verifyRun('missing-run')).toBe(false)
    missingRunStore.close()
    tamper(
      'paper_futures_runs',
      "UPDATE paper_futures_runs SET head_hash=printf('%064d',1) WHERE run_id='tamper-head'",
      'paper_futures_run_frozen',
      'tamper-head',
    )
    tamper(
      'paper_futures_runs',
      "UPDATE paper_futures_runs SET frozen_hash='bad' WHERE run_id='tamper-frozen'",
      'paper_futures_run_frozen',
      'tamper-frozen',
    )
    tamper(
      'paper_futures_work',
      "UPDATE paper_futures_work SET snapshot_hash='bad' WHERE work_id='tamper-work-work'",
      'paper_futures_work_no_update',
      'tamper-work',
    )
    tamper(
      'paper_futures_events',
      "UPDATE paper_futures_events SET payload_json='{}' WHERE event_id='fill-verification'",
      'paper_futures_events_no_update',
      'tamper-event',
    )
    tamper(
      'paper_futures_ledger',
      "UPDATE paper_futures_ledger SET payload_json='{}' WHERE event_id='fill-verification'",
      'paper_futures_ledger_no_update',
      'tamper-ledger',
    )
  })
})
