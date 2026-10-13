import type { NavigationItem } from '../shared/mission-control/index.ts'

export type AppSection = 'terminal' | 'estrategias' | 'observabilidad'

/** One navigation for every dark-shell screen: Terminal, Estrategias and Observabilidad. */
export function appNavigation(current: AppSection): NavigationItem[] {
  return [
    { href: '/terminal', label: 'Terminal', current: current === 'terminal' },
    {
      href: '/estrategias',
      label: 'Estrategias',
      current: current === 'estrategias',
    },
    {
      href: '/observabilidad',
      label: 'Observabilidad',
      current: current === 'observabilidad',
    },
  ]
}
