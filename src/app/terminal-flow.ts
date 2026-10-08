import { record } from '../shared/wire/decode.ts'

export type FlowLevel = 'ok' | 'warn' | 'bad'

export interface FlowStatus {
  readonly level: FlowLevel
  readonly label: string
  /** Why it is not "conectado", for the tooltip. */
  readonly reasons: readonly string[]
}

/** A quote older than this means capture or the stream stopped delivering. */
export const STALE_QUOTE_MS = 60_000

/**
 * Flujo conectado: the WebSocket is open, every supervised process runs and
 * the quote is fresh. Flujo con problemas: it is open but a process is down or
 * restarting, the quote is stale or the health feed is unreachable. Flujo
 * desconectado: the WebSocket is not open.
 */
export function flowStatus({
  connected,
  processes,
  quoteAgeMs,
}: {
  connected: boolean
  /** `/api/health` → `processes`; null when the health feed is unreachable. */
  processes: Record<string, unknown> | null
  quoteAgeMs: number | null
}): FlowStatus {
  if (!connected)
    return {
      level: 'bad',
      label: 'FLUJO DESCONECTADO',
      reasons: ['Sin conexión WebSocket con el gateway'],
    }
  const reasons: string[] = []
  if (processes === null) reasons.push('Estado de procesos no disponible')
  else
    for (const [name, value] of Object.entries(processes)) {
      const status = record(value).status
      if (status !== 'running')
        reasons.push(
          `Proceso ${name}: ${status === 'restarting' ? 'reiniciando' : 'caído'}`,
        )
    }
  if (quoteAgeMs === null) reasons.push('Sin precio recibido todavía')
  else if (quoteAgeMs > STALE_QUOTE_MS)
    reasons.push(
      `Precio sin actualizar hace ${Math.round(quoteAgeMs / 1000)} s`,
    )
  return reasons.length === 0
    ? { level: 'ok', label: 'FLUJO CONECTADO', reasons }
    : { level: 'warn', label: 'FLUJO CON PROBLEMAS', reasons }
}
