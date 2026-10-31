import { useState } from 'react'
import { formatShortDateTime } from './terminal-date.ts'
import type {
  NewsDirection,
  NewsRelevance,
  NewsSource,
  TerminalNewsItem,
} from './useTerminalNews.ts'

const PAGE_SIZE = 3
const COMPACT_BTN =
  'min-h-6 cursor-pointer rounded-sm border border-solid border-line bg-surface-1 px-2 py-0.5 text-hint text-ink enabled:hover:border-warn disabled:cursor-not-allowed disabled:opacity-50'

const RELEVANCE_LABEL: Record<NewsRelevance, string> = {
  high: 'Alta',
  medium: 'Media',
  low: 'Baja',
  none: 'Nula',
}

const RELEVANCE_STYLE: Record<NewsRelevance, string> = {
  high: 'bg-warn/15 text-warn',
  medium: 'bg-info/15 text-info',
  low: 'bg-info/15 text-info',
  none: 'bg-line text-ink-2',
}

const DIRECTION_LABEL: Record<NewsDirection, string> = {
  bullish: '▲ alcista',
  bearish: '▼ bajista',
  neutral: '• neutral',
}

function matchesNewsQuery(item: TerminalNewsItem, needle: string): boolean {
  const ts = item.publishedAtMs ?? item.receivedAtMs
  const dt = formatShortDateTime(ts)
  const relLabel = item.relevance
    ? RELEVANCE_LABEL[item.relevance]
    : 'Pendiente'
  const dirLabel = item.direction ? DIRECTION_LABEL[item.direction] : ''
  const haystack = [
    dt.display,
    dt.search,
    item.title,
    item.source,
    relLabel,
    item.relevance,
    dirLabel,
  ]
    .join(' ')
    .toLowerCase()
  return needle
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => haystack.includes(part))
}

function lifecycleLabel(
  item: TerminalNewsItem,
  nowMs: number | undefined,
): string {
  if (item.analysisStatus === 'pending') return 'Pendiente'
  if (item.analysisStatus === 'partial') return 'Análisis incompleto'
  if (item.analysisStatus === 'failed') return 'Análisis fallido'
  if (item.analysisStatus === 'stale') return 'Descartada por antigüedad'
  if (item.eligibility === 'used') return 'Ya usada'
  if (
    item.expiresAtMs != null &&
    nowMs !== undefined &&
    nowMs >= item.expiresAtMs
  )
    return 'Vencida'
  if (nowMs === undefined) return 'Vigencia sin confirmar'
  if (item.eligibility === 'eligible') return 'Señal habilitada'
  if (item.eligibility === 'conflict') return 'Noticias contradictorias'
  if (item.eligibility === 'rejected') return 'No habilita una operación'
  if (item.eligibility === 'legacy') return 'Flujo clásico'
  return 'Vigencia sin confirmar'
}

