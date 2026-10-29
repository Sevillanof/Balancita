import { signedAmount } from '../domain/strategy-format.ts'
import type { RunTrade } from '../infrastructure/run-visual-api.ts'
import { productName } from '../../trading-view/domain/product-label.ts'

type Props = {
  trades: RunTrade[]
  /** Closes of the whole stretch, oldest first: the price of buying at the start and holding. */
  closes: number[]
  product: string
  /** The account the trades started from, when each one used the whole account (then the USD figures follow it). */
  accountUsd?: number | null
}

/** The answer first: does it win after costs, and against holding the product. */
export default function RunVerdict({
  trades,
  closes,
  product,
  accountUsd,
}: Props) {
  if (trades.length === 0) return null
  const notional =
    accountUsd ??
    (Number(trades.find((t) => t.notional_usd)?.notional_usd) || 0)
  const net = trades.reduce((sum, t) => sum + t.net_bp, 0)
  // Each operation can have its own size (the whole account): then the total is what they made, not bp times one size
  const made = accountUsd
    ? trades.reduce((sum, t) => sum + (t.pnl_usd ?? 0), 0)
    : null
  const first = closes[0]
  const last = closes[closes.length - 1]
  const held = first && last && first > 0 ? (last / first - 1) * 1e4 : null
  const text = (bp: number) =>
    notional > 0
      ? `${signedAmount((bp / 1e4) * notional, 2) ?? '0,00'} USD`
      : `${signedAmount(bp, 0) ?? '0'} pb`
  const wins = (made ?? net) >= 0
  const coin = productName(product)
  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-solid border-line bg-canvas px-4 py-3.5"
      data-testid="run-verdict"
    >
      <strong
        data-testid="run-verdict-total"
        className={`text-run-value leading-none tabular-nums ${wins ? 'text-long' : 'text-short'}`}
      >
        {made !== null ? `${signedAmount(made, 2) ?? '0,00'} USD` : text(net)}
      </strong>
      <div className="grid gap-0.5">
        <span className="text-title font-semibold text-ink">
          {wins ? 'Gana tras costos' : 'Pierde tras costos'}
        </span>
        <span className="text-note text-ink-2">
          {trades.length} operaciones
          {held !== null && ` · mantener ${coin} daría ${text(held)}`}
        </span>
      </div>
    </div>
  )
}
