const parts = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** `30/10 14:05` (and the same in searchable forms) in Europe/Madrid, from epoch milliseconds. */
export function formatShortDateTime(ms: number): {
  display: string
  search: string
} {
  const part = Object.fromEntries(
    parts.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  )
  const { year: yyyy, month: mm, day: dd, hour, minute } = part
  const hhmm = `${hour}:${minute}`
  return {
    display: `${dd}/${mm} ${hhmm}`,
    search: `${dd}/${mm}/${yyyy} ${yyyy}-${mm}-${dd} ${hhmm}`,
  }
}
