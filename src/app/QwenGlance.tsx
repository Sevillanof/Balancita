import { DecisionChips, DecisionHead } from './DecisionGlyphs.tsx'
import { decisionView } from './terminal-decision-view.ts'
import { signedUsd } from './qwen-trades-text.ts'
import { useQwenTrades } from './useQwenTrades.ts'
import { shortTime } from './terminal-labels.ts'

function held(entryMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - entryMs) / 60_000))
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
    : `${minutes} min`
}

/**
 * The whole panel in one look: the position (if any), what the formulas did at the
 * last look, and what Qwen thought of it. Words only where a picture would not do.
 */
export default function QwenGlance({
  product,
  latest,
  nowMs,
}: {
  product: string | undefined
  /** The newest analysis of this product, or null. */
  latest: Record<string, unknown> | null
  nowMs: number
}) {
  const { trades } = useQwenTrades(product, true)
  const open = trades.find((trade) => trade.open) ?? null
  const view = latest ? decisionView(latest) : null
  const long = open?.side === 'LONG'
  return (
    <section
      className="grid flex-none gap-2 border-b border-b-solid border-b-line px-3 py-2"
      aria-label="De un vistazo"
      data-testid="qwen-glance"
    >
      <p
        className={`m-0 flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1.5 text-body font-semibold ${
          open
            ? long
              ? 'bg-long/15 text-long'
              : 'bg-short/15 text-short'
            : 'bg-line text-ink-2'
        }`}
        data-testid="glance-position"
      >
        <span>
          {open
            ? `${long ? '▲ Posición larga' : '▼ Posición corta'} · ${held(open.entryMs, nowMs)}`
            : '○ Sin posición abierta'}
        </span>
        {open && <span>{signedUsd(open.netUsd)}</span>}
      </p>
      {view && latest ? (
        <div className="grid gap-1.5" data-testid="glance-last">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <DecisionHead view={view} />
            <small className="text-ink-2">
              último análisis {shortTime(latest.decision_time_ms)}
            </small>
          </div>
          <DecisionChips view={view} />
        </div>
      ) : (
        <small className="text-ink-2">Todavía sin análisis.</small>
      )}
    </section>
  )
}
