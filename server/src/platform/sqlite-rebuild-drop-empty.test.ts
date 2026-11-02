import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { LEGACY_EMPTY_TABLES, rebuildDatabase } from './sqlite-rebuild.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function source(): { src: string; dest: string } {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-rebuild-'))
  dirs.push(dir)
  const src = join(dir, 'a.sqlite')
  const db = new DatabaseSync(src)
  db.exec(`
    CREATE TABLE paper_futures_market_events (event_id TEXT PRIMARY KEY, n INTEGER);
    INSERT INTO paper_futures_market_events VALUES ('e1', 1), ('e2', 2);
    CREATE TABLE paper_futures_ticker_snapshots (
      event_id TEXT PRIMARY KEY REFERENCES paper_futures_market_events(event_id), payload TEXT);
    CREATE INDEX ticker_snapshots_payload ON paper_futures_ticker_snapshots(payload);
    CREATE TRIGGER ticker_snapshots_no_delete BEFORE DELETE ON paper_futures_ticker_snapshots
      BEGIN SELECT RAISE(ABORT, 'immutable'); END;
    CREATE TABLE paper_futures_book_snapshots (event_id TEXT PRIMARY KEY);
    CREATE TABLE child (id INTEGER PRIMARY KEY, ref TEXT REFERENCES paper_futures_book_snapshots(event_id));
  `)
  db.close()
  return { src, dest: join(dir, 'b.sqlite') }
}
const names = (path: string): string[] => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return (
      db.prepare('SELECT name FROM sqlite_master ORDER BY name').all() as {
        name: string
      }[]
    ).map((r) => r.name)
  } finally {
    db.close()
  }
}

describe('rebuildDatabase dropEmpty', () => {
  it('lists only the legacy table nobody writes or reads', () => {
    expect(LEGACY_EMPTY_TABLES).toEqual(['paper_futures_ticker_snapshots'])
  })

  it('leaves out an empty table with its index and trigger and copies the rest', () => {
    const { src, dest } = source()
    const report = rebuildDatabase(src, dest, {
      dropEmpty: ['paper_futures_ticker_snapshots'],
    })
    expect(report.ok).toBe(true)
    expect(
      report.tables.find((t) => t.table === 'paper_futures_ticker_snapshots'),
    ).toMatchObject({ status: 'dropped', rowsCopied: 0 })
    const left = names(dest)
    expect(left).toContain('paper_futures_market_events')
    expect(left).toContain('paper_futures_book_snapshots') // empty but not asked for
    expect(left.filter((n) => n.includes('ticker_snapshots'))).toEqual([])
    const db = new DatabaseSync(dest, { readOnly: true })
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM paper_futures_market_events').get(),
    ).toEqual({ n: 2 })
    db.close()
  })

  it('refuses a table with rows, and creates nothing', () => {
    const { src, dest } = source()
    expect(() =>
      rebuildDatabase(src, dest, {
        dropEmpty: ['paper_futures_market_events'],
      }),
    ).toThrow(/tiene 2 filas/)
    expect(existsSync(dest)).toBe(false)
  })

  it('refuses an empty table another table references', () => {
    const { src, dest } = source()
    expect(() =>
      rebuildDatabase(src, dest, {
        dropEmpty: ['paper_futures_book_snapshots'],
      }),
    ).toThrow(/la referencia la tabla child/)
    expect(existsSync(dest)).toBe(false)
  })

  it('refuses an unknown table but skips a legacy one that is already absent', () => {
    const { src, dest } = source()
    expect(() => rebuildDatabase(src, dest, { dropEmpty: ['nope'] })).toThrow(
      /no existe/,
    )
    const db = new DatabaseSync(src)
    db.exec(
      'DROP TRIGGER ticker_snapshots_no_delete; DROP TABLE paper_futures_ticker_snapshots',
    )
    db.close()
    const report = rebuildDatabase(src, dest, {
      dropEmpty: [...LEGACY_EMPTY_TABLES],
    })
    expect(report.ok).toBe(true)
  })
})
