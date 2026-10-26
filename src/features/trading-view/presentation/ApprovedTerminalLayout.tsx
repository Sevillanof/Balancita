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
      className="grid grid-cols-terminal items-start gap-4 terminal-stack:grid-cols-1 terminal-wide:grid-cols-terminal-wide terminal-wide:terminal-last:sticky! terminal-wide:terminal-last:top-4!"
      data-testid="approved-terminal-layout"
    >
      {chart}
      {decisions}
    </div>
  )
}
