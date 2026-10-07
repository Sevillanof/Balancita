import type { TradingNavigationItem } from '../features/trading-view/presentation/ApprovedTradingHeader.tsx'

export type AppSection = 'terminal' | 'laboratorio'

/** One navigation for every dark-shell screen: Terminal, Laboratorio, Spot. */
export function appNavigation(current: AppSection): TradingNavigationItem[] {
  return [
    { href: '/terminal', label: 'Terminal', current: current === 'terminal' },
    {
      href: '/laboratorio',
      label: 'Laboratorio',
      current: current === 'laboratorio',
    },
    { href: '/', label: 'Spot' },
  ]
}
