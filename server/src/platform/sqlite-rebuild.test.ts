import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { describeRebuild, rebuildDatabase } from './sqlite-rebuild.ts'
import { quickCheck } from './sqlite-safety.ts'
import {
  damageHeader,
  damageLeaf,
  damageTable,
  makeDb,
} from './sqlite-test-helpers.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'balancita-rebuild-'))
  dirs.push(dir)
  return dir
}
const count = (path: string, table: string): number => {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number })
        .n,
    )
  } finally {
    db.close()
  }
}

describe('database rebuild', () => {
  it('copies a healthy database as it is: rows, rowids, indexes and triggers', () => {
    const dir = tmp()
    const src = join(dir, 'src.sqlite')
    makeDb(src, 300)
    const db = new DatabaseSync(src)
    db.exec(
      "CREATE INDEX good_v ON good(v); CREATE TRIGGER good_no_delete BEFORE DELETE ON good BEGIN SELECT RAISE(ABORT, 'immutable'); END",
    )
    db.exec('DELETE FROM bad WHERE id <= 10') // rowids with a gap
    db.close()
    const report = rebuildDatabase(src, join(dir, 'out.sqlite'))
    expect(report.ok).toBe(true)
    expect(report.tables.map((t) => [t.table, t.status, t.rowsCopied])).toEqual(
      [
        ['good', 'ok', 300],
        ['bad', 'ok', 290],
      ],
    )
    const out = new DatabaseSync(report.dest)
    expect(
      (out.prepare('SELECT MIN(id) AS m FROM bad').get() as { m: number }).m,
    ).toBe(11)
    expect(() => out.exec('DELETE FROM good')).toThrow(/immutable/)
    out.close()
  })

  it('rebuilds a healthy database from one with a damaged table, discarding only that table', () => {
    const dir = tmp()
    const src = join(dir, 'damaged.sqlite')
    makeDb(src, 500)
    damageTable(src, 'bad')
    expect(quickCheck(src).ok).toBe(false)
    const report = rebuildDatabase(src, join(dir, 'rebuilt.sqlite'))
    const bad = report.tables.find((t) => t.table === 'bad')
    const good = report.tables.find((t) => t.table === 'good')
    expect(good).toMatchObject({ status: 'ok', rowsCopied: 500 })
    expect(bad?.status).toBe('discarded')
    expect(bad?.error).toBeTruthy()
    // The new database is healthy, has the damaged table's schema and none of its rows.
    expect(report.integrity.ok).toBe(true)
    expect(report.ok).toBe(true)
    expect(quickCheck(report.dest).ok).toBe(true)
    expect(count(report.dest, 'good')).toBe(500)
    expect(count(report.dest, 'bad')).toBe(0)
    expect(describeRebuild(report)).toMatch(/DESCARTADA\s+bad/)
    // The damaged copy is untouched.
    expect(quickCheck(src).ok).toBe(false)
  })

  it('keeps the rows read before a failure in the middle of a table only when asked to', () => {
    const dir = tmp()
    const src = join(dir, 'damaged.sqlite')
    makeDb(src, 2_000)
    damageLeaf(src, 'bad')
    const dropped = rebuildDatabase(src, join(dir, 'a.sqlite'))
    expect(dropped.tables.find((t) => t.table === 'bad')).toMatchObject({
      status: 'discarded',
      rowsCopied: 0,
    })
    expect(count(dropped.dest, 'bad')).toBe(0)
    expect(count(dropped.dest, 'good')).toBe(2_000)
    const kept = rebuildDatabase(src, join(dir, 'b.sqlite'), {
      keepPartial: true,
    })
    const bad = kept.tables.find((t) => t.table === 'bad')
    expect(bad?.status).toBe('partial')
    expect(bad?.rowsCopied).toBeGreaterThan(0)
    expect(bad?.rowsCopied).toBeLessThan(2_000)
    expect(count(kept.dest, 'bad')).toBe(bad?.rowsCopied)
    expect(kept.integrity.ok).toBe(true)
    expect(kept.ok).toBe(false) // a partial table needs a human look
  })

  it('refuses to overwrite a file and fails clearly when the schema itself is unreadable', () => {
    const dir = tmp()
    const src = join(dir, 'src.sqlite')
    makeDb(src, 10)
    const first = join(dir, 'out.sqlite')
    rebuildDatabase(src, first)
    expect(() => rebuildDatabase(src, first)).toThrow(/ya existe/)
    expect(() =>
      rebuildDatabase(join(dir, 'nope.sqlite'), join(dir, 'x.sqlite')),
    ).toThrow(/No existe/)
    damageHeader(src)
    expect(() => rebuildDatabase(src, join(dir, 'y.sqlite'))).toThrow(
      /Restaurá una copia buena/,
    )
    expect(existsSync(join(dir, 'y.sqlite'))).toBe(false) // nothing left behind
  })
})
