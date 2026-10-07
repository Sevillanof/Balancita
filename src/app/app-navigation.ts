import type { TradingNavigationItem } from '../features/trading-view/presentation/ApprovedTradingHeader.tsx'

export type AppSection = 'terminal' | 'estrategias'

/** One navigation for every dark-shell screen: Terminal and Estrategias. */
export function appNavigation(current: AppSection): TradingNavigationItem[] {
  return [
    { href: '/terminal', label: 'Terminal', current: current === 'terminal' },
    {
      href: '/estrategias',
      label: 'Estrategias',
      current: current === 'estrategias',
    },
  ]
}
