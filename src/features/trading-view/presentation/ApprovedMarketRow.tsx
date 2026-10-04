import type { ReactNode } from 'react'

type ApprovedMarketRowProps = {
  identity: ReactNode
  quote: ReactNode
  context: ReactNode
}

export default function ApprovedMarketRow({
  identity,
  quote,
  context,
}: ApprovedMarketRowProps) {
  return (
    <section
      className="demo-terminal__market"
      data-testid="approved-market-row"
      aria-label="Mercado BTC-EUR"
    >
      {identity}
      {quote}
      {context}
    </section>
  )
}
