import { DecisionChips, DecisionHead } from './DecisionGlyphs.tsx'
import { decisionView } from './terminal-decision-view.ts'
import { signedUsd } from './qwen-trades-text.ts'
import { useQwenTrades } from './useQwenTrades.ts'
import { analysisReason, shortTime } from './terminal-labels.ts'

function held(entryMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - entryMs) / 60_000))
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
    : `${minutes} min`
}

/**
 * Top block of the right-hand "Operaciones" panel:
 * 1. Operación abierta
 * 2. Decisiones de Maestro, Portero, Noticias
 * 3. Breve descripción visual de la última decisión
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
  const briefReason = latest ? (view?.motivo ?? analysisReason(latest)) : null
  return (
    <section
      className="grid flex-none gap-1.5 border-b border-b-solid border-b-line px-3 py-2"
      aria-label="De un vistazo"
      data-testid="qwen-glance"
    >
      <div
        className={`m-0 flex flex-wrap items-center justify-between gap-2 rounded-md px-2 py-1 text-hint font-semibold ${
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
            ? `Operación abierta: ${long ? '▲ Posición larga' : '▼ Posición corta'} · ${held(open.entryMs, nowMs)}`
            : 'Operación abierta: ○ Sin posición abierta'}
        </span>
        {open && <span>{signedUsd(open.netUsd)}</span>}
      </div>
      {view && latest ? (
        <div className="grid gap-1" data-testid="glance-last">
          <DecisionChips view={view} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5 min-w-0">
              <DecisionHead view={view} />
              {briefReason && (
                <small className="text-ink-2 truncate">{briefReason}</small>
              )}
            </div>
            <small className="text-ink-2 shrink-0">
              {shortTime(latest.decision_time_ms)}
            </small>
          </div>
        </div>
      ) : (
        <small className="text-ink-2">Todavía sin análisis.</small>
      )}
    </section>
  )
}
