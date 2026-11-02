import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { ArchiveTableSpec } from './archive-tables.ts'

const DAY = 86_400_000
export const MANIFEST_NAME = 'manifiesto.jsonl'
export const OFFSITE_STATE_NAME = 'respaldo-estado.jsonl'

/** Un día (o mes) archivado, confirmado y verificado, que se puede borrar de SQLite. */
export interface DeletablePeriod {
  readonly table: string
  readonly day: string
  readonly fromMs: number
  readonly toMs: number
  /** Filas del manifiesto (tope de lo que puede haber en la base). */
  readonly manifestRows: number
  /** Filas que hoy hay en la base para ese período. */
  readonly dbRows: number
  readonly path: string
}
export interface BlockedPeriod {
  readonly table: string
  readonly day: string
  readonly reason: string
}
export interface GateResult {
  /** `false`: manifiesto ausente, ilegible o con duda: no se borra NADA. */
  readonly ok: boolean
  readonly reason?: string
  readonly deletable: readonly DeletablePeriod[]
  readonly blocked: readonly BlockedPeriod[]
}

/** Caché de archivos ya verificados: se vuelve a hashear solo si cambia el mtime o el tamaño. */
export type VerifiedCache = Map<string, string>

export interface GateOptions {
  readonly archiveDir: string
  readonly specs: readonly ArchiveTableSpec[]
  readonly now: number
  /** Cuenta las filas del período en la base (solo lectura). */
  readonly countRows: (
    spec: ArchiveTableSpec,
    fromMs: number,
    toMs: number,
  ) => number
  /** Con `true` también exige `confirmado_fuera` en `respaldo-estado.jsonl` (FUTURES_ARCHIVE_REQUIRE_OFFSITE=1). */
  readonly requireOffsite?: boolean
  /** Tope de tiempo para hashear archivos en una evaluación (default 5 s); lo que no alcance queda para la próxima. */
  readonly hashBudgetMs?: number
  readonly cache?: VerifiedCache
  readonly clock?: () => number
}

type Entry = Record<string, unknown>

function periodRange(
  day: string,
  granularity: 'day' | 'month',
): { fromMs: number; toMs: number } | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined
  const from = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(from)) return undefined
  if (granularity === 'day') return { fromMs: from, toMs: from + DAY }
  const d = new Date(from)
  if (d.getUTCDate() !== 1) return undefined
  return {
    fromMs: from,
    toMs: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1),
  }
}

/** sha256 en streaming; devuelve `undefined` si se pasa del tiempo disponible. */
async function sha256Capped(
  path: string,
  deadline: number,
  clock: () => number,
): Promise<string | undefined> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, {
    highWaterMark: 1 << 20,
  })) {
    hash.update(chunk as Buffer)
    if (clock() > deadline) return undefined
  }
  return hash.digest('hex')
}

async function readJsonl(path: string): Promise<Entry[] | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  const out: Entry[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const value = JSON.parse(line) as unknown
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined
      out.push(value as Entry)
    } catch {
      return undefined
    }
  }
  return out
}

/**
 * Decide qué se puede borrar. Falla siempre hacia «no borrar»: cualquier duda deja el período en `blocked`
 * (o, si el manifiesto mismo no sirve, `ok: false`). No escribe nada: solo lee el manifiesto, hace `stat`/sha256 de los
 * archivos y cuenta filas en la base.
 */
