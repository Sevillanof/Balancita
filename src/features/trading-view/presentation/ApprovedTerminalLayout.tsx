import type { ReactNode } from 'react'

type ApprovedTerminalLayoutProps = {
  chart: ReactNode
  decisions: ReactNode
}

export default function ApprovedTerminalLayout({
  chart,
  decisions,
}: ApprovedTerminalLayoutProps) {
  return (
    <div
      className="grid grid-cols-terminal items-stretch gap-4 terminal-stack:grid-cols-1 terminal-wide:grid-cols-terminal-wide"
      data-testid="approved-terminal-layout"
    >
      {chart}
      {decisions}
    </div>
  )
}
