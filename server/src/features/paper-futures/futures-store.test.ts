import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { FuturesStore } from './futures-store.ts'

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
      store.createRun({
        runId: 'run-1',
        config: { leverage: '1' },
        seed: { cash: '1000' },
        instrument: { id: 'btc-perp-v1' },
        costs: { version: 'fees.v1' },
      })
      expect(() =>
        store.createRun({
          runId: 'run-1',
          config: { leverage: '0.5' },
          seed: { cash: '1000' },
          instrument: { id: 'btc-perp-v1' },
          costs: { version: 'fees.v1' },
        }),
      ).toThrow()
      store.recordWork({
        workId: 'work-1',
        runId: 'run-1',
        cycleKey: 'cycle-1',
        expectedVersion: 0,
        snapshot: { price: '100' },
      })
      expect(() =>
        store.recordWork({
          workId: 'work-1',
          runId: 'run-1',
          cycleKey: 'cycle-1',
          expectedVersion: 0,
          snapshot: { price: '101' },
        }),
      ).toThrow()
      const result = {
        protocol_version: 1,
        run_id: 'run-1',
        work_id: 'work-1',
        applied_state_version: 1,
        result: { equity: '1000' },
        events: [{ id: 'fill-1', type: 'fill', amount: '0' }],
      }
      expect(() => store.applyResult(result, 'before-commit')).toThrow(
        'Injected pre-commit failure.',
      )
      expect(store.exportRun('run-1').events).toEqual([])
      const receipt = store.applyResult(result)
      expect(receipt.status).toBe('committed')
      expect(store.applyResult(result)).toEqual(receipt)
      expect(() =>
        store.applyResult({ ...result, result: { equity: '999' } }),
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
        snapshot: {},
      })
      const stale = {
        protocol_version: 1,
        run_id: 'run-1',
        work_id: 'stale-work',
        applied_state_version: 1,
        result: {},
        events: [{ id: 'should-not-apply' }],
      }
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
      store.createRun({
        runId: 'ledger-run',
        config: {},
        seed: {},
        instrument: {},
        costs: {},
      })
      store.recordWork({
        workId: 'ledger-work',
        runId: 'ledger-run',
        cycleKey: 'ledger-cycle',
        expectedVersion: 0,
        snapshot: {},
      })
      const result = {
        protocol_version: 1,
        run_id: 'ledger-run',
        work_id: 'ledger-work',
        applied_state_version: 1,
        result: ledger,
        events: [{ id: 'ledger-close', type: 'fill', amount: '0' }],
      }
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
})
