import { signedUsd } from '../../../app/qwen-trades-text.ts'
import type { LookDecision } from '../../../app/terminal-lifecycle.ts'
import {
  tradeTone,
  type TradeCoordinates,
  type TradeTone,
} from '../domain/terminal-trade-model.ts'
import DecisionIcons from './DecisionIcons.tsx'
import {
  CAP_MS,
  FICHA_HEIGHT,
  FICHA_WIDTH,
  moveFraction,
} from './trade-ficha-model.ts'

const TONE_COLOR: Record<TradeTone, string> = {
  gain: 'var(--color-long)',
  loss: 'var(--color-short)',
  neutral: 'var(--color-chart-text)',
  unknown: 'var(--color-chart-text)',
  provisional: 'var(--color-warn)',
}

function HoursRing({ fraction }: { fraction: number }) {
  const r = 9
  const clamped = Math.max(0.02, Math.min(1, fraction))
  const angle = clamped * 2 * Math.PI - Math.PI / 2
  const x = 11 + r * Math.cos(angle)
  const y = 11 + r * Math.sin(angle)
  return (
    <svg width="22" height="22" aria-hidden="true">
      <circle
        cx="11"
        cy="11"
        r={r}
        fill="none"
        stroke="var(--color-line-strong)"
        strokeWidth="3"
      />
      {clamped >= 1 ? (
        <circle
          cx="11"
          cy="11"
          r={r}
          fill="none"
          stroke="var(--color-chart-info)"
          strokeWidth="3"
        />
      ) : (
        <path
          d={`M 11 ${11 - r} A ${r} ${r} 0 ${clamped > 0.5 ? 1 : 0} 1 ${x.toFixed(2)} ${y.toFixed(2)}`}
          fill="none"
          stroke="var(--color-chart-info)"
          strokeWidth="3"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}

/**
 * The selected operation's data, drawn: its number and result, a ring of hours
 * open (out of the 36 h cap), the icons of what was decided when it entered and a
 * bar of how far the price went for or against it. It sits at the top edge of the
 * chart, above the entry, joined to it by a thin line, so it never covers candles.
 */
export default function TradeFicha({
  item,
  confirmed,
  steps,
  left,
}: {
  item: TradeCoordinates
  confirmed: boolean
  steps: readonly LookDecision[] | null
  left: number
}) {
  const { trade } = item
  const tone = tradeTone(trade, confirmed)
  const net = !confirmed
    ? 'Sin confirmar'
    : trade.netUsd === null
      ? '—'
      : signedUsd(trade.netUsd)
  const move = moveFraction(item)
  const long = trade.side === 'LONG'
  return (
    <section
      aria-label={`Datos de la operación ${trade.tradeNo}`}
      data-testid="trade-ficha"
      data-trade-id={item.id}
      className="pointer-events-auto absolute top-1.5 flex flex-col gap-2 rounded-lg border border-solid border-chart-info bg-surface-1 p-2 text-label shadow-lg"
      style={{ left, width: FICHA_WIDTH, height: FICHA_HEIGHT }}
    >
      <div className="flex items-center justify-between gap-2 font-bold">
        <span className={long ? 'text-long' : 'text-short'}>
          {long ? '▲' : '▼'} #{trade.tradeNo}
        </span>
        <span className="flex items-center gap-2">
          <span style={{ color: TONE_COLOR[tone] }}>
            {net}
            {tone === 'provisional' ? ' *' : ''}
          </span>
          <HoursRing fraction={(item.endMs - item.startMs) / CAP_MS} />
        </span>
      </div>
      {steps !== null && steps.length > 0 && <DecisionIcons steps={steps} />}
      {move !== null && (
        <svg
          width={FICHA_WIDTH - 18}
          height="12"
          role="img"
          aria-label="Cuánto fue el precio a favor o en contra desde la entrada"
          data-testid="trade-ficha-bar"
        >
          <rect
            x="0"
            y="3"
            width={FICHA_WIDTH - 18}
            height="6"
            rx="3"
            fill="var(--color-surface-2)"
          />
          <rect
            x={
              move >= 0
                ? (FICHA_WIDTH - 18) / 2
                : (FICHA_WIDTH - 18) / 2 + move * ((FICHA_WIDTH - 18) / 2)
            }
            y="3"
            width={Math.abs(move) * ((FICHA_WIDTH - 18) / 2)}
            height="6"
            rx="3"
            fill={move >= 0 ? 'var(--color-long)' : 'var(--color-short)'}
          />
          <line
            x1={(FICHA_WIDTH - 18) / 2}
            x2={(FICHA_WIDTH - 18) / 2}
            y1="0"
            y2="12"
            stroke="var(--color-ink-2)"
          />
        </svg>
      )}
    </section>
  )
}
