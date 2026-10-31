import { signedUsd } from '../../../app/qwen-trades-text.ts'
import { usd, utcDateTime } from '../../../shared/finance/format.ts'
import {
  layoutTradeLabels,
  tradeTone,
  type TradeCoordinates,
  type TradeLabelLayout,
  type TradeLabelRect,
  type TradeTone,
} from '../domain/terminal-trade-model.ts'

const COLORS: Record<TradeTone, string> = {
  gain: 'var(--color-long)',
  loss: 'var(--color-short)',
  neutral: 'var(--color-chart-text)',
  unknown: 'var(--color-chart-text)',
  provisional: 'var(--color-warn)',
}

function resultPoint(item: TradeCoordinates) {
  if (!item.resultVisible || item.resultX === null || item.resultY === null)
    return null
  return { x: item.resultX, y: item.resultY }
}

function LabelLeader({
  box,
  x,
  y,
  color,
}: {
  box: TradeLabelRect
  x: number
  y: number
  color: string
}) {
  const anchorX = Math.max(box.left + 8, Math.min(box.left + box.width - 8, x))
  const anchorY = y < box.top ? box.top : box.top + box.height
  return (
    <line
      x1={x}
      y1={y}
      x2={anchorX}
      y2={anchorY}
      stroke={color}
      strokeWidth={1}
      opacity={0.65}
    />
  )
}

function TradeSpanGlyph({
  layout,
  selected,
  confirmed,
}: {
  layout: TradeLabelLayout
  selected: boolean
  confirmed: boolean
}) {
  const { item, entry, result } = layout
  const tone = tradeTone(item.trade, confirmed)
  const point = resultPoint(item)
  const area = `M ${item.startX} ${item.entryY} ${item.area.map((point) => `L ${point.x} ${point.y}`).join(' ')} L ${item.endX} ${item.entryY} Z`
  return (
    <g>
      <path d={area} fill={COLORS[tone]} opacity={selected ? 0.12 : 0.04} />
      <line
        data-testid="trade-entry-line"
        data-trade-id={item.id}
        data-entry-ms={item.startMs}
        data-end-ms={item.endMs}
        data-entry-price={item.trade.entryPrice}
        x1={item.startX}
        x2={item.endX}
        y1={item.entryY}
        y2={item.entryY}
        stroke="var(--color-chart-info)"
        strokeWidth={selected ? 2.3 : 1.4}
        strokeDasharray={item.trade.open ? '7 5' : undefined}
        opacity={confirmed ? 0.95 : 0.45}
      />
      {item.entryVisible && (
        <>
          {entry && (
            <LabelLeader
              box={entry}
              x={item.entryX}
              y={item.entryY}
              color={
                item.trade.side === 'LONG'
                  ? 'var(--color-long)'
                  : 'var(--color-short)'
              }
            />
          )}
          <circle
            cx={item.entryX}
            cy={item.entryY}
            r={5}
            fill="var(--color-chart-info)"
          />
        </>
      )}
      {point && (
        <>
          {!item.trade.open && (
            <line
              x1={point.x}
              x2={point.x}
              y1={item.entryY}
              y2={point.y}
              stroke={COLORS[tone]}
              strokeDasharray="3 4"
            />
          )}
          {result && (
            <LabelLeader
              box={result}
              x={point.x}
              y={point.y}
              color={COLORS[tone]}
            />
          )}
        </>
      )}
    </g>
  )
}