export default function TerminalNewsPanel({
  items,
  loaded = true,
  nowMs,
  source,
}: {
  items: readonly TerminalNewsItem[]
  loaded?: boolean
  nowMs?: number
  source?: NewsSource
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const needle = query.trim().toLowerCase()
  const filtered = needle
    ? items.filter((item) => matchesNewsQuery(item, needle))
    : items
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const paged = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  return (
    <section
      className="flex flex-col gap-1.5"
      aria-label="Últimas noticias"
      data-testid="terminal-news-panel"
    >
      {source && (source.state === 'error' || source.state === 'off') && (
        <p
          className="m-0 text-hint text-warn"
          role="status"
          title={source.reason}
        >
          No se pueden confirmar las noticias.{' '}
          {items.length > 0 ? 'Último dato, sin confirmar.' : ''}
        </p>
      )}
      {source?.state === 'ok' && source.collectorStatus !== 'ok' && (
        <p
          className="m-0 text-hint text-warn"
          role="status"
          title={source.collectorReason ?? undefined}
        >
          {source.collectorStatus === 'warning'
            ? 'El colector de noticias tiene fuentes atrasadas o con errores.'
            : 'Estado del colector de noticias sin confirmar.'}
        </p>
      )}
      {source?.state === 'ok' && source.policy === 'legacy_v1' && (
        <p className="m-0 text-hint text-ink-2">
          Noticias como aval: el flujo de prioridad aún no está activo.
        </p>
      )}
      {items.length > 0 && (
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setPage(0)
          }}
          placeholder="Buscar fecha, hora o titular (ej. 30/10 10:11)…"
          aria-label="Buscar noticia por fecha u hora"
          className="min-h-6 w-full rounded-sm border border-solid border-line bg-surface-1 px-2 py-0.5 text-hint text-ink placeholder:text-ink-2"
        />
      )}
      {!loaded && items.length === 0 ? (
        <p className="m-0 text-hint text-ink-2">Cargando noticias…</p>
      ) : items.length === 0 ? (
        <p className="m-0 text-hint text-ink-2">
          Aún no hay noticias recibidas.
        </p>
      ) : (
        <>
          <ul aria-label="Lista de noticias" className="m-0 list-none p-0">
            {paged.length === 0 && (
              <li className="border-t border-t-solid border-t-line py-1.5 text-hint text-ink-2">
                Sin noticias para esa fecha u hora.
              </li>
            )}
            {paged.map((item) => {
              const dt = formatShortDateTime(
                item.publishedAtMs ?? item.receivedAtMs,
              )
              const unconfirmed =
                source?.state === 'error' || source?.state === 'off'
              const expired =
                item.expiresAtMs != null &&
                nowMs !== undefined &&
                nowMs >= item.expiresAtMs
              const directionTone =
                unconfirmed || expired
                  ? 'text-ink-2'
                  : item.direction === 'bullish'
                    ? 'text-long'
                    : item.direction === 'bearish'
                      ? 'text-short'
                      : 'text-ink-2'
              const timeline = [
                item.publishedAtMs == null
                  ? 'Publicación sin fecha'
                  : `Publicada ${formatShortDateTime(item.publishedAtMs).display} UTC`,
                `Recibida ${formatShortDateTime(item.receivedAtMs).display} UTC`,
                item.knownAtMs == null
                  ? 'Análisis sin completar'
                  : `Análisis completo ${formatShortDateTime(item.knownAtMs).display} UTC`,
                item.expiresAtMs == null
                  ? 'Vencimiento sin confirmar'
                  : `Vence ${formatShortDateTime(item.expiresAtMs).display} UTC`,
              ].join(' · ')
              return (
                <li
                  key={item.id}
                  className="border-t border-t-solid border-t-line py-1"
                >
                  <div className="flex flex-wrap items-center justify-between gap-1.5 text-hint">
                    <span className="inline-flex flex-wrap items-center gap-1">
                      <span
                        className={`rounded-sm px-1.5 py-0.5 font-semibold ${item.relevance ? RELEVANCE_STYLE[item.relevance] : RELEVANCE_STYLE.none}`}
                        title="Importancia estimada para Ethereum; no es una probabilidad de ganar."
                      >
                        {item.relevance
                          ? `Relevancia ${RELEVANCE_LABEL[item.relevance]}`
                          : 'Sin clasificar'}
                      </span>
                      {item.direction && (
                        <small className={directionTone}>
                          {DIRECTION_LABEL[item.direction]}
                        </small>
                      )}
                    </span>
                    <small className="text-ink-2">
                      {item.source} · <time>{dt.display}</time> UTC
                    </small>
                  </div>
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-0.5 block line-clamp-1 text-hint text-ink no-underline hover:underline"
                    title={item.title}
                  >
                    {item.title}
                  </a>
                  <small
                    className="block text-ink-2"
                    title={`${timeline}${item.eligibilityReason ? ` · ${item.eligibilityReason}` : ''}`}
                  >
                    {unconfirmed
                      ? 'Sin confirmar'
                      : lifecycleLabel(item, nowMs)}
                    {item.licenseStatus &&
                    !['licensed', 'public_domain'].includes(item.licenseStatus)
                      ? ' · Permiso sin verificar'
                      : ''}
                  </small>
                </li>
              )
            })}
          </ul>
          {filtered.length > PAGE_SIZE && (
            <div
              className="flex items-center justify-between gap-2 border-t border-t-solid border-t-line pt-1 text-hint text-ink-2"
              aria-label="Paginación de noticias"
            >
              <button
                type="button"
                className={COMPACT_BTN}
                disabled={safePage === 0}
                onClick={() => setPage((p) => Math.max(0, p - 1))}
              >
                Anterior
              </button>
              <span>
                {safePage + 1} / {totalPages}
              </span>
              <button
                type="button"
                className={COMPACT_BTN}
                disabled={safePage >= totalPages - 1}
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              >
                Siguiente
              </button>
            </div>
          )}
        </>
      )}
    </section>
  )
}
