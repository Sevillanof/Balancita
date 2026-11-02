import { closeSync, openSync, writeSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

// Test-only helpers: a multi-page database and a torn-write simulation.

/** A WAL database with two tables (`good`, `bad`) of `rows` rows spread over several pages. */
export function makeDb(path: string, rows = 2_000): void {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA page_size=4096')
  db.exec('CREATE TABLE good(id INTEGER PRIMARY KEY, v TEXT)')
  db.exec('CREATE TABLE bad(id INTEGER PRIMARY KEY, v TEXT)')
  const good = db.prepare('INSERT INTO good(v) VALUES (?)')
  const bad = db.prepare('INSERT INTO bad(v) VALUES (?)')
  db.exec('BEGIN')
  for (let i = 0; i < rows; i += 1) {
    good.run(`g${i}-${'x'.repeat(100)}`)
    bad.run(`b${i}-${'y'.repeat(100)}`)
  }
  db.exec('COMMIT')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  db.close()
}

/** Overwrites the root page of `table` with garbage, like a torn write would. */
export function damageTable(path: string, table: string): void {
  const db = new DatabaseSync(path)
  const row = db
    .prepare('SELECT rootpage FROM sqlite_master WHERE name=?')
    .get(table) as { rootpage: number }
  db.close()
  const fd = openSync(path, 'r+')
  try {
    writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, (row.rootpage - 1) * 4096)
  } finally {
    closeSync(fd)
  }
}

/** Overwrites a leaf page in the middle of `table` (the table's first pages still read fine). */
export function damageLeaf(path: string, table: string): void {
  const db = new DatabaseSync(path)
  const pages = (
    db
      .prepare(
        "SELECT pageno FROM dbstat WHERE name=? AND pagetype='leaf' ORDER BY pageno",
      )
      .all(table) as { pageno: number }[]
  ).map((r) => r.pageno)
  db.close()
  const page = pages[Math.floor(pages.length * 0.6)] as number
  const fd = openSync(path, 'r+')
  try {
    writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, (page - 1) * 4096)
  } finally {
    closeSync(fd)
  }
}

/** Overwrites page 1 (header and schema root): the file no longer opens as a database. */
export function damageHeader(path: string): void {
  const fd = openSync(path, 'r+')
  try {
    writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, 0)
  } finally {
    closeSync(fd)
  }
}
