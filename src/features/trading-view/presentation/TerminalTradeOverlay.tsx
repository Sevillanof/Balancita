import { signedUsd } from '../../../app/qwen-trades-text.ts'
import { usd, utcDateTime } from '../../../shared/finance/format.ts'
import { usePhoneChart } from './phone-chart-context.ts'
import TradeFicha from './TradeFicha.tsx'
import { FICHA_HEIGHT, FICHA_WIDTH } from './trade-ficha-model.ts'
import type { LookDecision } from '../../../app/terminal-lifecycle.ts'
import {
  layoutTradeLabels,
  tradePillWidth,
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
  return (
    <line
      x1={x}
      y1={y}
      x2={box.left}
      y2={box.top + 13}
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
  const { item, entry } = layout
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
        strokeWidth={selected ? 2.3 : 1.2}
        strokeDasharray={item.trade.open ? '7 5' : undefined}
        opacity={confirmed ? (selected ? 0.95 : 0.55) : 0.4}
      />
      {entry && (
        <LabelLeader
          box={entry}
          x={item.endX}
          y={item.entryY}
          color={
            item.trade.side === 'LONG'
              ? 'var(--color-long)'
              : 'var(--color-short)'
          }
        />
      )}
      {item.entryVisible && (
        <>
          <circle
            data-testid="trade-entry-dot"
            cx={item.entryX}
            cy={item.entryY}
            r={selected ? 7 : 5.5}
            fill="var(--color-chart-info)"
            stroke="var(--color-ink)"
            strokeWidth={2}
          />
          <text
            x={item.entryX + 10}
            y={item.entryY - 9}
            fill="var(--color-ink)"
            stroke="var(--color-chart-surface)"
            strokeWidth={3}
            paintOrder="stroke"
            fontSize={11}
            fontWeight={700}
          >
            {item.trade.side === 'LONG' ? '▲' : '▼'} #{item.trade.tradeNo}
          </text>
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
        </>
      )}
    </g>
  )
}

function TradeBadges({
  layout,
  selected,
  confirmed,
  onSelect,
}: {
  layout: TradeLabelLayout
  selected: boolean
  confirmed: boolean
  onSelect: (id: string) => void
}) {
  const { item, entry } = layout
  const tone = tradeTone(item.trade, confirmed)
  const long = item.trade.side === 'LONG'
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
  const provisional = tone === 'provisional' ? ' *' : ''
  return (
    <div>
      {entry && (
        <button
          type="button"
          className={`pointer-events-auto absolute flex cursor-pointer flex-col justify-center gap-0.5 rounded-lg border border-solid bg-surface-1 px-2 text-left text-label whitespace-nowrap focus-visible:outline-2 focus-visible:outline-info ${selected ? 'border-chart-info' : 'border-current/45'} ${long ? 'text-long' : 'text-short'}`}
          style={{
            left: entry.left,
            top: entry.top,
            width: entry.width,
            height: entry.height,
          }}
          data-result-tone={tone}
          aria-pressed={selected}
          aria-label={`${item.entryVisible ? 'Entrada' : 'Entrada anterior'} ${item.trade.side} operación ${item.trade.tradeNo}: ${net}${tone === 'provisional' ? ', provisional' : ''}`}
          title={`${item.trade.side} · entrada ${usd(item.trade.entryPrice)} · ${utcDateTime(item.startMs)} · ${netTitle}`}
          onClick={() => onSelect(item.id)}
        >
          <span className="flex items-baseline gap-1.5 font-bold">
            <span>
              {entryIcon} #{item.trade.tradeNo}
            </span>
            <span style={{ color: COLORS[tone] }}>
              {net}
              {provisional}
            </span>
          </span>
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
  decisionsFor,
}: {
  items: readonly TradeCoordinates[]
  width: number
  height: number
  selectedId: string
  confirmed: boolean
  onSelect: (id: string) => void
  /** What was decided when an operation entered (icons of its ficha). */
  decisionsFor?: (entryMs: number) => readonly LookDecision[] | null
}) {
  const phone = usePhoneChart()
  if (!(width > 0) || !(height > 0)) return null
  const layouts = layoutTradeLabels(items, width, height)
  const grouped = layouts.reduce(
    (count, layout) => count + Number(layout.entry === null),
    0,
  )
  const selected = items.find((item) => item.id === selectedId) ?? null
  // The ficha sits at the top edge above the entry, clear of the label column.
  const fichaLeft = selected
    ? Math.max(
        4,
        Math.min(
          width - tradePillWidth(width) - FICHA_WIDTH - 12,
          (selected.entryVisible ? selected.entryX : 4 + FICHA_WIDTH / 2) -
            FICHA_WIDTH / 2,
        ),
      )
    : 0
  const showFicha = !phone && selected !== null && width >= FICHA_WIDTH + 8
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
        {showFicha && selected.entryVisible && (
          <line
            data-testid="trade-ficha-leader"
            x1={Math.max(
              fichaLeft + 14,
              Math.min(fichaLeft + FICHA_WIDTH - 14, selected.entryX),
            )}
            y1={6 + FICHA_HEIGHT}
            x2={selected.entryX}
            y2={selected.entryY - 8}
            stroke="var(--color-chart-info)"
            strokeWidth={1.2}
            opacity={0.8}
          />
        )}
      </svg>
      {showFicha && (
        <TradeFicha
          item={selected}
          confirmed={confirmed}
          left={fichaLeft}
          steps={decisionsFor?.(selected.startMs) ?? null}
        />
      )}
      {layouts.map((layout) => (
        <TradeBadges
          key={layout.item.id}
          layout={layout}
          selected={selectedId === layout.item.id}
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
