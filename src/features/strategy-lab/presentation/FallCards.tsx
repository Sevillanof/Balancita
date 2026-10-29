import { signedAmount } from '../domain/strategy-format.ts'
import type { RunTrade } from '../infrastructure/run-visual-api.ts'

const W = 180
const H = 64
const PAD = 4

const WHEN = new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid',
  day: 'numeric',
  month: 'short',
  year: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
})

type Props = {
  trades: RunTrade[]
  selected: RunTrade | null
  onSelect: (trade: RunTrade) => void
}

/** The little chart of one fall: the price, the fall in amber, the stretch held in green (won) or red (lost). */
function Spark({ trade }: { trade: RunTrade }) {
  const points = trade.detail ?? []
  const drop = trade.drop
  if (points.length < 2 || !drop) return null
  const lo = points[0]![0]
  const hi = points[points.length - 1]![0]
  const values = points.map((p) => p[1])
  const vLo = Math.min(...values)
  const vHi = Math.max(...values)
  const x = (t: number) =>
    PAD + ((t - lo) / Math.max(hi - lo, 1)) * (W - 2 * PAD)
  const y = (v: number) =>
    PAD + (vHi === vLo ? 0.5 : (vHi - v) / (vHi - vLo)) * (H - 2 * PAD)
  const path = (from: number, to: number) =>
    points
      .filter(([t]) => t >= from && t <= to)
      .map(
        ([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)} ${y(v).toFixed(1)}`,
      )
      .join(' ')
  const entry = points.reduce((best, p) =>
    Math.abs(p[0] - trade.entry_time_ms) <
    Math.abs(best[0] - trade.entry_time_ms)
      ? p
      : best,
  )
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-hidden="true">
      <path
        d={path(lo, hi)}
        fill="none"
        className="stroke-ink-3"
        strokeWidth={1}
      />
      <path
        d={path(trade.entry_time_ms, trade.exit_time_ms)}
        fill="none"
        className={trade.net_bp >= 0 ? 'stroke-long' : 'stroke-short'}
        strokeWidth={1.8}
      />
      <path
        d={path(drop.from_ms, drop.to_ms)}
        fill="none"
        className="stroke-warn"
        strokeWidth={2.6}
        strokeLinecap="round"
      />
      <circle cx={x(entry[0])} cy={y(entry[1])} r={3} className="fill-ink" />
    </svg>
  )
}

/**
 * Every fall that fired an entry and what the price did after it, one small chart each: amber is the fall, green or red is
 * the stretch held. Tapping a card opens that operation on the chart above.
 */
export default function FallCards({ trades, selected, onSelect }: Props) {
  const falls = trades.filter((t) => t.drop && (t.detail?.length ?? 0) > 1)
  if (falls.length === 0) return null
  return (
    <div className="grid gap-1.5" data-testid="fall-cards">
      <div className="flex flex-wrap justify-between gap-2 text-label tracking-section text-ink-2 uppercase">
        <span>Cada caída y su rebote</span>
        <span className="tracking-normal normal-case">
          <span className="text-warn">━ caída</span> · ━ lo que duró la
          operación · tocá una para verla arriba
        </span>
      </div>
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: 'repeat(auto-fill, minmax(11rem, 1fr))',
        }}
      >
        {falls.map((trade) => {
          const on = trade.trade_id === selected?.trade_id
          const win = trade.net_bp >= 0
          return (
            <button
              key={trade.trade_id}
              type="button"
              aria-pressed={on}
              aria-label={`Caída ${signedAmount(trade.drop!.pct, 1)} % · ${WHEN.format(trade.drop!.to_ms)} · ${signedAmount(trade.net_bp, 0)} pb`}
              onClick={() => onSelect(trade)}
              className={`grid cursor-pointer content-start gap-1 rounded-lg border border-solid bg-canvas p-2 text-left text-hint text-ink ${on ? 'border-ink' : 'border-line'}`}
            >
              <Spark trade={trade} />
              <span className="text-ink-2">
                {WHEN.format(trade.drop!.to_ms)}
              </span>
              <span className="flex flex-wrap items-baseline justify-between gap-1 tabular-nums">
                <b className="font-medium text-warn">
                  {signedAmount(trade.drop!.pct, 1)} % en 1 h
                </b>
                <b
                  className={`font-medium ${win ? 'text-long' : 'text-short'}`}
                >
                  {signedAmount(trade.pnl_usd, 2) ??
                    signedAmount(trade.net_bp, 0)}{' '}
                  {trade.pnl_usd !== null ? 'USD' : 'pb'}
                </b>
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
