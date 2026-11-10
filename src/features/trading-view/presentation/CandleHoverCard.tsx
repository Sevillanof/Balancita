import { madridDateTime } from '../../../shared/finance/format.ts'
import type { LookDecision } from '../../../app/terminal-lifecycle.ts'
import type { ApprovedTerminalCandle } from './ApprovedTerminalChart.tsx'
import DecisionIcons from './DecisionIcons.tsx'

export interface HoverEntry {
  tradeNo: number
  side: 'LONG' | 'SHORT'
}

export interface HoverSpot {
  time: number
  /** Pixels of the candle's centre, of its high and of its low, inside the chart pane. */
  x: number
  highY: number
  lowY: number
}

const GLYPH_H = 52
const GLYPH_W = 22
const CARD_W = 132
const CARD_H = 82
const STRIP_H = 32
const GAP = 10

function CandleGlyph({ candle }: { candle: ApprovedTerminalCandle }) {
  const span = candle.high - candle.low
  const at = (price: number) =>
    span > 0 ? 3 + ((candle.high - price) / span) * (GLYPH_H - 6) : GLYPH_H / 2
  const color =
    candle.close >= candle.open ? 'var(--color-long)' : 'var(--color-short)'
  const top = at(Math.max(candle.open, candle.close))
  const bottom = at(Math.min(candle.open, candle.close))
  return (
    <svg
      width={GLYPH_W}
      height={GLYPH_H}
      aria-hidden="true"
      className="flex-none"
    >
      <line
        x1={GLYPH_W / 2}
        x2={GLYPH_W / 2}
        y1={at(candle.high)}
        y2={at(candle.low)}
        stroke={color}
        strokeWidth={2}
      />
      <rect
        x={4}
        width={GLYPH_W - 8}
        y={top}
        height={Math.max(2, bottom - top)}
        rx={1.5}
        fill={color}
      />
    </svg>
  )
}

/**
 * What the pointer is over, drawn and pinned to that candle: a strip with the
 * icons of that look's decisions right above it, and over the strip a small card
 * with the candle drawn, how far it moved and how much was traded next to the
 * busiest candle in view. It flips below the candle when there is no room above.
 */
export default function CandleHoverCard({
  candle,
  spot,
  previousClose,
  volumeMax,
  steps,
  entries,
  plotWidth,
  onHold,
}: {
  candle: ApprovedTerminalCandle
  spot: HoverSpot
  previousClose: number
  volumeMax: number
  steps: readonly LookDecision[] | null
  entries: readonly HoverEntry[]
  plotWidth: number
  onHold: (held: boolean) => void
}) {
  const change =
    previousClose > 0
      ? ((candle.close - previousClose) / previousClose) * 100
      : 0
  const up = change >= 0
  const volumeShare =
    volumeMax > 0 ? Math.max(0.03, Math.min(1, candle.volume / volumeMax)) : 0
  const hasStrip = steps !== null && steps.length > 0
  const stripW = hasStrip ? steps.length * 28 + 4 : 0
  const blockH = CARD_H + (hasStrip ? STRIP_H + 6 : 0)
  const above = spot.highY - GAP - blockH >= 4
  const top = above ? spot.highY - GAP - blockH : spot.lowY + GAP
  const clamp = (width: number) =>
    Math.max(4, Math.min(plotWidth - width - 4, spot.x - width / 2))
  const cardLeft = clamp(CARD_W)
  const stripLeft = clamp(stripW)
  const cardTop = above ? top : top + (hasStrip ? STRIP_H + 6 : 0)
  const stripTop = above ? top + CARD_H + 6 : top
  return (
    <div
      className="pointer-events-none absolute inset-0 z-4"
      data-testid="candle-hover-card"
      data-placement={above ? 'above' : 'below'}
    >
      <div
        role="status"
        className="absolute rounded-lg border border-solid border-line bg-surface-1 p-2 text-label shadow-lg"
        style={{
          left: cardLeft,
          top: cardTop,
          width: CARD_W,
          height: CARD_H,
        }}
      >
        <div className="flex gap-2.5">
          <CandleGlyph candle={candle} />
          <div className="flex min-w-0 flex-1 flex-col justify-between">
            <strong
              className={`tabular-nums ${up ? 'text-long' : 'text-short'}`}
            >
              {up ? '▲ +' : '▼ '}
              {change.toFixed(2).replace('.', ',')} %
            </strong>
            <span
              className="block h-1.5 overflow-hidden rounded-full bg-surface-2"
              aria-label="Volumen frente a la vela más activa a la vista"
            >
              <span
                className="block h-full rounded-full bg-chart-info"
                style={{ width: `${Math.round(volumeShare * 100)}%` }}
              />
            </span>
            <small className="text-ink-2">
              {madridDateTime(candle.time * 1000)}
            </small>
          </div>
        </div>
        {entries.length > 0 && (
          <div className="mt-1 flex gap-1.5 font-bold">
            {entries.map((entry) => (
              <span
                key={entry.tradeNo}
                className={entry.side === 'LONG' ? 'text-long' : 'text-short'}
              >
                {entry.side === 'LONG' ? '▲' : '▼'} #{entry.tradeNo}
              </span>
            ))}
          </div>
        )}
      </div>
      {hasStrip && (
        <div
          className="absolute rounded-full border border-solid border-line bg-surface-1 px-0.5 py-0.5 shadow-lg"
          style={{ left: stripLeft, top: stripTop, width: stripW }}
        >
          <DecisionIcons steps={steps} onHold={onHold} />
        </div>
      )}
      <span
        aria-hidden="true"
        className="absolute size-2 rotate-45 border border-solid border-line bg-surface-1"
        style={{
          left: spot.x - 4,
          top: above ? top + blockH - 2 : top - 4,
        }}
      />
    </div>
  )
}
