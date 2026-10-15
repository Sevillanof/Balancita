import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from './futures-market-store.ts'

// python/tests/real_futures_schema.sql is a frozen copy of the schema FuturesMarketStore creates; the Python tests of the
// capture tools plan their statements against it. If the store changes its schema this test fails until the copy is
// regenerated, so those plans are never checked against an old schema (D-212-20).
const dirs: string[] = []
afterEach(() => {
  for (const path of dirs.splice(0))
    rmSync(path, { recursive: true, force: true })
})

describe('frozen schema used by the Python capture tests', () => {
  it('is identical to the schema FuturesMarketStore creates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'balancita-schema-'))
    dirs.push(dir)
    const path = join(dir, 'fixture.sqlite')
    const store = new FuturesMarketStore(path)
    ;(store as unknown as { db: DatabaseSync }).db.exec(
      'PRAGMA wal_checkpoint(TRUNCATE)',
    )
    const db = new DatabaseSync(path, { readOnly: true })
    const created = (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
        )
        .all() as Array<{ sql: string }>
    ).map((row) => `${row.sql.trimEnd()};`)
    db.close()
    const frozen = readFileSync(
      new URL(
        '../../../../python/tests/real_futures_schema.sql',
        import.meta.url,
      ),
      'utf8',
    )
      .split('\n')
      .filter((line) => !line.startsWith('--'))
      .join('\n')
    expect(frozen.trimEnd()).toBe(created.join('\n'))
  })
})
