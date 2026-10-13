import { utcDateTime } from '../../../shared/finance/format.ts'

/** `2 min`, `3 h 5 min`, `45 s`: a duration, never a judgement about it. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 48) return rest ? `${hours} h ${rest} min` : `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/**
 * A moment in UTC and how long before the report was written. The age is taken
 * against the server's own clock (`generated_at_ms`), so a skewed browser clock
 * cannot make old data look fresh.
 */
export function momentLabel(ms: number | null, reference: number): string {
  if (ms === null) return 'Sin datos'
  return `${utcDateTime(ms)} · hace ${duration(reference - ms)}`
}

export function shortProduct(product: string): string {
  return product.replace(/^PF_/, '').replace(/USD$/, '')
}

export const SIDE_LABELS: Record<string, string> = {
  LONG: 'Largo',
  SHORT: 'Corto',
}

export function sideLabel(side: string | null): string {
  return side === null ? 'Sin datos' : (SIDE_LABELS[side] ?? side)
}
