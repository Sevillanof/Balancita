import {
  existsSync,
  readFileSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { listBackups, backupStampMs } from '../../platform/sqlite-safety.ts'
import {
  evaluateArchiveGate,
  type DeletablePeriod,
  type GateResult,
  type VerifiedCache,
} from './archive-gate.ts'
import type { ArchiveTableSpec } from './archive-tables.ts'

const HOUR = 3_600_000

export interface ArchivePrunerOptions {
  /** La base que ESTE proceso escribe (nunca una abierta desde un tercero). */
  readonly db: DatabaseSync
  readonly archiveDir: string
  readonly specs: readonly ArchiveTableSpec[]
  /** `false` (por defecto en el entorno): no hace nada. `'dry-run'`: solo informa qué borraría. */
  readonly mode: 'off' | 'dry-run' | 'delete'
  readonly requireOffsite?: boolean
  readonly clock?: () => number
  /** Copia diaria buena y reciente de la base; sin ella no se empieza a borrar un período. */
  readonly backupOk: () => { ok: boolean; reason: string }
  /** Una línea por paso (va a retention.jsonl). */
  readonly record: (entry: Record<string, unknown>) => void
  /** Cada cuánto se vuelve a evaluar el gate (default 10 min). */
  readonly evalEveryMs?: number
  readonly cache?: VerifiedCache
}

export interface ArchivePruner {
  /** Refresca el plan si toca (async: lee manifiesto y hashea con tope de tiempo). No borra. */
  prepare(): Promise<void>
  /** Borra como mucho `batch` filas en una transacción corta. `done`: no queda nada por borrar ahora. */
  step(batch: number): { deleted: number; done: boolean }
  readonly mode: 'off' | 'dry-run' | 'delete'
}

const ident = (name: string): string => `"${name.replaceAll('"', '""')}"`

/** Una tabla con trigger de borrado es inmutable por diseño: no se toca (ni se desactiva el trigger). */
function hasDeleteGuard(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM sqlite_master WHERE type='trigger' AND tbl_name=? AND (sql LIKE '%BEFORE DELETE%' OR sql LIKE '%AFTER DELETE%')`,
    )
    .get(table)
  return row !== undefined
}

export function createArchivePruner(
  options: ArchivePrunerOptions,
): ArchivePruner {
  const clock = options.clock ?? Date.now
  const cache: VerifiedCache = options.cache ?? new Map()
  const evalEvery = options.evalEveryMs ?? 10 * 60_000
  let nextEval = Number.NEGATIVE_INFINITY
  let queue: DeletablePeriod[] = []
  // Períodos ya vaciados: no se vuelven a contar en cada evaluación.
  const finished = new Set<string>()
  const backupChecked = new Set<string>()
  const reported = new Set<string>()
  let gateReported = false
  const key = (p: { table: string; day: string }): string =>
    `${p.table}:${p.day}`
  const specOf = (table: string): ArchiveTableSpec | undefined =>
    options.specs.find((s) => s.table === table)

  const countRows = (spec: ArchiveTableSpec, from: number, to: number) =>
    Number(
      (
        options.db
          .prepare(
            `SELECT COUNT(*) AS n FROM ${ident(spec.sqliteTable)} WHERE ${ident(spec.timeColumn)} >= ? AND ${ident(spec.timeColumn)} < ?`,
          )
          .get(from, to) as { n: number }
      ).n,
    )

  return {
    mode: options.mode,
    async prepare() {
      if (options.mode === 'off' || clock() < nextEval) return
      nextEval = clock() + evalEvery
      let gate: GateResult
      try {
        gate = await evaluateArchiveGate({
          archiveDir: options.archiveDir,
          specs: options.specs.filter((spec) => {
            if (!hasDeleteGuard(options.db, spec.sqliteTable)) return true
            options.record({
              at: clock(),
              kind: 'archive-skip',
              table: spec.table,
              reason: 'tabla inmutable por trigger: no se borra',
            })
            return false
          }),
          now: clock(),
          countRows,
          requireOffsite: options.requireOffsite,
          cache,
        })
      } catch (error) {
        queue = []
        options.record({
          at: clock(),
          kind: 'archive-gate-error',
          error: String(error),
        })
        return
      }
      if (!gate.ok) {
        queue = []
        if (!gateReported)
          options.record({
            at: clock(),
            kind: 'archive-gate',
            reason: gate.reason,
          })
        gateReported = true
        return
      }
      gateReported = false
      queue = gate.deletable.filter(
        (p) => !finished.has(key(p)) && p.dbRows > 0,
      )
      for (const p of gate.deletable) if (p.dbRows === 0) finished.add(key(p))
      for (const b of gate.blocked) {
        const k = `${key(b)}:${b.reason}`
        if (reported.has(k)) continue
        reported.add(k)
        // Solo informa los bloqueos de períodos que aún tienen filas en la base: el resto es ruido.
        options.record({ at: clock(), kind: 'archive-blocked', ...b })
      }
      if (options.mode === 'dry-run') {
        for (const p of queue) {
          if (reported.has(`dry:${key(p)}`)) continue
          reported.add(`dry:${key(p)}`)
          options.record({
            at: clock(),
            kind: 'archive-dry-run',
            table: p.table,
            day: p.day,
            rows: p.dbRows,
          })
        }
        queue = []
      }
    },
    step(batch) {
      if (options.mode !== 'delete') return { deleted: 0, done: true }
      const item = queue[0]
      if (!item) return { deleted: 0, done: true }
      const spec = specOf(item.table)
      if (!spec || hasDeleteGuard(options.db, spec.sqliteTable)) {
        queue.shift()
        return { deleted: 0, done: queue.length === 0 }
      }
      // Antes del primer borrado de cada período: copia diaria buena y reciente.
      if (!backupChecked.has(key(item))) {
        const backup = options.backupOk()
        if (!backup.ok) {
          options.record({
            at: clock(),
            kind: 'archive-blocked',
            table: item.table,
            day: item.day,
            reason: `sin copia previa buena: ${backup.reason}`,
          })
          queue = []
          // Se reintenta en la próxima evaluación, no en bucle.
          return { deleted: 0, done: true }
        }
        backupChecked.add(key(item))
      }
      const t = ident(spec.sqliteTable)
      const c = ident(spec.timeColumn)
      let deleted: number
      options.db.exec('BEGIN IMMEDIATE')
      try {
        deleted = Number(
          options.db
            .prepare(
              `DELETE FROM ${t} WHERE rowid IN (SELECT rowid FROM ${t} WHERE ${c} >= ? AND ${c} < ? LIMIT ?)`,
            )
            .run(item.fromMs, item.toMs, Math.max(1, Math.floor(batch)))
            .changes,
        )
        options.db.exec('COMMIT')
      } catch (error) {
        try {
          options.db.exec('ROLLBACK')
        } catch {
          // Sin transacción abierta.
        }
        queue = []
        options.record({
          at: clock(),
          kind: 'archive-delete-error',
          table: item.table,
          day: item.day,
          error: String(error),
        })
        return { deleted: 0, done: true }
      }
      const finishedNow = deleted < Math.max(1, Math.floor(batch))
      options.record({
        at: clock(),
        kind: 'archive-delete',
        table: item.table,
        day: item.day,
        deleted,
        periodDone: finishedNow,
      })
      if (finishedNow) {
        finished.add(key(item))
        queue.shift()
      }
      return { deleted, done: queue.length === 0 }
    },
  }
}

/**
 * ¿Hay una copia diaria buena y reciente de `name`? Las copias solo entran en su lugar después de pasar `quick_check`
 * (se escriben como `.tmp` y se renombran), así que una copia con nombre final y cabecera SQLite es una que ya pasó.
 * Con `statePath` (el `db-health-state.json` de la captura) también se rechaza una base marcada como dañada.
 */
export function makeBackupGuard(options: {
  backupDir: string
  name: string
  clock?: () => number
  maxAgeMs?: number
  statePath?: string
}): () => { ok: boolean; reason: string } {
  const clock = options.clock ?? Date.now
  return () => {
    if (options.statePath) {
      try {
        const state = JSON.parse(readFileSync(options.statePath, 'utf8')) as {
          damaged?: string | null
        }
        if (state.damaged)
          return { ok: false, reason: 'base marcada como dañada' }
      } catch {
        return { ok: false, reason: 'no se pudo leer db-health-state.json' }
      }
    }
    const last = listBackups(options.backupDir, options.name).at(-1)
    if (last === undefined) return { ok: false, reason: 'no hay copia diaria' }
    const at = backupStampMs(last) as number
    if (!looksLikeSqlite(join(options.backupDir, last)))
      return { ok: false, reason: 'la última copia no parece una base SQLite' }
    if (clock() - at > (options.maxAgeMs ?? 30 * HOUR))
      return { ok: false, reason: 'la última copia tiene más de 30 h' }
    return { ok: true, reason: 'ok' }
  }
}

/** Mismo estado de salud, para el proceso que no tiene al guardián de despertar: ¿pasó un despertar hace menos de 10 min? */
export function recentWakeFromState(
  statePath: string,
  now: number,
  pauseMs = 10 * 60_000,
): boolean {
  try {
    if (!existsSync(statePath)) return false
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      wake?: { at?: number } | null
    }
    const at = state.wake?.at
    return typeof at === 'number' && now - at >= 0 && now - at < pauseMs
  } catch {
    return true
  }
}

/** Cabecera SQLite de 16 bytes (comprobación barata de que un archivo es una base). */
export function looksLikeSqlite(path: string): boolean {
  try {
    if (statSync(path).size < 512) return false
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(16)
      readSync(fd, buf, 0, 16, 0)
      return buf.toString('latin1') === 'SQLite format 3\0'
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

/** Un ciclo suave para procesos sin `retention-runner` (el recolector de posicionamiento): presupuesto de tiempo y pausas entre pasos. */
export async function runArchiveCycle(
  pruner: ArchivePruner,
  options: {
    budgetMs?: number
    batch?: number
    canRun?: () => boolean
    yieldLoop?: () => Promise<void>
    now?: () => number
  } = {},
): Promise<{ deleted: number; steps: number; done: boolean }> {
  const now = options.now ?? (() => performance.now())
  const yieldLoop =
    options.yieldLoop ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, 5)))
  const start = now()
  let deleted = 0
  let steps = 0
  let done = false
  if (options.canRun && !options.canRun())
    return { deleted, steps, done: false }
  await pruner.prepare()
  while (!(options.canRun && !options.canRun())) {
    const r = pruner.step(options.batch ?? 500)
    steps += 1
    deleted += r.deleted
    done = r.done
    if (done || now() - start > (options.budgetMs ?? 6_000)) break
    await yieldLoop()
  }
  return { deleted, steps, done }
}
