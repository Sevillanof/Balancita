import { amount } from '../../../shared/finance/format.ts'
import { signedAmount } from './strategy-format.ts'

/** `+12,3 pb`; `—` when the datum does not exist. */
export function bpText(value: number | null | undefined, digits = 1): string {
  const text = signedAmount(value ?? null, digits)
  return text === null ? '—' : `${text} pb`
}

/** A share 0..1 as `53 %`. */
export function shareText(value: number | null | undefined): string {
  return value == null ? '—' : `${amount(value * 100, 0)} %`
}

export function perDayText(value: number | null | undefined): string {
  return value == null ? '—' : amount(value, 1)
}

const MONTHS = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
]

/** `2026-04-19T00:00:00Z` → `19-abr-2026` (UTC day). */
export function dayText(iso: string | null | undefined): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '')
  if (!match) return '—'
  return `${Number(match[3])}-${MONTHS[Number(match[2]) - 1]}-${match[1]}`
}

/** Seconds left as a rough phrase: `menos de 1 min`, `unos 4 min`, `unas 2 h`. */
export function etaText(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds < 0) return null
  if (seconds < 60) return 'menos de 1 min'
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `unos ${minutes} min`
  return `unas ${Math.round(minutes / 60)} h`
}

/** The commands inside «…» in the server's install message; the whole text when there are none. */
export function installCommands(reason: string): string[] {
  const found = [...reason.matchAll(/«([^»]+)»/g)].map((match) => match[1]!)
  return found.length > 0 ? found : [reason]
}
