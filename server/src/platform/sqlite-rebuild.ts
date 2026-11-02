import { existsSync } from 'node:fs'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

/** What happened to one table while rebuilding. */
export interface TableReport {
  readonly table: string
  /**
   * `ok`: every row copied. `discarded`: reading failed, the table is in the new
   * database with its schema but without rows. `partial`: reading failed and the
   * rows read before the failure were kept (`keepPartial`). `no_schema`: its
   * CREATE statement could not be applied. `dropped`: an empty table the caller asked to
   * leave out (`dropEmpty`); it, its indexes and its triggers are not in the new database.
   */
  readonly status: 'ok' | 'discarded' | 'partial' | 'no_schema' | 'dropped'
  readonly rowsCopied: number
  readonly error?: string
}

export interface RebuildReport {
  readonly source: string
  readonly dest: string
  readonly ok: boolean
  readonly tables: readonly TableReport[]
  /** Indexes, views and triggers that could not be recreated. */
  readonly objectsFailed: readonly { name: string; error: string }[]
  readonly integrity: { readonly ok: boolean; readonly detail: string }
}

/**
 * Tables with no writer and no reader anywhere in the code (checked 2-nov-2026): `--drop-empty-legacy`
 * leaves them out of a rebuilt copy when they have 0 rows. Tables that still have a live writer
 * (book_snapshots, llm_errors, news_errors, qwen errors/news_actions/execution_receipts) are not here.
 */