function TradeBadges({
  layout,
  confirmed,
  onSelect,
}: {
  layout: TradeLabelLayout
  confirmed: boolean
  onSelect: (id: string) => void
}) {
  const { item, entry, result } = layout
  const tone = tradeTone(item.trade, confirmed)
  const long = item.trade.side === 'LONG'
  const directionClass = item.entryVisible
    ? long
      ? 'font-bold text-long'
      : 'font-bold text-short'
    : 'font-medium text-chart-text'
  const entryIcon = item.entryVisible ? (long ? '▲' : '▼') : '←'
  const point = resultPoint(item)
  const net = !confirmed
    ? 'Sin confirmar'
    : item.trade.netUsd === null
      ? '—'
      : signedUsd(item.trade.netUsd)
  const netTitle =
    item.trade.open && item.trade.markMs != null
      ? `Neto a la marca ${utcDateTime(item.trade.markMs)}`
      : 'Neto registrado al cierre'
  return (
    <div>
      {entry && (
        <button
          type="button"
          className={`pointer-events-auto absolute h-8 cursor-pointer rounded-lg border border-solid border-current/45 bg-surface-1 px-2.5 py-1 whitespace-nowrap ${item.entryVisible ? 'w-26 text-body' : 'w-35 text-label'} ${directionClass} focus-visible:outline-2 focus-visible:outline-info`}
          style={{ left: entry.left, top: entry.top }}
          aria-label={`${item.entryVisible ? 'Entrada' : 'Entrada anterior'} ${item.trade.side} operación ${item.trade.tradeNo}`}
          title={`${item.trade.side} · entrada ${usd(item.trade.entryPrice)} · ${utcDateTime(item.startMs)}`}
          onClick={() => onSelect(item.id)}
        >
          {entryIcon} {item.trade.side}
          {!item.entryVisible && <small> anterior</small>}
        </button>
      )}
      {point && (
        <button
          type="button"
          className={`pointer-events-auto absolute grid size-4 cursor-pointer place-items-center rounded-full p-0 leading-none ${item.trade.open ? 'border-0 bg-transparent text-label' : 'border border-solid border-current bg-surface-1 text-section'} focus-visible:outline-2 focus-visible:outline-info`}
          style={{ left: point.x - 8, top: point.y - 8, color: COLORS[tone] }}
          aria-label={`${item.trade.open ? 'Marca' : 'Cierre'} ${item.trade.side} operación ${item.trade.tradeNo}`}
          onClick={() => onSelect(item.id)}
        >
          {item.trade.open ? '●' : '×'}
        </button>
      )}
      {result && (
        <button
          type="button"
          className="pointer-events-auto absolute h-7.5 w-36 cursor-pointer rounded-lg border border-solid border-current/40 bg-surface-1 px-1.5 py-1.25 text-label font-bold whitespace-nowrap focus-visible:outline-2 focus-visible:outline-info"
          style={{ left: result.left, top: result.top, color: COLORS[tone] }}
          data-result-tone={tone}
          title={netTitle}
          aria-label={`Resultado ${item.trade.side} operación ${item.trade.tradeNo}: ${net}${tone === 'provisional' ? ', provisional' : ''}`}
          onClick={() => onSelect(item.id)}
        >
          {item.trade.open ? '●' : '×'} {net}
          {tone === 'provisional' && ' *'}
        </button>
      )}
    </div>
  )
}

export default function TerminalTradeOverlay({
  items,
  width,
  height,
  selectedId,
  confirmed,
  onSelect,
}: {
  items: readonly TradeCoordinates[]
  width: number
  height: number
  selectedId: string
  confirmed: boolean
  onSelect: (id: string) => void
}) {
  if (!(width > 0) || !(height > 0)) return null
  const layouts = layoutTradeLabels(items, width, height, selectedId)
  const grouped = layouts.reduce(
    (count, layout) =>
      count +
      Number(layout.entry === null) +
      Number(resultPoint(layout.item) !== null && layout.result === null),
    0,
  )
  return (
    <div
      className="pointer-events-none absolute top-0 left-0 z-3 overflow-hidden"
      style={{ width, height }}
      data-testid="terminal-trade-overlay"
    >
      <svg
        width={width}
        height={height}
        aria-hidden="true"
        className="absolute inset-0 overflow-hidden pointer-events-none"
      >
        {layouts.map((layout) => (
          <TradeSpanGlyph
            key={layout.item.id}
            layout={layout}
            selected={selectedId === layout.item.id}
            confirmed={confirmed}
          />
        ))}
      </svg>
      {layouts.map((layout) => (
        <TradeBadges
          key={layout.item.id}
          layout={layout}
          confirmed={confirmed}
          onSelect={onSelect}
        />
      ))}
      {grouped > 0 && (
        <p
          className="absolute bottom-1 left-1 m-0 rounded bg-surface-1 px-2 text-label text-ink-2"
          role="status"
        >
          {grouped} etiquetas agrupadas · elegí una operación debajo.
        </p>
      )}
    </div>
  )
}
