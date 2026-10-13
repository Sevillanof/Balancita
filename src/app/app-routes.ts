import type { AppSection } from './app-navigation.ts'

/**
 * Path to section. `/terminal` and `/estrategias` are explicit; any other path
 * (including `/`) still lands on the terminal, as before.
 */
export function sectionForPath(pathname: string): AppSection {
  const path = pathname.replace(/\/+$/, '')
  return path === '/estrategias' ? 'estrategias' : 'terminal'
}
