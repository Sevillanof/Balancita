import { record } from '../shared/wire/decode.ts'
import { reasonLabel as baseReasonLabel } from './terminal-copy.ts'
import { usdFromString, utcDateTime } from '../shared/finance/format.ts'

export function reasonLabel(value: unknown): string {
  if (value === 'entries_paused')
    return 'Entradas pausadas: el motor no abre nuevas posiciones'
  return baseReasonLabel(value)
}

export function money(value: unknown, maximumFractionDigits = 2): string {
  return usdFromString(value, maximumFractionDigits) ?? 'No disponible'
}

export function quantity(value: unknown): string {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))
    return 'No disponible'
  return `${value} BTC`
}

export function utcTime(value: unknown): string {
  if (!Number.isSafeInteger(value)) return 'Hora no disponible'
  return utcDateTime(Number(value))
}

export function analysisAction(value: unknown): string {
  const analysis = record(value)
  return String(
    analysis.action ?? record(analysis.selector).action ?? 'WAIT',
  ).toUpperCase()
}

export function analysisReason(
  value: unknown,
  preferOwnReason = false,
): string {
  const analysis = record(value)
  const selector = record(analysis.selector)
  const proposals = Array.isArray(analysis.proposals) ? analysis.proposals : []
  const selectedProposal = proposals.find(
    (proposal) =>
      record(proposal).strategy_id ===
      (selector.strategy_id ?? analysis.selected_strategy_id),
  )
  const reasonCodes = Array.isArray(analysis.reason_codes)
    ? analysis.reason_codes
    : []
  const analysisReasonCode = analysis.reason_code
  const firstReasonCode = reasonCodes[0]
  const selectorReason =
    selector.reason_code ?? record(selectedProposal).reason_code
  const reason = preferOwnReason
    ? (analysisReasonCode ?? firstReasonCode ?? selectorReason)
    : (selectorReason ?? firstReasonCode ?? analysisReasonCode)
  if (preferOwnReason && reason === 'position_closed_this_cycle')
    return 'La posición se cerró durante este ciclo'
  return reasonLabel(reason)
}

export function strategyLabel(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    return 'Sin estrategia seleccionada'
  const known: Record<string, string> = {
    'c25-pullback-perp-v1': 'C25 · retroceso (experimental)',
    'c26-reversion-perp-v1': 'C26 · reversión (experimental)',
    'c27-breakout-perp-v1': 'C27 · ruptura (experimental)',
    'c28-adapter-perp-v1': 'C28 · adaptador (experimental)',
  }
  return known[value] ?? 'Sin estrategia seleccionada'
}

export function entryStateLabel(risk: Record<string, unknown>): string {
  if (Object.keys(risk).length === 0) return 'Estado de entradas no disponible'
  if (risk.daily_loss_latched === true)
    return 'Entradas bloqueadas por límite de pérdida diaria'
  if (risk.user_paused === true)
    return 'Entradas pausadas por el usuario (MOCK)'
  if (risk.entry_paused === true || risk.system_paused === true)
    return 'Entradas pausadas por el sistema'
  return 'Entradas activas'
}

export function paperEngineLabel(status: unknown, reason: unknown): string {
  const labels: Record<string, string> = {
    running: 'en marcha',
    idle: 'inactivo',
    starting: 'arrancando',
    unavailable: 'no disponible',
  }
  const reasons: Record<string, string> = {
    paper_execution_active: 'ejecución paper activa',
    no_recent_paper_execution_activity: 'sin actividad reciente',
    account_db_not_ready: 'la cuenta paper aún no existe',
    no_paper_execution_records_yet: 'aún sin registros de ejecución',
    account_db_unreadable: 'no se puede leer la cuenta paper',
    python_unavailable: 'no se encontró Python',
    python_sqlite_too_old: 'el SQLite de Python es demasiado antiguo',
  }
  const label = labels[String(status)] ?? 'estado desconocido'
  const detail = typeof reason === 'string' ? reasons[reason] : undefined
  return detail ? `${label} (${detail})` : label
}

/** Spanish notice for the analyses panel when the engine has nothing to show. */
export function analysesNotice(
  status: unknown,
  reason: unknown,
): string | null {
  if (reason === 'python_unavailable')
    return 'Servicio de veredicto y ejecución paper no disponibles: no se encontró Python 3.9+ (configurá BALANCITA_PYTHON).'
  if (reason === 'python_sqlite_too_old')
    return 'Python encontrado pero su SQLite es anterior a 3.37 (necesario para tablas STRICT): instalá Python desde python.org o Homebrew, o configurá BALANCITA_PYTHON.'
  if (status === 'starting')
    return 'Esperando el primer veredicto: el servicio de veredicto emite uno al cerrar cada vela de 1 minuto.'
  return null
}

export function shortTime(value: unknown): string {
  if (!Number.isSafeInteger(value)) return '--:--'
  return new Date(Number(value)).toISOString().slice(11, 16)
}

export function marketStatusLabel(value: unknown): string {
  const labels: Record<string, string> = {
    connecting: 'Conectando',
    syncing: 'Sincronizando libro',
    live: 'Feed activo',
    degraded: 'Feed degradado',
    stale: 'Feed desactualizado',
    disconnected: 'Feed desconectado',
    stopped: 'Feed detenido',
    unavailable: 'Feed no disponible',
  }
  return typeof value === 'string'
    ? (labels[value] ?? 'Estado del feed no disponible')
    : 'Estado del feed no disponible'
}
