export function formatShortDateTime(ms: number): {
  display: string
  search: string
} {
  const iso = new Date(ms).toISOString()
  const yyyy = iso.slice(0, 4)
  const mm = iso.slice(5, 7)
  const dd = iso.slice(8, 10)
  const hhmm = iso.slice(11, 16)
  return {
    display: `${dd}/${mm} ${hhmm}`,
    search: `${dd}/${mm}/${yyyy} ${yyyy}-${mm}-${dd} ${hhmm}`,
  }
}
