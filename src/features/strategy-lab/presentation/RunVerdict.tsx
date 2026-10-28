import { signedAmount } from '../domain/strategy-format.ts'
import type { RunTrade } from '../infrastructure/run-visual-api.ts'

type Props = {
  trades: RunTrade[]
  /** Closes of the whole stretch, oldest first: the price of buying at the start and holding. */
  closes: number[]
  product: string
}

/** The answer first: does it win after costs, and against holding the product. */
export default function RunVerdict({ trades, closes, product }: Props) {
  if (trades.length === 0) return null
  const notional = Number(trades.find((t) => t.notional_usd)?.notional_usd) || 0
  const net = trades.reduce((sum, t) => sum + t.net_bp, 0)
  const first = closes[0]
  const last = closes[closes.length - 1]
  const held = first && last && first > 0 ? (last / first - 1) * 1e4 : null
  const text = (bp: number) =>
    notional > 0
      ? `${signedAmount((bp / 1e4) * notional, 2) ?? '0,00'} USD`
      : `${signedAmount(bp, 0) ?? '0'} pb`
  const wins = net >= 0
  const coin = product.replace(/^PF_|USD$/g, '')
  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-solid border-line bg-canvas px-4 py-3.5"
      data-testid="run-verdict"
    >
      <strong
        data-testid="run-verdict-total"
        className={`text-run-value leading-none tabular-nums ${wins ? 'text-long' : 'text-short'}`}
      >
        {text(net)}
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
