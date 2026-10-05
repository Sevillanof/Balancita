import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesStore } from './futures-store.ts'
import {
  FuturesOperativeIdentityStore,
  type FuturesOperativeIdentityUpdate,
} from './futures-operative-state.ts'

const databases: DatabaseSync[] = []
const directories: string[] = []

afterEach(() => {
  for (const database of databases.splice(0)) database.close()
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function fixture(): {
  database: DatabaseSync
  identities: FuturesOperativeIdentityStore
} {
  const database = new DatabaseSync(':memory:')
  databases.push(database)
  database.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE paper_futures_runs(
      run_id TEXT PRIMARY KEY,
      state_version INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE paper_futures_work(
      work_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL
    ) STRICT;
    INSERT INTO paper_futures_runs VALUES('run-a', 0), ('run-b', 0);
    INSERT INTO paper_futures_work VALUES
      ('work-a', 'run-a', 0), ('work-b', 'run-b', 0), ('size-work', 'run-a', 0);
  `)
  return { database, identities: new FuturesOperativeIdentityStore(database) }
}

const orderValue = {
  intent: { order_id: 'o-1', quantity_btc: '0.1' },
  receipt: { event_id: 'run-a:1', order_id: 'o-1', type: 'order_accepted' },
}

describe('FuturesOperativeIdentityStore', () => {
  it('returns null for an indexed absent identity and isolates identical keys by run', () => {
    const { identities } = fixture()

    expect(identities.lookup('run-a', 'order', 'o-1')).toBeNull()
    identities.withTransaction((transaction) =>
      identities.apply(transaction, {
        runId: 'run-a',
        workId: 'work-a',
        expectedStateVersion: 0,
        sourceFrontier: 0,
        confirmedSourceFrontier: 0,
        updates: [
          {
            kind: 'order',
            key: 'o-1',
            value: orderValue,
            provenance: 'run-a:1',
          },
        ],
      }),
    )

    expect(identities.lookup('run-a', 'order', 'o-1')).toEqual(orderValue)
    expect(identities.lookup('run-b', 'order', 'o-1')).toBeNull()
  })

  it('keeps old revisions and detects a changed old payload during full verification', () => {
    const { database, identities } = fixture()
    const updates: FuturesOperativeIdentityUpdate[] = [
      { kind: 'order', key: 'o-1', value: orderValue, provenance: 'run-a:1' },
    ]
    identities.withTransaction((transaction) =>
      identities.apply(transaction, {
        runId: 'run-a',
        workId: 'work-a',
        expectedStateVersion: 0,
        sourceFrontier: 0,
        confirmedSourceFrontier: 0,
        updates,
      }),
    )
    expect(identities.verifyRun('run-a')).toEqual({ records: 1, identities: 1 })

    database.exec('DROP TRIGGER futures_operative_identity_history_no_update')
    database
      .prepare(
        `UPDATE futures_operative_identity_history SET value_json=? WHERE run_id=?`,
      )
      .run('{"tampered":true}', 'run-a')
    expect(() => identities.verifyRun('run-a')).toThrow(/hash|integrity/i)
  })

  it('rolls back a bounded batch as a whole and rejects stale, foreign, and malformed updates', () => {
    const { identities } = fixture()
    const bookKey = '["kraken-futures","PF_XBTUSD","e1","s1","r1"]'
    const valid = {
      kind: 'book_budget',
      key: bookKey,
      value: { asks: { '100001': '0.1' }, bids: { '100000': '0.2' } },
      provenance: 'book_budget:' + bookKey,
    } satisfies FuturesOperativeIdentityUpdate
    const cancel = {
      kind: 'cancel',
      key: 'cancel-1',
      value: [['o-1', 10], []],
      provenance: 'cancel-1',
    } satisfies FuturesOperativeIdentityUpdate

    expect(() =>
      identities.withTransaction((transaction) => {
        identities.apply(transaction, {
          runId: 'run-a',
          workId: 'size-work',
          expectedStateVersion: 0,
          sourceFrontier: 0,
          confirmedSourceFrontier: 0,
          updates: [valid, cancel],
        })
        throw new Error('abort fixture')
      }),
    ).toThrow('abort fixture')
    expect(identities.lookup('run-a', 'book_budget', bookKey)).toBeNull()

    expect(() =>
      identities.withTransaction((transaction) =>
        identities.apply(transaction, {
          runId: 'run-a',
          workId: 'work-a',
          expectedStateVersion: 1,
          sourceFrontier: 0,
          confirmedSourceFrontier: 0,
          updates: [valid],
        }),
      ),
    ).toThrow(/version/i)
    expect(() =>
      identities.withTransaction((transaction) =>
        identities.apply(transaction, {
          runId: 'run-a',
          workId: 'work-b',
          expectedStateVersion: 0,
          sourceFrontier: 0,
          confirmedSourceFrontier: 0,
          updates: [valid],
        }),
      ),
    ).toThrow(/work|run/i)
    expect(() =>
      identities.withTransaction((transaction) =>
        identities.apply(transaction, {
          runId: 'run-a',
          workId: 'work-a',
          expectedStateVersion: 0,
          sourceFrontier: 1,
          confirmedSourceFrontier: 0,
          updates: [valid],
        }),
      ),
    ).toThrow(/ahead of confirmed/i)
    expect(() => identities.lookup('run-a', 'order', '')).toThrow()
    expect(() =>
      identities.withOwnerTransaction(() =>
        identities.lookup('run-a', 'order', 'o-1'),
      ),
    ).toThrow(/transaction/i)
  })

  it('replays an exactly applied work item without another revision and rejects conflicts', () => {
    const { identities } = fixture()
    const input = {
      runId: 'run-a',
      workId: 'work-a',
      expectedStateVersion: 0,
      sourceFrontier: 0,
      confirmedSourceFrontier: 0,
      updates: [
        {
          kind: 'trade',
          key: 'trade-1',
          value: ['1', '0.1', 'buy'],
          provenance: 'trade-1',
        },
      ],
    } satisfies Parameters<FuturesOperativeIdentityStore['apply']>[1]

    const first = identities.withTransaction((transaction) =>
      identities.apply(transaction, input),
    )
    const retry = identities.withTransaction((transaction) =>
      identities.apply(transaction, input),
    )
    expect(retry).toEqual(first)
    expect(identities.verifyRun('run-a')).toEqual({ records: 1, identities: 1 })
    expect(() =>
      identities.withTransaction((transaction) =>
        identities.apply(transaction, {
          ...input,
          confirmedSourceFrontier: 0,
          updates: [{ ...input.updates[0]!, value: ['2', '0.1', 'buy'] }],
        }),
      ),
    ).toThrow(/conflict/i)
  })

  it('stores 80 old operative IDs while exact-key reads return only the requested batch', () => {
    const { database, identities } = fixture()
    const updates: FuturesOperativeIdentityUpdate[] = Array.from(
      { length: 80 },
      (_, index) => ({
        kind: 'order',
        key: `order-${index}`,
        value: {
          intent: { order_id: `order-${index}`, quantity_btc: '0.1' },
          receipt: {
            event_id: `run-a:${index + 1}`,
            order_id: `order-${index}`,
            type: 'order_accepted',
          },
        },
        provenance: `run-a:${index + 1}`,
      }),
    )
    updates.push(
      {
        kind: 'trade_budget',
        key: 'trade-uid-1',
        value: '0.0001',
        provenance: 'trade_budget:trade-uid-1',
      },
      {
        kind: 'order_trade',
        key: '["order-0","trade-uid-1"]',
        value: true,
        provenance: 'order_trade:order-0',
      },
    )
    identities.withTransaction((transaction) =>
      identities.apply(transaction, {
        runId: 'run-a',
        workId: 'work-a',
        expectedStateVersion: 0,
        sourceFrontier: 4,
        confirmedSourceFrontier: 4,
        updates,
      }),
    )

    const values = identities.lookupMany('run-a', 'order', [
      'order-0',
      'order-40',
      'order-79',
    ])
    expect(values.size).toBe(3)
    expect(values.get('order-0')).toEqual(updates[0]!.value)
    expect(Buffer.byteLength(JSON.stringify([...values]), 'utf8')).toBeLessThan(
      1024,
    )
    expect(
      (
        database
          .prepare(
            `EXPLAIN QUERY PLAN SELECT value_json FROM futures_operative_identity_current
           WHERE run_id=? AND kind=? AND identity_key=?`,
          )
          .all('run-a', 'order', 'order-0') as { detail: string }[]
      )[0]!.detail,
    ).toMatch(/PRIMARY KEY|INDEX/i)
    expect(identities.verifyRun('run-a')).toEqual({
      records: 82,
      identities: 82,
    })
    expect(identities.lookup('run-a', 'order', 'order-0')).toEqual(
      updates[0]!.value,
    )
    expect(() => identities.lookup('missing-run', 'order', 'order-0')).toThrow(
      /unknown operative identity run/i,
    )
    expect(() =>
      identities.lookupMany(
        'run-a',
        'order',
        Array.from({ length: 129 }, (_, index) => `order-${index}`),
      ),
    ).toThrow(/at most 128/i)
    const oversized = Array.from({ length: 5 }, (_, index) => ({
      kind: 'order' as const,
      key: `large-${index}`,
      value: {
        intent: { order_id: `large-${index}`, payload: 'x'.repeat(240_000) },
        receipt: { order_id: `large-${index}`, event_id: 'run-a:large' },
      },
      provenance: `run-a:large-${index}`,
    })) satisfies FuturesOperativeIdentityUpdate[]
    expect(() =>
      identities.withTransaction((transaction) =>
        identities.apply(transaction, {
          runId: 'run-a',
          workId: 'size-work',
          expectedStateVersion: 0,
          sourceFrontier: 0,
          confirmedSourceFrontier: 0,
          updates: oversized,
        }),
      ),
    ).toThrow(/byte limit/i)
    expect(identities.verifyRun('run-a')).toEqual({
      records: 82,
      identities: 82,
    })
  })

  it('installs additive identity tables and schema version on writable legacy stores', () => {
    const directory = mkdtempSync(join(tmpdir(), 'futures-identities-'))
    directories.push(directory)
    const path = join(directory, 'legacy.sqlite')
    const store = new FuturesStore(path)
    store.close()
    const database = new DatabaseSync(path)
    databases.push(database)
    const version = database
      .prepare(
        'SELECT MAX(version) AS version FROM paper_futures_schema_migrations',
      )
      .get() as { version: number }
    const table = database
      .prepare(
        `SELECT name FROM sqlite_schema WHERE type='table' AND name='futures_operative_identity_history'`,
      )
      .get() as { name: string } | undefined
    expect(Number(version.version)).toBe(6)
    expect(table?.name).toBe('futures_operative_identity_history')
  })

  it('accepts the six exact Python identity payload shapes and appends mutable revisions', () => {
    const { identities } = fixture()
    const canonicalBookKey = '["kraken-futures","PF_XBTUSD","e1","s1","r1"]'
    expect(() =>
      identities.lookup(
        'run-a',
        'book_budget',
        '［"kraken-futures","PF_XBTUSD","e1","s1","r1"］',
      ),
    ).toThrow()
    const shapeOrderValue = {
      intent: { order_id: 'o-shape', quantity_btc: '0.1' },
      receipt: {
        event_id: 'run-a:1',
        order_id: 'o-shape',
        type: 'order_accepted',
      },
    }
    const updates: FuturesOperativeIdentityUpdate[] = [
      {
        kind: 'order',
        key: 'o-shape',
        value: shapeOrderValue,
        provenance: 'run-a:1',
      },
      {
        kind: 'order',
        key: 'o-shape',
        value: { ...shapeOrderValue, state: 'filled', filled: '0.1' },
        provenance: 'run-a:2',
      },
      {
        kind: 'cancel',
        key: 'cancel-shape',
        value: [['o-shape', 10], [{ event_id: 'run-a:3', type: 'cancelled' }]],
        provenance: 'run-a:3',
      },
      {
        kind: 'trade',
        key: 'trade-shape',
        value: ['100001', '0.2', 'sell'],
        provenance: 'trade-shape',
      },
      {
        kind: 'book_budget',
        key: canonicalBookKey,
        value: { asks: { '100001': '0.2' }, bids: { '100000': '0.3' } },
        provenance: 'book_budget:' + canonicalBookKey,
      },
      {
        kind: 'trade_budget',
        key: 'trade-shape',
        value: '0.1',
        provenance: 'trade_budget:trade-shape',
      },
      {
        kind: 'order_trade',
        key: '["o-shape","trade-shape"]',
        value: true,
        provenance: 'order_trade:["o-shape","trade-shape"]',
      },
    ]
    identities.withTransaction((transaction) =>
      identities.apply(transaction, {
        runId: 'run-a',
        workId: 'work-a',
        expectedStateVersion: 0,
        sourceFrontier: 0,
        confirmedSourceFrontier: 0,
        updates,
      }),
    )
    expect(identities.lookup('run-a', 'order', 'o-shape')).toEqual(
      updates[1]!.value,
    )
    expect(identities.verifyRun('run-a')).toEqual({ records: 7, identities: 6 })
    expect(() =>
      identities.withTransaction((transaction) =>
        identities.apply(transaction, {
          runId: 'run-a',
          workId: 'work-a',
          expectedStateVersion: 0,
          sourceFrontier: 0,
          confirmedSourceFrontier: 0,
          updates: [
            {
              kind: 'cancel',
              key: 'cancel-shape',
              value: [['o-shape', 11], []],
              provenance: 'run-a:3',
            },
          ],
        }),
      ),
    ).toThrow(/conflict/i)
  })
})
