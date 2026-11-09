import { dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
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

/**
 * Whether the price went the way of the side one horizon after the look (or
 * after the entry of an operation), from the closes of the 5 minute candles.
 * Null while the horizon has not fully elapsed. No cost, no exit: only the sign.
 */
export interface QwenDirectionHorizon {
  /** Price move since the look, in basis points, WITHOUT the sign of the side (positive = went up). */
  readonly mov_pb: number | null
  /** The same move times the side: positive = it went the way of the side. */
  readonly a_favor_pb: number | null
  /** True = it went with the side, false = against it, null = no move at all. */
  readonly acerto: boolean | null
}

export interface QwenDirection {
  /** +1 long / -1 short: the side the direction is judged against; null when the look has none. */
  readonly lado: 1 | -1 | null
  readonly '4h': QwenDirectionHorizon | null
  readonly '12h': QwenDirectionHorizon | null
  readonly '24h': QwenDirectionHorizon | null
}

/**
 * An entry proposal of the look (the maestro strong and agreed by the keeper), open or blocked, with the counterfactual
 * label the auditor computes later with the official exit rules. Every label field is null until it is resolved.
 */
export interface QwenProposal {
  /** +1 long / -1 short. */
  readonly lado: 1 | -1 | null
  /** True when the previous look had no entry signal of this side. */
  readonly inicio_episodio: boolean | null
  /** `abierta` (it opened a position) or `bloqueada`. */
  readonly estado: string | null
  /** Why it did not open: lugares_ocupados, mismo_episodio, enfriamiento, cierre_en_la_mirada or otro. */
  readonly motivo_bloqueo: string | null
  /** The trader's raw reason when `motivo_bloqueo` is `otro`. */
  readonly detalle_bloqueo: string | null
  readonly trade_no: number | null
  /** Net after costs of the operation the official rules would have run from this look, in basis points. */
  readonly neto_pb: number | null
  /** Why it would have exited: maestro_vuelta, maestro_agotado or tiempo. */
  readonly motivo_salida: string | null
  readonly horas: number | null
  /** True once the label is final (computed, or given up as «sin datos»). */
  readonly resuelta: boolean
}

/**
 * The maker shadow of ONE official leg (an entry or an exit, both taken at market by the Terminal): what a resting limit order at the best
 * bid / ask would have done on the real tape (`odd/tasks/maker-sombra.md`). It only observes: nothing here changed the official trade.
 * Positive deltas mean the shadow would have come out better than the official leg.
 */
export interface QwenShadowLeg {
  /** `maker` (the tape went through the limit), `maker_mercado` (no fill in 15 min: crossed at the tape price of minute 15) or `sin_datos`. */
  readonly estado: string | null
  /** Why there is no shadow: sin_libro, cinta_con_huecos, cinta_incompleta, cinta_truncada, libro_invalido or producto_sin_captura. */
  readonly motivo_sin_datos: string | null
  /** Exits only: vuelta, agotado, tiempo, rebote, noticia or otro. */
  readonly motivo_salida: string | null
  /** `compra` or `venta`: what the leg does on the book. */
  readonly orden: 'compra' | 'venta' | null
  readonly t_oficial_ms: number | null
  readonly precio_oficial: number | null
  readonly comision_oficial_usd: number | null
  /** How the official leg paid its fee: taker or maker. */
  readonly comision_oficial_tipo: string | null
  /** Price the shadow limit order rested at (best bid to buy, best ask to sell). */
  readonly limite_px: number | null
  readonly llenado_ms: number | null
  readonly llenado_px: number | null
  /** Raw tape price of minute 15 when the shadow had to cross; null when it filled as maker. */
  readonly cinta_px: number | null
  readonly espera_ms: number | null
  readonly comision_sombra_usd: number | null
  /** maker (2 bp) or taker (5 bp). */
  readonly comision_sombra_tipo: string | null
  readonly delta_usd: number | null
  readonly delta_pb: number | null
  readonly modelo: string | null
}

/** Both legs of one operation; a leg the auditor has not resolved yet (needs 15 minutes of tape) is null. */
export interface QwenTradeShadow {
  readonly entrada: QwenShadowLeg | null
  readonly salida: QwenShadowLeg | null
}

export interface QwenAuditoria {
  /** What the auditor saw the look do (ENTRAR, NO_ENTRAR_portero, MANTENER, SALIR_vuelta, ...). */
  readonly accion: string
  readonly veredicto_12h: QwenVerdict | null
  readonly veredicto_24h: QwenVerdict | null
  readonly veredicto_36h: QwenVerdict | null
  readonly despues: QwenAfter | null
  /** Direction at 4, 12 and 24 h; null when the auditor has not written it yet (old rows, or too early). */
  readonly direccion: QwenDirection | null
  /** The entry proposal of this look (open or blocked, with its label); null when the look had none or the auditor has no such table. */
  readonly propuesta: QwenProposal | null
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

function directionHorizonOf(value: unknown): QwenDirectionHorizon | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null
  const body = value as Record<string, unknown>
  return {
    mov_pb: num(body.mov_pb),
    a_favor_pb: num(body.a_favor_pb),
    acerto: typeof body.acerto === 'boolean' ? body.acerto : null,
  }
}

function directionOf(value: unknown): QwenDirection | null {
  const body = jsonObject(value)
  if (!body) return null
  return {
    lado: body.lado === 1 || body.lado === -1 ? body.lado : null,
    '4h': directionHorizonOf(body['4h']),
    '12h': directionHorizonOf(body['12h']),
    '24h': directionHorizonOf(body['24h']),
  }
}

function proposalOf(row: Record<string, unknown>): QwenProposal {
  return {
    lado: row.lado === 1 || row.lado === -1 ? row.lado : null,
    inicio_episodio:
      row.inicio_episodio === 1
        ? true
        : row.inicio_episodio === 0
          ? false
          : null,
    estado: text(row.estado),
    motivo_bloqueo: text(row.motivo_bloqueo),
    detalle_bloqueo: text(row.detalle_bloqueo),
    trade_no: num(row.trade_no),
    neto_pb: num(row.neto_pb),
    motivo_salida: text(row.motivo_salida),
    horas: num(row.horas),
    resuelta: num(row.resuelto_ms) !== null,
  }
}

const SHADOW_FIELDS = [
  'estado',
  'motivo_sin_datos',
  'motivo_salida',
  'orden',
  't_oficial_ms',
  'precio_oficial',
  'comision_oficial_usd',
  'comision_oficial_tipo',
  'limite_px',
  'llenado_ms',
  'llenado_px',
  'cinta_px',
  'espera_ms',
  'comision_sombra_usd',
  'comision_sombra_tipo',
  'delta_usd',
  'delta_pb',
  'modelo',
] as const

function shadowLegOf(row: Record<string, unknown>): QwenShadowLeg {
  return {
    estado: text(row.estado),
    motivo_sin_datos: text(row.motivo_sin_datos),
    motivo_salida: text(row.motivo_salida),
    orden: row.orden === 'compra' || row.orden === 'venta' ? row.orden : null,
    t_oficial_ms: num(row.t_oficial_ms),
    precio_oficial: num(row.precio_oficial),
    comision_oficial_usd: num(row.comision_oficial_usd),
    comision_oficial_tipo: text(row.comision_oficial_tipo),
    limite_px: num(row.limite_px),
    llenado_ms: num(row.llenado_ms),
    llenado_px: num(row.llenado_px),
    cinta_px: num(row.cinta_px),
    espera_ms: num(row.espera_ms),
    comision_sombra_usd: num(row.comision_sombra_usd),
    comision_sombra_tipo: text(row.comision_sombra_tipo),
    delta_usd: num(row.delta_usd),
    delta_pb: num(row.delta_pb),
    modelo: text(row.modelo),
  }
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => rowOf(row).name === column)
}

