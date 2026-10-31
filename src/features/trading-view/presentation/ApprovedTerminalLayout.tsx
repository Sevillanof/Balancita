import type { ReactNode } from 'react'

type ApprovedTerminalLayoutProps = {
  chart: ReactNode
  decisions: ReactNode
  tradeLayout?: boolean
}

export default function ApprovedTerminalLayout({
  chart,
  decisions,
  tradeLayout = false,
}: ApprovedTerminalLayoutProps) {
  return (
    <div
      className={
        tradeLayout
          ? 'grid min-h-0 flex-1 grid-cols-1 grid-rows-layout-stack gap-2 from-700:grid-cols-layout-side from-700:grid-rows-layout-fill phone-short:grid-rows-layout-stack-short'
          : 'grid grid-cols-terminal items-stretch gap-4 terminal-stack:grid-cols-1 terminal-wide:grid-cols-terminal-wide'
      }
      data-testid="approved-terminal-layout"
    >
      {chart}
      {decisions}
    </div>
  )
}
