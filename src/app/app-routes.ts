import type { AppSection } from './app-navigation.ts'

/**
 * Path to section. `/terminal`, `/estrategias` and `/observabilidad` are explicit; any other path
 * (including `/`) still lands on the terminal, as before.
 */
export function sectionForPath(pathname: string): AppSection {
  const path = pathname.replace(/\/+$/, '')
  if (path === '/estrategias') return 'estrategias'
  if (path === '/observabilidad') return 'observabilidad'
  return 'terminal'
}
