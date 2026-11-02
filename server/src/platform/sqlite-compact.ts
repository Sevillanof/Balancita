import { existsSync, rmSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/** Espacio «reutilizable» de una base: páginas libres que SQLite conserva pero no devuelve al disco al borrar filas. */
export interface FreeSpace {
  readonly pages: number
  readonly freePages: number
  readonly pageSize: number
  /** 0..1 */
  readonly freeRatio: number
  readonly freeBytes: number
}

/** Conviene compactar cuando el espacio libre supera este porcentaje de la base (ver docs/operacion-base-de-datos.md). */
export const COMPACT_FREE_RATIO = 0.3

export function freeSpace(db: DatabaseSync): FreeSpace {
  const one = (pragma: string): number =>
    Number(
      Object.values(
        db.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>,
      )[0],
    )
  const pages = one('page_count')
  const freePages = one('freelist_count')
  const pageSize = one('page_size')
  return {
    pages,
    freePages,
    pageSize,
    freeRatio: pages > 0 ? freePages / pages : 0,
    freeBytes: freePages * pageSize,
  }
}

function tableCounts(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {}
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all() as { name: string }[]
  for (const { name } of tables)
    out[name] = Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS n FROM "${name.replaceAll('"', '""')}"`)
          .get() as { n: number }
      ).n,
    )
  return out
}

export interface CompactReport {
  readonly ok: boolean
  readonly detail: string
  readonly source: string
  readonly target: string
  readonly sourceBytes: number
  readonly targetBytes: number
  readonly free: FreeSpace
  readonly counts: Record<string, number>
}

/**
 * Compacta una COPIA con `VACUUM INTO` a un archivo NUEVO (la copia original no se toca), después verifica `integrity_check`
 * y que cada tabla tenga las mismas filas. Si algo no coincide borra el archivo nuevo y devuelve ok=false.
 * Nunca se llama con la base viva: el reemplazo lo hace una persona con `pnpm dev` parado (docs/operacion-base-de-datos.md).
 */
export function compactCopy(source: string, target: string): CompactReport {
  if (existsSync(target)) throw new Error(`El destino ya existe: ${target}`)
  const sourceDb = new DatabaseSync(source, { readOnly: true })
  let free: FreeSpace
  let before: Record<string, number>
  try {
    free = freeSpace(sourceDb)
    before = tableCounts(sourceDb)
    sourceDb.prepare('VACUUM INTO ?').run(target)
  } finally {
    sourceDb.close()
  }
  const out = new DatabaseSync(target, { readOnly: true })
  let problem: string | undefined
  try {
    const integrity = (
      out.prepare('PRAGMA integrity_check').all() as {
        integrity_check: string
      }[]
    ).map((r) => r.integrity_check)
    if (integrity.length !== 1 || integrity[0] !== 'ok')
      problem = `integrity_check: ${integrity.slice(0, 3).join(' | ')}`
    const after = tableCounts(out)
    for (const [table, n] of Object.entries(before))
      if (after[table] !== n)
        problem ??= `la tabla ${table} tenía ${n} filas y quedó con ${after[table] ?? 'ninguna'}`
  } finally {
    out.close()
  }
  const report: CompactReport = {
    ok: problem === undefined,
    detail: problem ?? 'integrity_check ok y conteos iguales',
    source,
    target,
    sourceBytes: statSync(source).size,
    targetBytes: statSync(target).size,
    free,
    counts: before,
  }
  if (problem) rmSync(target, { force: true })
  return report
}
