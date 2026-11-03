import { currency, utcDateTime } from '../../../shared/finance/format.ts'
import type { ApprovedTerminalCandle } from './ApprovedTerminalChart.tsx'

export interface HoverEntry {
  tradeNo: number
  side: 'LONG' | 'SHORT'
  price: number
}

const GLYPH_H = 64
const GLYPH_W = 26

function CandleGlyph({ candle }: { candle: ApprovedTerminalCandle }) {
  const span = candle.high - candle.low
  const at = (price: number) =>
    span > 0 ? 4 + ((candle.high - price) / span) * (GLYPH_H - 8) : GLYPH_H / 2
  const up = candle.close >= candle.open
  const color = up ? 'var(--color-long)' : 'var(--color-short)'
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
 * What the pointer is over, drawn rather than listed: the candle itself, how far
 * it moved, how much was traded compared with the busiest candle in view, and
 * the operations that entered in it.
 */
export default function CandleHoverCard({
  candle,
  previousClose,
  volumeMax,
  entries,
  align,
}: {
  candle: ApprovedTerminalCandle
  previousClose: number
  volumeMax: number
  entries: readonly HoverEntry[]
  align: 'start' | 'middle'
}) {
  const change =
    previousClose > 0
      ? ((candle.close - previousClose) / previousClose) * 100
      : 0
  const up = change >= 0
  const volumeShare =
    volumeMax > 0 ? Math.max(0.02, Math.min(1, candle.volume / volumeMax)) : 0
  const rows: Array<[string, number]> = [
    ['Abre', candle.open],
    ['Máx', candle.high],
    ['Mín', candle.low],
    ['Cierra', candle.close],
  ]
  return (
    <div
      data-testid="candle-hover-card"
      role="status"
      style={align === 'middle' ? { left: '42%' } : undefined}
      className={`pointer-events-none absolute top-2 z-4 w-48 rounded-lg border border-solid border-line bg-surface-1 p-2 text-label shadow-lg ${align === 'start' ? 'left-2' : ''}`}
    >
      <div className="mb-1.5 text-ink-2">{utcDateTime(candle.time * 1000)}</div>
      <div className="flex gap-2.5">
        <CandleGlyph candle={candle} />
        <dl className="m-0 flex flex-1 flex-col gap-0.5 tabular-nums">
          {rows.map(([name, price]) => (
            <div key={name} className="flex justify-between gap-2">
              <dt className="text-ink-2">{name}</dt>
              <dd className="m-0 text-right">{currency(price, 'USD')}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div
        className={`mt-1.5 font-bold tabular-nums ${up ? 'text-long' : 'text-short'}`}
      >
        {up ? '▲' : '▼'} {up ? '+' : ''}
        {change.toFixed(2).replace('.', ',')} %
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-ink-2">Volumen</span>
        <span
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"
          aria-hidden="true"
        >
          <span
            className="block h-full rounded-full bg-chart-info"
            style={{ width: `${Math.round(volumeShare * 100)}%` }}
          />
        </span>
      </div>
      {entries.length > 0 && (
        <ul className="m-0 mt-1.5 flex list-none flex-col gap-0.5 p-0">
          {entries.map((entry) => (
            <li
              key={entry.tradeNo}
              className={`font-bold ${entry.side === 'LONG' ? 'text-long' : 'text-short'}`}
            >
              {entry.side === 'LONG' ? '▲' : '▼'} Entrada #{entry.tradeNo} ·{' '}
              {currency(entry.price, 'USD')}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
