import { record } from '../shared/wire/decode.ts'

/**
 * Qwen's waits, said in plain Spanish: what it saw (probability of each
 * option), what it wanted and why it did not act. Reads the gateway fields
 * (`/api/qwen/decisions`); a missing field is never filled in.
 */

const OPTION_LABEL: Record<string, string> = {
  LARGO: 'largo',
  CORTO: 'corto',
  ESPERAR: 'esperar',
  MANTENER: 'mantener',
  CERRAR: 'cerrar',
}

/** `0.46` -> `46 %` (whole percent, as Fran reads it). */
export function percent(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value * 100)} %`
    : null
}

function side(action: unknown): string | null {
  if (action === 'LARGO') return 'LARGO'
  if (action === 'CORTO') return 'CORTO'
  if (action === 'CERRAR') return 'CERRAR'
  return null
}

/** `0.123` -> `0,12` (two decimals, decimal comma). */
export function score(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toFixed(2).replace('.', ',')
    : null
}

/** «Largo 46 % · Corto 20 % · Esperar 34 %», in the order the model gave. */
export function probabilitiesText(value: unknown): string | null {
  const entries = Object.entries(record(value)).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  )
  if (entries.length === 0) return null
  return entries
    .map(([key, p]) => {
      const label = OPTION_LABEL[key] ?? key.toLowerCase().replaceAll('_', ' ')
      return `${label.charAt(0).toUpperCase()}${label.slice(1)} ${percent(p)}`
    })
    .join(' · ')
}

/** Why a wake produced no decision (`skipped.reason`). */
export function skippedReason(reason: unknown, detail?: unknown): string {
  const known: Record<string, string> = {
    modelo_caido: 'No pudo decidir: el modelo local no respondió.',
    modelo_lento: 'No pudo decidir: el modelo local tardó más de lo permitido.',
    sin_respuesta:
      'No pudo decidir: el modelo contestó algo que no se pudo leer.',
    proceso_detenido:
      'No decidió: el proceso de Qwen estaba apagado a esa hora.',
  }
  if (typeof reason === 'string' && known[reason]) return known[reason]
  const extra =
    typeof detail === 'string' && detail.length > 0 ? ` (${detail})` : ''
  return `No decidió esta vez${extra}.`
}

/**
 * The reason of one decision in plain words, or null when the row carries
 * nothing to say (an old row, or an entry/exit that has its own reason).
 */
export function waitReason(row: Record<string, unknown>): string | null {
  const chosen = row.chosen
  const override = typeof row.override === 'string' ? row.override : null
  const wanted = side(row.model_action)
  const pWanted = percent(row.p_action)
  const threshold = percent(row.threshold)
  const probs = record(row.probabilities)
  const pWait = percent(probs.ESPERAR ?? probs.MANTENER)
  const mirror = side(row.mirror_action)

  if (override === 'ventana_mirando') {
    const now = score(row.score)
    const best = score(row.best_score)
    const n = typeof row.look_n === 'number' ? row.look_n : null
    const lado =
      side(row.model_action) ?? (Number(row.lean_num) < 0 ? 'CORTO' : 'LARGO')
    const head = `Mirando la mejor ocasión${n ? ` (mirada ${n})` : ''}.`
    if (row.mirror_ok === 0)
      return `${head} Se inclinaba ${lado}, pero el espejo no coincidió: no es una ocasión confiable, no entra.`
    if (now && best)
      return `${head} Esta ocasión vale ${now} y la mejor candidata hasta ahora vale ${best}: espera una mejor antes de entrar.`
    return `${head} Todavía no entra: espera una ocasión mejor.`
  }
  if (override === 'entrada_ventana') {
    const now = score(row.score)
    const lado = side(row.chosen)
    return `Entró${lado ? ` ${lado}` : ''} en la ventana de oportunidad${now ? `, con una ocasión de ${now}` : ''}, con el espejo coincidiendo.`
  }
  if (override === 'entrada_forzada')
    return 'Entró por inactividad: eligió el lado que veía más probable (modo anterior, sin espejo).'
  if (override === 'bajo_umbral')
    return wanted && pWanted && threshold
      ? `Quiso entrar ${wanted} con ${pWanted}, no llegó al ${threshold} mínimo.`
      : 'Quiso entrar pero no llegó a la confianza mínima, así que esperó.'
  if (override === 'espejo') {
    const detail =
      mirror && percent(row.mirror_p)
        ? ` Del lado espejado contestó ${mirror} con ${percent(row.mirror_p)}.`
        : ''
    return `Quiso entrar${wanted ? ` ${wanted}` : ''}${pWanted ? ` con ${pWanted}` : ''}, pero el espejo lo contradijo, así que esperó.${detail}`
  }
  if (override === 'espejo_sin_respuesta')
    return `Quiso entrar${wanted ? ` ${wanted}` : ''}, pero la prueba del espejo no se pudo leer, así que esperó.`
  if (override === 'sin_respuesta')
    return 'Esperó porque el modelo contestó algo que no se pudo leer.'
  if (override === 'motivo_sin_respuesta')
    return 'Operó, pero el modelo no dio el motivo de forma legible; queda como «otro».'
  if (override) return `No operó (${override.replaceAll('_', ' ')}).`

  if (chosen === 'ESPERAR')
    return pWait
      ? `Esperó porque vio más probable esperar (${pWait}).`
      : 'Esperó porque no vio ventaja clara.'
  if (chosen === 'MANTENER')
    return pWait
      ? `Mantuvo la posición porque vio más probable mantener (${pWait}).`
      : 'Mantuvo la posición abierta.'
  return null
}
