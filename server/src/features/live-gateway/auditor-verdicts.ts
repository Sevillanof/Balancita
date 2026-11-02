import { dirname, join } from 'node:path'
import { withDb, num, rowOf } from './observability-health.ts'

/**
 * Decision auditor, read only: the verdicts a separate Python process writes
 * to `auditor.sqlite`, next to the operator's `live.sqlite` (same folder, so
 * no new setting). Each look (product, bucket) can carry a verdict at 12, 24
 * and 36 hours: what the whole operation would have done, not just the price
 * 30 minutes later. The live process never depends on this file: a missing
 * file, a missing table or a failing query reads as «no auditor» (null).
 */
export const AUDITOR_DB_NAME = 'auditor.sqlite'

/** The verdict of one horizon; `acerto` null = a fixed rule, not judged. */
export interface QwenVerdict {
  readonly acerto: boolean | null
  /** What the mistake cost, in basis points; null when not given. */
  readonly costo_error_pb: number | null
  readonly regla: string | null
  /** Short Spanish text for the tooltip, e.g. «si entraba: +23 pb». */
  readonly texto: string | null
}

/** What happened after the look, in basis points; every field null when unknown. */
export interface QwenAfter {
  readonly mov_30m: number | null
  readonly mov_1h: number | null
  readonly mov_4h: number | null
  readonly mov_12h: number | null
  readonly mov_24h: number | null
  readonly mov_36h: number | null
  readonly mfe_36h: number | null
  readonly mae_36h: number | null
  readonly si_entraba_maestro_pb: number | null
  readonly si_entraba_contrario_pb: number | null
  readonly queda_hasta_salida_pb: number | null
  readonly queda_hasta_36h_pb: number | null
}

export interface QwenAuditoria {
  /** What the auditor saw the look do (ENTRAR, NO_ENTRAR_portero, MANTENER, SALIR_vuelta, ...). */
  readonly accion: string
  readonly veredicto_12h: QwenVerdict | null
  readonly veredicto_24h: QwenVerdict | null
  readonly veredicto_36h: QwenVerdict | null
  readonly despues: QwenAfter | null
}

const AFTER_FIELDS = [
  'mov_30m',
  'mov_1h',
  'mov_4h',
  'mov_12h',
  'mov_24h',
  'mov_36h',
  'mfe_36h',
  'mae_36h',
  'si_entraba_maestro_pb',
  'si_entraba_contrario_pb',
  'queda_hasta_salida_pb',
  'queda_hasta_36h_pb',
] as const

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

function verdictOf(value: unknown): QwenVerdict | null {
  const body = jsonObject(value)
  if (!body) return null
  return {
    acerto: typeof body.acerto === 'boolean' ? body.acerto : null,
    costo_error_pb: num(body.costo_error_pb),
    regla: text(body.regla),
    texto: text(body.texto),
  }
}

function afterOf(value: unknown): QwenAfter | null {
  const body = jsonObject(value)
  if (!body) return null
  return Object.fromEntries(
    AFTER_FIELDS.map((key) => [key, num(body[key])]),
  ) as unknown as QwenAfter
}

/** The auditor database that sits next to the operator's; undefined when the operator has no path. */
export function auditorDbPath(
  liveDbPath: string | undefined,
): string | undefined {
  return liveDbPath ? join(dirname(liveDbPath), AUDITOR_DB_NAME) : undefined
}

/**
 * The verdicts of one product for the looks between two buckets (inclusive),
 * keyed by `bucket_ms`, in ONE query. Null when the auditor cannot be read
 * (no file, no table, a failing query): the caller then shows no verdicts.
 */
export function readAuditorVerdicts(
  liveDbPath: string | undefined,
  product: string,
  fromBucketMs: number,
  toBucketMs: number,
): ReadonlyMap<number, QwenAuditoria> | null {
  const opened = withDb(auditorDbPath(liveDbPath), (db) =>
    db
      .prepare(
        `SELECT bucket_ms, accion, veredicto_12h_json, veredicto_24h_json,
                veredicto_36h_json, despues_json
           FROM miradas WHERE product=? AND bucket_ms BETWEEN ? AND ?`,
      )
      .all(product, fromBucketMs, toBucketMs)
      .map((row) => rowOf(row)),
  )
  if (opened.state !== 'read') return null
  const out = new Map<number, QwenAuditoria>()
  for (const row of opened.value) {
    const bucket = num(row.bucket_ms)
    if (bucket === null || typeof row.accion !== 'string') continue
    out.set(bucket, {
      accion: row.accion,
      veredicto_12h: verdictOf(row.veredicto_12h_json),
      veredicto_24h: verdictOf(row.veredicto_24h_json),
      veredicto_36h: verdictOf(row.veredicto_36h_json),
      despues: afterOf(row.despues_json),
    })
  }
  return out
}