function hasTable(db: DatabaseSync, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(table) !== undefined
  )
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
  const opened = withDb(auditorDbPath(liveDbPath), (db) => ({
    looks: db
      .prepare(
        // A file the auditor has not migrated yet has no direction column: it reads as null, not as «no auditor».
        `SELECT bucket_ms, accion, veredicto_12h_json, veredicto_24h_json,
                veredicto_36h_json, despues_json,
                ${hasColumn(db, 'miradas', 'direccion_json') ? 'direccion_json' : 'NULL AS direccion_json'}
           FROM miradas WHERE product=? AND bucket_ms BETWEEN ? AND ?`,
      )
      .all(product, fromBucketMs, toBucketMs)
      .map((row) => rowOf(row)),
    // Written by a newer auditor (to train later): without the table the looks just carry no proposal.
    proposals: hasTable(db, 'propuestas')
      ? db
          .prepare(
            `SELECT bucket_ms, lado, inicio_episodio, estado, motivo_bloqueo, detalle_bloqueo,
                    trade_no, neto_pb, motivo_salida, horas, resuelto_ms
               FROM propuestas WHERE product=? AND bucket_ms BETWEEN ? AND ?`,
          )
          .all(product, fromBucketMs, toBucketMs)
          .map((row) => rowOf(row))
      : [],
  }))
  if (opened.state !== 'read') return null
  const proposals = new Map<number, QwenProposal>()
  for (const row of opened.value.proposals) {
    const bucket = num(row.bucket_ms)
    if (bucket !== null) proposals.set(bucket, proposalOf(row))
  }
  const out = new Map<number, QwenAuditoria>()
  for (const row of opened.value.looks) {
    const bucket = num(row.bucket_ms)
    if (bucket === null || typeof row.accion !== 'string') continue
    out.set(bucket, {
      accion: row.accion,
      veredicto_12h: verdictOf(row.veredicto_12h_json),
      veredicto_24h: verdictOf(row.veredicto_24h_json),
      veredicto_36h: verdictOf(row.veredicto_36h_json),
      despues: afterOf(row.despues_json),
      direccion: directionOf(row.direccion_json),
      propuesta: proposals.get(bucket) ?? null,
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
  /** The operation measured by itself (direction from its entry, MAE/MFE); null while the auditor has not written it or has no such table. */
  readonly operacion: QwenTradeOperation | null
  /** The real result of the closed operation (receipts, reasons, prices, MFE/MAE from candle highs and lows); null while open or not written. */
  readonly resultado: QwenTradeResult | null
  /** What a resting limit order would have done on the entry and on the exit, per leg (maker shadow); null while the auditor has not written it or has no such table. */
  readonly sombra: QwenTradeShadow | null
}

/** The real result of a closed operation, as the auditor keeps it to train later. */
export interface QwenTradeResult {
  /** Net after costs from the execution receipts, in basis points / USD. */
  readonly neto_pb: number | null
  readonly neto_usd: number | null
  readonly motivo_cierre: string | null
  readonly motivo_salida: string | null
  readonly entry_px: number | null
  readonly exit_px: number | null
  /** Best / worst the price did for the operation using the candles' highs and lows (>= 0 / <= 0), in basis points. */
  readonly mfe_hl_pb: number | null
  readonly mae_hl_pb: number | null
  /** True once funding is complete and the candles are in: the numbers no longer change. */
  readonly final: boolean
}

/** One operation measured from its entry, on the closes of the 5 minute candles. */
export interface QwenTradeOperation {
  /** +1 long / -1 short. */
  readonly lado: 1 | -1 | null
  /** Direction at 4, 12 and 24 h after the entry, whatever the exit; each horizon null until it has fully elapsed. */
  readonly direccion: QwenDirection | null
  /** Best the price did for the operation until its exit (or until `hasta_ms` while open), in basis points, >= 0. */
  readonly mfe_pb: number | null
  /** Worst the price did against it over the same stretch, in basis points, <= 0. */
  readonly mae_pb: number | null
  /** Close up to which MAE/MFE were measured; null when no candle after the entry. */
  readonly hasta_ms: number | null
  /** True once the operation is closed and its three horizons are known: the numbers no longer change. */
  readonly resuelta: boolean
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
  const marks = tradeNos.map(() => '?').join(',')
  const opened = withDb(auditorDbPath(liveDbPath), (db) => ({
    looks: db
      .prepare(
        `SELECT trade_no, accion, t_ms, veredicto_12h_json, veredicto_24h_json,
                veredicto_36h_json
           FROM miradas
          WHERE product=? AND trade_no IN (${marks})
          ORDER BY t_ms`,
      )
      .all(product, ...tradeNos)
      .map((row) => rowOf(row)),
    // Written by a newer auditor: without the table the operations just carry no measure.
    operations: hasTable(db, 'operaciones')
      ? db
          .prepare(
            `SELECT trade_no, lado, direccion_json, mfe_pb, mae_pb, hasta_ms, resuelto_ms
               FROM operaciones
              WHERE product=? AND trade_no IN (${marks})`,
          )
          .all(product, ...tradeNos)
          .map((row) => rowOf(row))
      : [],
    results: hasTable(db, 'resultados_operacion')
      ? db
          .prepare(
            `SELECT trade_no, neto_pb, neto_usd, motivo_cierre, motivo_salida, entry_px, exit_px,
                    mfe_hl_pb, mae_hl_pb, resultado_ms
               FROM resultados_operacion
              WHERE product=? AND trade_no IN (${marks})`,
          )
          .all(product, ...tradeNos)
          .map((row) => rowOf(row))
      : [],
    // Written by a newer auditor (maker shadow, after the fact): columns it does not have yet read as null.
    shadows: hasTable(db, 'sombra_maker')
      ? db
          .prepare(
            `SELECT trade_no, leg, ${SHADOW_FIELDS.map((name) => (hasColumn(db, 'sombra_maker', name) ? name : `NULL AS ${name}`)).join(', ')}
               FROM sombra_maker
              WHERE product=? AND trade_no IN (${marks})`,
          )
          .all(product, ...tradeNos)
          .map((row) => rowOf(row))
      : [],
  }))
  if (opened.state !== 'read') return null
  type Draft = {
    -readonly [K in keyof QwenTradeAudit]: QwenTradeAudit[K]
  } & { mantener: { aciertos: number; total: number } }
  const out = new Map<number, Draft>()
  const draftOf = (tradeNo: number): Draft => {
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
        operacion: null,
        resultado: null,
        sombra: null,
      }
      out.set(tradeNo, audit)
    }
    return audit
  }
  for (const row of opened.value.looks) {
    const tradeNo = num(row.trade_no)
    if (tradeNo === null || typeof row.accion !== 'string') continue
    const audit = draftOf(tradeNo)
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
  // An operation can have a measure without any look naming it (the first look of several open at once, or a look lost while down).
  for (const row of opened.value.operations) {
    const tradeNo = num(row.trade_no)
    if (tradeNo === null) continue
    draftOf(tradeNo).operacion = {
      lado: row.lado === 1 || row.lado === -1 ? row.lado : null,
      direccion: directionOf(row.direccion_json),
      mfe_pb: num(row.mfe_pb),
      mae_pb: num(row.mae_pb),
      hasta_ms: num(row.hasta_ms),
      resuelta: num(row.resuelto_ms) !== null,
    }
  }
  for (const row of opened.value.results) {
    const tradeNo = num(row.trade_no)
    if (tradeNo === null) continue
    draftOf(tradeNo).resultado = {
      neto_pb: num(row.neto_pb),
      neto_usd: num(row.neto_usd),
      motivo_cierre: text(row.motivo_cierre),
      motivo_salida: text(row.motivo_salida),
      entry_px: num(row.entry_px),
      exit_px: num(row.exit_px),
      mfe_hl_pb: num(row.mfe_hl_pb),
      mae_hl_pb: num(row.mae_hl_pb),
      final: num(row.resultado_ms) !== null,
    }
  }
  for (const row of opened.value.shadows) {
    const tradeNo = num(row.trade_no)
    if (tradeNo === null || (row.leg !== 'entry' && row.leg !== 'exit'))
      continue
    const audit = draftOf(tradeNo)
    const legs = {
      entrada: audit.sombra?.entrada ?? null,
      salida: audit.sombra?.salida ?? null,
    }
    if (row.leg === 'entry') legs.entrada = shadowLegOf(row)
    else legs.salida = shadowLegOf(row)
    audit.sombra = legs
  }
  return out
}
