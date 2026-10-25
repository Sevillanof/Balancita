const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "3 días 4 h", "5 h 10 min", "12 min"; 0 means the strategy was never active in paper. */
export function formatActiveTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'nunca estuvo activa'
  if (ms < MINUTE) return 'menos de 1 min'
  const days = Math.floor(ms / DAY)
  const hours = Math.floor((ms % DAY) / HOUR)
  const minutes = Math.floor((ms % HOUR) / MINUTE)
  if (days > 0)
    return `${days} ${days === 1 ? 'día' : 'días'}${hours > 0 ? ` ${hours} h` : ''}`
  if (hours > 0) return `${hours} h${minutes > 0 ? ` ${minutes} min` : ''}`
  return `${minutes} min`
}

export function isProtectedStrategy(id: string): boolean {
  const lowered = id.toLowerCase()
  return (
    lowered.startsWith('kronos-') ||
    lowered.startsWith('c31-qwen') ||
    lowered.startsWith('qwen-live')
  )
}

export const NOT_PASSED_WARNING =
  'Esta versión no pasó la prueba. ¿Activarla igual en el paper real?'