export type QwenHorizon = '12h' | '24h' | '36h'

/** The verdict that counts for one look: the longest horizon that has one (36 h over 24 h over 12 h). */
function bestVerdict(row: Record<string, unknown>): {
  verdict: QwenVerdict
  horizon: QwenHorizon
} | null {
  for (const [key, horizon] of [
    ['veredicto_36h_json', '36h'],
    ['veredicto_24h_json', '24h'],
    ['veredicto_12h_json', '12h'],
  ] as const) {
    const verdict = verdictOf(row[key])
    if (verdict) return { verdict, horizon }
  }
  return null
}

/** How the auditor judged one operation: its entry, its exit and the looks it held through. */
export interface QwenTradeAudit {
  /** Verdict of the look that opened it, at the longest horizon available; null while it has none. */
  readonly entrada: QwenVerdict | null
  readonly entrada_horizonte: QwenHorizon | null
  /** What the auditor saw that look do (ENTRAR, ENTRAR_noticias); null when it has no entry look. */
  readonly entrada_accion: string | null
  /** Verdict of the look that closed it; null while open, unjudged or without one (a fixed rule has `acerto` null). */
  readonly salida: QwenVerdict | null
  readonly salida_horizonte: QwenHorizon | null
  /** How the close was classified (SALIR_vuelta, SALIR_36h, ...); null while open or unseen. */
  readonly salida_accion: string | null
  /** Looks that kept the operation open and already have a verdict: how many were right out of how many judged. */
  readonly mantener: { readonly aciertos: number; readonly total: number }
  /** All the looks the auditor saw of this operation. */
  readonly miradas: number
}

/**
 * The audit of each operation asked for, keyed by `trade_no`, in ONE query
 * over the looks that carry that operation number. An operation the auditor
 * has not seen is absent from the map. Null when the auditor cannot be read
 * (no file, no table, a failing query): the caller then shows no audit.
 */
export function readAuditorTrades(
  liveDbPath: string | undefined,
  product: string,
  tradeNos: readonly number[],
): ReadonlyMap<number, QwenTradeAudit> | null {
  if (tradeNos.length === 0) return new Map()
  const opened = withDb(auditorDbPath(liveDbPath), (db) =>
    db
      .prepare(
        `SELECT trade_no, accion, t_ms, veredicto_12h_json, veredicto_24h_json,
                veredicto_36h_json
           FROM miradas
          WHERE product=? AND trade_no IN (${tradeNos.map(() => '?').join(',')})
          ORDER BY t_ms`,
      )
      .all(product, ...tradeNos)
      .map((row) => rowOf(row)),
  )
  if (opened.state !== 'read') return null
  type Draft = {
    -readonly [K in keyof QwenTradeAudit]: QwenTradeAudit[K]
  } & { mantener: { aciertos: number; total: number } }
  const out = new Map<number, Draft>()
  for (const row of opened.value) {
    const tradeNo = num(row.trade_no)
    if (tradeNo === null || typeof row.accion !== 'string') continue
    let audit = out.get(tradeNo)
    if (!audit) {
      audit = {
        entrada: null,
        entrada_horizonte: null,
        entrada_accion: null,
        salida: null,
        salida_horizonte: null,
        salida_accion: null,
        mantener: { aciertos: 0, total: 0 },
        miradas: 0,
      }
      out.set(tradeNo, audit)
    }
    audit.miradas += 1
    const best = bestVerdict(row)
    if (row.accion.startsWith('ENTRAR')) {
      // Rows come oldest first: the first entry look is the one that opened it.
      if (audit.entrada_accion === null) {
        audit.entrada_accion = row.accion
        audit.entrada = best?.verdict ?? null
        audit.entrada_horizonte = best?.horizon ?? null
      }
    } else if (row.accion.startsWith('SALIR')) {
      audit.salida_accion = row.accion
      audit.salida = best?.verdict ?? null
      audit.salida_horizonte = best?.horizon ?? null
    } else if (
      row.accion === 'MANTENER' &&
      typeof best?.verdict.acerto === 'boolean'
    ) {
      audit.mantener.total += 1
      if (best.verdict.acerto) audit.mantener.aciertos += 1
    }
  }
  return out
}
