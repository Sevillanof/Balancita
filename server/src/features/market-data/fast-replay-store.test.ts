import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { MarketStore } from './market-store.ts'
import type { TimestampMs } from '../../domain/contracts.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('Fast Replay MarketStore migration', () => {
  it('migrates to v7, stores second-based OHLC independently, and appends run history', () => {
    const directory = mkdtempSync(join(tmpdir(), 'balancita-fast-replay-'))
    directories.push(directory)
    const store = new MarketStore({ path: join(directory, 'market.sqlite') })
    expect(store.schemaVersion()).toBe(10)
    expect(
      store.upsertOhlcCandles([
        { timestamp: 60, open: 10, high: 11, low: 9, close: 10, volume: 2 },
      ]),
    ).toBe(1)
    expect(store.listOhlcCandles(60_000, 60_000)).toEqual([
      { timestamp: 60, open: 10, high: 11, low: 9, close: 10, volume: 2 },
    ])
    store.saveFastReplayRun(
      'run-one',
      { strategy_id: 'micro-bollinger-reversion' },
      { netPnlEur: 1 },
      'data-hash',
      'content-hash',
      100 as TimestampMs,
    )
    expect(store.listFastReplayRuns()).toEqual([
      {
        id: 'run-one',
        request: { strategy_id: 'micro-bollinger-reversion' },
        result: { netPnlEur: 1 },
        datasetHash: 'data-hash',
        contentHash: 'content-hash',
        createdAt: 100,
      },
    ])
    const direct = new DatabaseSync(join(directory, 'market.sqlite'))
    expect(() =>
      direct
        .prepare(
          "UPDATE fast_replay_runs SET result_json = '{}' WHERE id = 'run-one'",
        )
        .run(),
    ).toThrow(/append-only/)
    expect(() =>
      direct.prepare("DELETE FROM fast_replay_runs WHERE id = 'run-one'").run(),
    ).toThrow(/append-only/)
    direct.close()
    store.close()
  })

  it('applies the v6-to-v7 migration without rewriting prior database rows', () => {
    const directory = mkdtempSync(join(tmpdir(), 'balancita-v6-upgrade-'))
    directories.push(directory)
    const path = join(directory, 'market.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(
      "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); INSERT INTO schema_migrations VALUES (6, 123); CREATE TABLE legacy_rows (id TEXT PRIMARY KEY); INSERT INTO legacy_rows VALUES ('preserve-me');",
    )
    legacy.close()
    const store = new MarketStore({ path })
    expect(store.schemaVersion()).toBe(10)
    const verify = new DatabaseSync(path)
    expect(verify.prepare('SELECT id FROM legacy_rows').get()).toEqual({
      id: 'preserve-me',
    })
    verify.close()
    store.close()
  })

  it('skips a corrupt JSON run record without failing history retrieval', () => {
    const directory = mkdtempSync(join(tmpdir(), 'balancita-corrupt-fast-run-'))
    directories.push(directory)
    const path = join(directory, 'market.sqlite')
    const store = new MarketStore({ path })
    const direct = new DatabaseSync(path)
    direct
      .prepare(
        `INSERT INTO fast_replay_runs
          (id, request_json, result_json, dataset_hash, content_hash, created_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'broken-json',
        '{}',
        '{}',
        'broken-dataset',
        'broken-content',
        1,
        '{',
      )
    direct.close()

    expect(() => store.listFastReplayRuns()).not.toThrow()
    expect(store.listFastReplayRuns()).toEqual([])
    store.close()
  })
})