export async function evaluateArchiveGate(
  options: GateOptions,
): Promise<GateResult> {
  const clock = options.clock ?? (() => performance.now())
  const deadline = clock() + (options.hashBudgetMs ?? 5_000)
  const cache = options.cache ?? new Map<string, string>()
  const manifest = await readJsonl(join(options.archiveDir, MANIFEST_NAME))
  if (manifest === undefined)
    return {
      ok: false,
      reason: 'manifiesto ausente o ilegible',
      deletable: [],
      blocked: [],
    }
  let offsite: Map<string, boolean> | undefined
  if (options.requireOffsite) {
    const state = await readJsonl(join(options.archiveDir, OFFSITE_STATE_NAME))
    offsite = new Map()
    // La última línea de cada archivo manda.
    for (const row of state ?? [])
      if (typeof row.archivo === 'string')
        offsite.set(row.archivo, row.confirmado_fuera === true)
  }
  const deletable: DeletablePeriod[] = []
  const blocked: BlockedPeriod[] = []
  const root = resolve(options.archiveDir)
  for (const spec of options.specs) {
    const entries = manifest.filter(
      (e) => e.base === spec.base && e.tabla === spec.table,
    )
    const seen = new Map<string, number>()
    for (const e of entries)
      seen.set(String(e.dia), (seen.get(String(e.dia)) ?? 0) + 1)
    for (const e of entries) {
      const day = String(e.dia)
      const block = (reason: string): void => {
        blocked.push({ table: spec.table, day, reason })
      }
      const range = periodRange(day, spec.granularity)
      if (!range) {
        block('fecha del manifiesto no válida')
        continue
      }
      if ((seen.get(day) ?? 0) > 1) {
        block('período repetido en el manifiesto')
        continue
      }
      if (e.verificacion_ida_vuelta !== true) {
        block('sin verificacion_ida_vuelta=true en el manifiesto')
        continue
      }
      if (
        typeof e.formato_version !== 'number' ||
        e.formato_version < spec.minFormatVersion
      ) {
        block(`formato_version menor que ${spec.minFormatVersion}`)
        continue
      }
      // 1 día de margen sobre la ventana de retención de la tabla.
      if (range.toMs + DAY + spec.retentionMs > options.now) {
        block('dentro de la ventana de retención (más 1 día de margen)')
        continue
      }
      if (
        typeof e.ruta !== 'string' ||
        typeof e.sha256 !== 'string' ||
        typeof e.bytes !== 'number' ||
        typeof e.filas !== 'number' ||
        !Number.isInteger(e.filas) ||
        e.filas < 0
      ) {
        block('línea del manifiesto incompleta')
        continue
      }
      const file = resolve(root, e.ruta)
      const rel = relative(root, file)
      if (isAbsolute(e.ruta) || rel.startsWith('..') || isAbsolute(rel)) {
        block('ruta fuera del archivo')
        continue
      }
      if (offsite && offsite.get(e.ruta) !== true) {
        block('sin confirmado_fuera (modo estricto)')
        continue
      }
      let info
      try {
        info = await stat(file)
      } catch {
        block('el archivo no existe')
        continue
      }
      if (!info.isFile() || info.size !== e.bytes) {
        block('tamaño distinto del manifiesto')
        continue
      }
      const cacheKey = `${file}:${info.mtimeMs}:${info.size}`
      let sha = cache.get(cacheKey)
      if (sha === undefined) {
        if (clock() > deadline) {
          block('verificación de sha256 pendiente (tope de tiempo)')
          continue
        }
        try {
          sha = await sha256Capped(file, deadline, clock)
        } catch {
          block('no se pudo leer el archivo')
          continue
        }
        if (sha === undefined) {
          block('verificación de sha256 pendiente (tope de tiempo)')
          continue
        }
        cache.set(cacheKey, sha)
      }
      if (sha !== e.sha256) {
        block('sha256 distinto del manifiesto')
        continue
      }
      let dbRows: number
      try {
        dbRows = options.countRows(spec, range.fromMs, range.toMs)
      } catch {
        block('no se pudo contar las filas de la base')
        continue
      }
      if (dbRows > e.filas) {
        block(`la base tiene más filas (${dbRows}) que el archivo (${e.filas})`)
        continue
      }
      deletable.push({
        table: spec.table,
        day,
        fromMs: range.fromMs,
        toMs: range.toMs,
        manifestRows: e.filas,
        dbRows,
        path: e.ruta,
      })
    }
  }
  return { ok: true, deletable, blocked }
}
