import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

/**
 * Helpers that keep SQLite files safe to copy and quick to judge. Nothing here
 * copies a live database "by hand": a copy is always made through SQLite's own
 * backup API on a connection of its own, so it is consistent even while the
 * capture writes to the file (WAL mode).
 */

/** What SQLite says when a page, a freelist or the file header is damaged. */
const MALFORMED =
  /malformed|disk image|not a database|database corruption|SQLITE_CORRUPT|SQLITE_NOTADB|freelist/i

/** True when an error (or a message) means the database file itself is damaged. */
export function isMalformedError(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.message} ${(error as { code?: string }).code ?? ''}`
      : String(error)
  return MALFORMED.test(text)
}

/** Result of `PRAGMA quick_check`: `ok` or the first problems SQLite found. */
export interface CheckResult {
  readonly ok: boolean
  readonly detail: string
}

/** `PRAGMA quick_check(limit)` on a read-only connection; never throws. */
export function quickCheck(path: string, limit = 10): CheckResult {
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA busy_timeout=5000')
    const rows = (
      db
        .prepare(`PRAGMA quick_check(${Math.max(1, Math.trunc(limit))})`)
        .all() as {
        quick_check: string
      }[]
    ).map((row) => row.quick_check)
    return rows.length === 1 && rows[0] === 'ok'
      ? { ok: true, detail: 'quick_check ok' }
      : { ok: false, detail: `quick_check: ${rows.join(' | ').slice(0, 400)}` }
  } catch (error) {
    return {
      ok: false,
      detail: `quick_check: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
    }
  } finally {
    try {
      db?.close()
    } catch {
      // A read-only handle that cannot close changes nothing.
    }
  }
}

/** `20261102-101100` from a date, the stamp in every backup file name. */
export function backupStamp(at: number): string {
  return new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .slice(0, 15)
    .replace('T', '-')
}

const STAMP = /(\d{8})-(\d{6})\.sqlite$/

/** Moment (ms, UTC) a backup file name says it was made, null when it is not one of ours. */
export function backupStampMs(file: string): number | null {
  const match = STAMP.exec(file)
  if (!match) return null
  const [, d, t] = match as unknown as [string, string, string]
  const ms = Date.parse(
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`,
  )
  return Number.isFinite(ms) ? ms : null
}

/** Backup files of `name` in `dir`, oldest first. */
export function listBackups(dir: string, name: string): string[] {
  if (!existsSync(dir)) return []
  const prefix = `${name}-`
  return readdirSync(dir)
    .filter(
      (file) =>
        file.startsWith(prefix) &&
        file.length === prefix.length + '20261102-101100.sqlite'.length &&
        backupStampMs(file) !== null,
    )
    .sort()
}

/** Newest backup moment for `name`, null when there is none. */
export function latestBackupMs(dir: string, name: string): number | null {
  const last = listBackups(dir, name).at(-1)
  return last === undefined ? null : backupStampMs(last)
}

/**
 * One consistent copy of `source` into `target` through SQLite's backup API
 * (pages copied in small steps on its own read connection, so the writer is
 * never blocked for long and the copy is a single point-in-time image).
 */
export async function copyDatabase(
  source: string,
  target: string,
): Promise<void> {
  const db = new DatabaseSync(source, { readOnly: true })
  try {
    db.exec('PRAGMA busy_timeout=5000')
    await backup(db, target, { rate: 256 })
  } finally {
    db.close()
  }
}

/** Makes a copy a single self-contained file (no -wal/-shm companions to lose or leave behind). */
export function settleCopy(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode=DELETE')
  } finally {
    db.close()
  }
}

export interface BackupOutcome {
  readonly ok: boolean
  readonly detail: string
  /** The database being copied failed its own check: nothing was copied. */
  readonly sourceFailed?: boolean
  readonly file?: string
}

/**
 * Daily backup of one database:
 * 1. `quick_check` of the source. If it fails nothing is written and the last
 *    good copy is left exactly as it is (a damaged file never replaces it).
 * 2. Backup API into `<name>-<stamp>.sqlite.tmp`, then `quick_check` of the copy.
 * 3. Only a copy that passed is renamed into place; then the newest `keep`
 *    good copies are kept and older ones removed.
 */
export async function backupDatabase(options: {
  readonly name: string
  readonly dbPath: string
  readonly dir: string
  readonly keep: number
  readonly now?: number
}): Promise<BackupOutcome> {
  const { name, dbPath, dir } = options
  const keep = Math.max(1, Math.trunc(options.keep))
  if (!existsSync(dbPath))
    return {
      ok: false,
      detail: `${name}: la base no existe`,
      sourceFailed: false,
    }
  const source = quickCheck(dbPath)
  if (!source.ok)
    return {
      ok: false,
      sourceFailed: true,
      detail: `${name}: la base falló su chequeo, no se copió (${source.detail}); se conserva la última copia buena`,
    }
  mkdirSync(dir, { recursive: true })
  const final = join(
    dir,
    `${name}-${backupStamp(options.now ?? Date.now())}.sqlite`,
  )
  const temp = `${final}.tmp`
  rmSync(temp, { force: true })
  try {
    await copyDatabase(dbPath, temp)
    settleCopy(temp)
    const copy = quickCheck(temp)
    for (const suffix of ['-wal', '-shm'])
      rmSync(`${temp}${suffix}`, { force: true })
    if (!copy.ok) {
      rmSync(temp, { force: true })
      return {
        ok: false,
        detail: `${name}: la copia falló su chequeo y se descartó (${copy.detail})`,
      }
    }
    renameSync(temp, final)
  } catch (error) {
    rmSync(temp, { force: true })
    return {
      ok: false,
      detail: `${name}: no se pudo copiar (${String(error instanceof Error ? error.message : error).slice(0, 200)})`,
    }
  }
  const old = listBackups(dir, name).slice(0, -keep)
  for (const file of old) rmSync(join(dir, file), { force: true })
  return {
    ok: true,
    file: final,
    detail: `${name}: copia ${basename(final)}, se conservan ${Math.min(keep, listBackups(dir, name).length)}`,
  }
}

/** Where backups of the databases in `dataDir` go by default: `server/data/backups` for `dev-live`. */
export function defaultBackupDir(dbPath: string): string {
  const dir = dirname(dbPath)
  return basename(dir) === 'dev-live'
    ? join(dirname(dir), 'backups')
    : join(dir, 'backups')
}
