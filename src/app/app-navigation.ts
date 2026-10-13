import type { NavigationItem } from '../shared/mission-control/index.ts'

export type AppSection = 'terminal' | 'estrategias'

/** One navigation for every dark-shell screen: Terminal and Estrategias. */
export function appNavigation(current: AppSection): NavigationItem[] {
  return [
    { href: '/terminal', label: 'Terminal', current: current === 'terminal' },
    {
      href: '/estrategias',
      label: 'Estrategias',
      current: current === 'estrategias',
    },
  ]
}