export const LEGACY_EMPTY_TABLES: readonly string[] = [
  'paper_futures_ticker_snapshots',
]

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`
const message = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).slice(0, 300)

interface Master {
  type: string
  name: string
  tbl_name: string
  sql: string | null
}

/**
 * Builds a healthy database from a damaged one, table by table. Always work on a
 * COPY (`pnpm db:snapshot`), never on the live file. It creates a new database,
 * applies every table's CREATE statement from `sqlite_master`, copies the rows of
 * each table with its own try/catch (a table whose pages are damaged is discarded
 * and the rest still comes across; with `keepPartial` the rows read before the
 * failure are kept), then recreates indexes, views and triggers (after the rows,
 * so no trigger fires while copying), and ends with `integrity_check`.
 * Rowids are preserved: readers that tail by rowid keep working.
 */
export function rebuildDatabase(
  source: string,
  dest: string,
  options: { keepPartial?: boolean; dropEmpty?: readonly string[] } = {},
): RebuildReport {
  if (!existsSync(source)) throw new Error(`No existe la base: ${source}`)
  if (existsSync(dest)) throw new Error(`El destino ya existe: ${dest}`)
  const src = new DatabaseSync(source, { readOnly: true })
  let master: Master[]
  try {
    master = src
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
      )
      .all() as unknown as Master[]
  } catch (error) {
    src.close()
    throw new Error(
      `No se puede leer el esquema (sqlite_master) de ${source}: ${message(error)}. Restaurá una copia buena.`,
      { cause: error },
    )
  }
  // Tables to leave out: each must exist, have 0 rows and no other table may reference it.
  const dropped = new Set<string>()
  try {
    for (const name of options.dropEmpty ?? []) {
      if (!master.some((m) => m.type === 'table' && m.name === name)) {
        if (LEGACY_EMPTY_TABLES.includes(name)) continue // already absent: nothing to leave out
        throw new Error(`No se puede quitar ${name}: no existe en la base.`)
      }
      const count = src
        .prepare(`SELECT COUNT(*) AS n FROM ${ident(name)}`)
        .get() as {
        n: number
      }
      if (Number(count.n) !== 0)
        throw new Error(
          `No se puede quitar ${name}: tiene ${count.n} filas (solo se quitan tablas vacías).`,
        )
      for (const other of master.filter(
        (m) => m.type === 'table' && m.name !== name,
      )) {
        const refs = src
          .prepare(`PRAGMA foreign_key_list(${ident(other.name)})`)
          .all() as { table: string }[]
        if (refs.some((r) => r.table === name))
          throw new Error(
            `No se puede quitar ${name}: la referencia la tabla ${other.name}.`,
          )
      }
      dropped.add(name)
    }
  } catch (error) {
    src.close()
    throw error
  }
  // Only now is the new file created: an unreadable schema leaves nothing behind.
  const out = new DatabaseSync(dest)
  try {
    out.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=OFF')
    const tables: TableReport[] = []
    for (const item of master.filter((m) => m.type === 'table')) {
      if (dropped.has(item.name)) {
        tables.push({ table: item.name, status: 'dropped', rowsCopied: 0 })
        continue
      }
      tables.push(copyTable(src, out, item, options.keepPartial === true))
    }
    // sqlite_sequence (AUTOINCREMENT counters), best effort.
    try {
      const seq = src
        .prepare('SELECT name, seq FROM sqlite_sequence')
        .all() as { name: string; seq: number }[]
      for (const row of seq)
        out
          .prepare('UPDATE sqlite_sequence SET seq=? WHERE name=?')
          .run(row.seq, row.name)
    } catch {
      // No AUTOINCREMENT tables, or the counters are unreadable: SQLite recomputes them.
    }
    const objectsFailed: { name: string; error: string }[] = []
    for (const item of master.filter(
      (m) => m.type !== 'table' && !dropped.has(m.tbl_name),
    )) {
      try {
        out.exec(item.sql ?? '')
      } catch (error) {
        objectsFailed.push({ name: item.name, error: message(error) })
      }
    }
    const rows = out.prepare('PRAGMA integrity_check').all() as {
      integrity_check: string
    }[]
    const integrity =
      rows.length === 1 && rows[0]?.integrity_check === 'ok'
        ? { ok: true, detail: 'integrity_check ok' }
        : {
            ok: false,
            detail: rows
              .map((r) => r.integrity_check)
              .join(' | ')
              .slice(0, 400),
          }
    return {
      source,
      dest,
      ok:
        integrity.ok &&
        tables.every(
          (t) =>
            t.status === 'ok' ||
            t.status === 'discarded' ||
            t.status === 'dropped',
        ),
      tables,
      objectsFailed,
      integrity,
    }
  } finally {
    try {
      src.close()
    } catch {
      // Read-only handle.
    }
    out.close()
  }
}

function copyTable(
  src: DatabaseSync,
  out: DatabaseSync,
  item: Master,
  keepPartial: boolean,
): TableReport {
  const table = item.name
  try {
    out.exec(item.sql ?? '')
  } catch (error) {
    return { table, status: 'no_schema', rowsCopied: 0, error: message(error) }
  }
  let rowsCopied = 0
  try {
    const info = src.prepare(`PRAGMA table_xinfo(${ident(table)})`).all() as {
      name: string
      hidden: number
    }[]
    // Generated columns (hidden 2, 3) are computed again by the new table.
    const columns = info.filter((c) => c.hidden === 0 || c.hidden === 1)
    if (columns.length === 0) return { table, status: 'ok', rowsCopied: 0 } // virtual or empty definition
    const withoutRowid = /WITHOUT\s+ROWID/i.test(item.sql ?? '')
    const names = columns.map((c) => ident(c.name))
    const select = `SELECT ${withoutRowid ? '' : 'rowid AS __rowid__, '}${names.join(', ')} FROM ${ident(table)}`
    const insert = out.prepare(
      `INSERT INTO ${ident(table)} (${withoutRowid ? '' : 'rowid, '}${names.join(', ')}) VALUES (${(withoutRowid ? names : ['?', ...names]).map(() => '?').join(', ')})`,
    )
    out.exec('BEGIN')
    try {
      const read = src.prepare(select)
      // Arrays keep the column order; BigInt keeps 64-bit integers exact.
      read.setReturnArrays(true)
      read.setReadBigInts(true)
      for (const row of read.iterate()) {
        insert.run(...(row as unknown as SQLInputValue[]))
        rowsCopied += 1
      }
    } catch (error) {
      if (keepPartial && rowsCopied > 0) {
        out.exec('COMMIT')
        return {
          table,
          status: 'partial',
          rowsCopied,
          error: message(error),
        }
      }
      out.exec('ROLLBACK')
      return {
        table,
        status: 'discarded',
        rowsCopied: 0,
        error: `${message(error)} (se leyeron ${rowsCopied} filas antes del fallo)`,
      }
    }
    out.exec('COMMIT')
    return { table, status: 'ok', rowsCopied }
  } catch (error) {
    try {
      out.exec('ROLLBACK')
    } catch {
      // No transaction open.
    }
    return { table, status: 'discarded', rowsCopied: 0, error: message(error) }
  }
}

/** One line per table for the console. */
export function describeRebuild(report: RebuildReport): string {
  const lines = report.tables.map((t) => {
    const mark =
      t.status === 'ok'
        ? 'OK       '
        : t.status === 'partial'
          ? 'PARCIAL  '
          : t.status === 'dropped'
            ? 'QUITADA   '
            : 'DESCARTADA'
    return `${mark} ${t.table}: ${t.rowsCopied} filas${t.error ? ` — ${t.error}` : ''}`
  })
  for (const o of report.objectsFailed)
    lines.push(`SIN CREAR  ${o.name} — ${o.error}`)
  lines.push(
    `Integridad de la base nueva: ${report.integrity.ok ? 'correcta' : `FALLA (${report.integrity.detail})`}`,
  )
  lines.push(
    `Resultado: ${report.ok ? 'base reconstruida' : 'revisar el informe'} -> ${report.dest}`,
  )
  return lines.join('\n')
}
