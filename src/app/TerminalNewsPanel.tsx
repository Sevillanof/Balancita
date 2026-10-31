import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import ModalFrame from '../features/strategy-lab/presentation/ModalFrame.tsx'
import { formatShortDateTime } from './terminal-date.ts'
import { paginateNewsHeights } from './terminal-news-layout.ts'
import type {
  NewsDirection,
  NewsRelevance,
  NewsSource,
  TerminalNewsBriefing,
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

function newsTimeline(item: TerminalNewsItem): string {
  return [
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
    item.eligibilityReason,
  ]
    .filter(Boolean)
    .join(' · ')
}

function NewsRow({
  item,
  nowMs,
  source,
  compact = false,
  tight = false,
  minHeight,
  onDetails,
}: {
  item: TerminalNewsItem
  nowMs?: number
  source?: NewsSource
  compact?: boolean
  tight?: boolean
  minHeight?: number
  onDetails: (item: TerminalNewsItem) => void
}) {
  const dt = formatShortDateTime(item.publishedAtMs ?? item.receivedAtMs)
  const unconfirmed = source?.state === 'error' || source?.state === 'off'
  const expired =
    item.expiresAtMs != null && nowMs !== undefined && nowMs >= item.expiresAtMs
  const directionTone =
    unconfirmed || expired
      ? 'text-ink-2'
      : item.direction === 'bullish'
        ? 'text-long'
        : item.direction === 'bearish'
          ? 'text-short'
          : 'text-ink-2'
  const permissionUnknown =
    item.licenseStatus &&
    !['licensed', 'public_domain'].includes(item.licenseStatus)
  const lifecycle = unconfirmed ? 'Sin confirmar' : lifecycleLabel(item, nowMs)
  return (
    <li
      data-news-id={item.id}
      className={
        compact
          ? `flex min-w-0 flex-col justify-center gap-0.5 rounded-sm border border-solid border-line bg-surface-2 px-2 ${tight ? 'py-0.5' : 'py-1.5'}`
          : 'border-t border-t-solid border-t-line py-1'
      }
      style={minHeight === undefined ? undefined : { minHeight }}
    >
      <div
        className={`flex items-center justify-between gap-1 ${compact ? 'text-label' : 'flex-wrap gap-1.5 text-hint'}`}
      >
        <span className="inline-flex min-w-0 items-center gap-1">
          <span
            className={`flex-none rounded-sm px-1.5 py-0.5 font-semibold ${item.relevance ? RELEVANCE_STYLE[item.relevance] : RELEVANCE_STYLE.none}`}
            title="Importancia estimada para Ethereum; no es una probabilidad de ganar."
          >
            {item.relevance
              ? `${compact ? '' : 'Relevancia '}${RELEVANCE_LABEL[item.relevance]}`
              : 'Sin clasificar'}
          </span>
          {item.direction && (
            <small className={`whitespace-nowrap ${directionTone}`}>
              {DIRECTION_LABEL[item.direction]}
            </small>
          )}
        </span>
        <small className="flex-none text-ink-2">
          {!compact && `${item.source} · `}
          <time>{dt.display}</time> UTC
        </small>
      </div>
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className={`${compact ? 'text-label leading-4' : 'mt-1 text-hint'} ${tight ? 'line-clamp-1' : 'line-clamp-2'} text-ink no-underline hover:underline`}
        title={item.title}
      >
        {item.title}
      </a>
      <button
        type="button"
        onClick={() => onDetails(item)}
        aria-label={`Ver procedencia y vigencia de ${item.title}`}
        className={`cursor-pointer border-0 bg-transparent p-0 text-left ${compact ? 'flex min-w-0 items-center justify-between gap-1 text-label leading-4' : 'block text-label'} text-ink-2`}
        title={`${newsTimeline(item)}${permissionUnknown ? ' · Permiso sin verificar' : ''}`}
      >
        {compact && <span className="min-w-0 truncate">{item.source}</span>}
        <span className={compact ? 'min-w-0 truncate' : undefined}>
          {lifecycle}
          {permissionUnknown ? ' · Permiso sin verificar' : ''}
          {compact ? ' ↗' : ''}
        </span>
      </button>
    </li>
  )
}

const BRIEFING_LABEL = {
  ok: 'Resumen de noticias',
  pending: 'Pendiente',
  no_news: 'Sin noticias recientes',
  off: 'No disponible',
  error: 'No disponible',
  stale: 'Desactualizado',
} as const

function briefingLabel(
  briefing: TerminalNewsBriefing | null,
  source: NewsSource | undefined,
  nowMs: number | undefined,
): string {
  if (source?.state === 'error' || source?.state === 'off')
    return 'Sin confirmar'
  if (!briefing) return 'Pendiente'
  if ((!source || source.state === 'loading') && briefing.status === 'ok')
    return 'Sin confirmar'
  if (nowMs === undefined && briefing.status === 'ok')
    return 'Vigencia sin confirmar'
  if (
    briefing.expiresAtMs !== null &&
    nowMs !== undefined &&
    nowMs >= briefing.expiresAtMs
  )
    return 'Desactualizado'
  return BRIEFING_LABEL[briefing.status]
}

export default function TerminalNewsPanel({
  items,
  loaded = true,
  nowMs,
  source,
  relevantOnly = false,
  viewport = false,
  briefing = null,
}: {
  items: readonly TerminalNewsItem[]
  loaded?: boolean
  nowMs?: number
  source?: NewsSource
  relevantOnly?: boolean
  viewport?: boolean
  briefing?: TerminalNewsBriefing | null
}) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const [detail, setDetail] = useState<
    'search' | 'briefing' | 'status' | TerminalNewsItem | null
  >(null)
  const spaceRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLUListElement>(null)
  const [measure, setMeasure] = useState({
    available: 0,
    heights: [] as number[],
  })
  const needle = query.trim().toLowerCase()
  const relevant = useMemo(
    () =>
      relevantOnly
        ? items.filter(
            (item) => item.relevance !== null && item.relevance !== 'none',
          )
        : items,
    [items, relevantOnly],
  )
  const pending = items.filter(
    (item) =>
      item.analysisStatus === 'pending' || item.analysisStatus === 'partial',
  ).length
  const filtered = useMemo(
    () =>
      needle
        ? relevant.filter((item) => matchesNewsQuery(item, needle))
        : relevant,
    [relevant, needle],
  )
  const tight = measure.available > 0 && measure.available < 112
  useLayoutEffect(() => {
    if (!viewport || !spaceRef.current || !measureRef.current) return
    const update = () => {
      const available = Math.max(
        0,
        Math.floor(spaceRef.current?.getBoundingClientRect().height ?? 0),
      )
      const heights = Array.from(
        measureRef.current?.children ?? [],
        (row) => row.getBoundingClientRect().height,
      )
      setMeasure((previous) =>
        previous.available === available &&
        previous.heights.length === heights.length &&
        previous.heights.every((height, index) => height === heights[index])
          ? previous
          : { available, heights },
      )
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(spaceRef.current)
    observer.observe(measureRef.current)
    return () => observer.disconnect()
  }, [viewport, filtered, tight, nowMs, source])
  const fits =
    viewport &&
    measure.heights.length === filtered.length &&
    measure.heights.every((height) => height > 0)
      ? paginateNewsHeights(measure.heights, measure.available)
      : []
  const totalPages = viewport
    ? Math.max(1, fits?.length ?? 0)
    : Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const range = viewport
    ? fits?.[safePage]
    : { start: safePage * PAGE_SIZE, end: (safePage + 1) * PAGE_SIZE }
  const paged = range ? filtered.slice(range.start, range.end) : []
  const used = range
    ? measure.heights
        .slice(range.start, range.end)
        .reduce((sum, height) => sum + height, 0) +
      Math.max(0, paged.length - 1) * 8
    : 0
  const extra =
    paged.length > 0
      ? Math.max(0, (measure.available - used) / paged.length)
      : 0
  const issues = [
    relevantOnly && pending > 0
      ? `${pending} pendiente${pending === 1 ? '' : 's'} de clasificar`
      : null,
    source?.state === 'error' || source?.state === 'off'
      ? `No se pueden confirmar las noticias. ${items.length ? 'Último dato, sin confirmar. ' : ''}${source.reason}`
      : null,
    source?.state === 'ok' && source.collectorStatus !== 'ok'
      ? `El colector tiene fuentes atrasadas o sin confirmar. ${source.collectorReason ?? ''}`
      : null,
    source?.state === 'ok' && source.policy === 'legacy_v1'
      ? 'Noticias como aval: el flujo de prioridad aún no está activo.'
      : null,
  ].filter((issue): issue is string => issue !== null)
  const summaryState = briefingLabel(briefing, source, nowMs)

  if (viewport)
    return (
      <section
        className="flex min-h-0 min-w-0 flex-1 flex-col gap-1.5"
        aria-label="Últimas noticias"
        data-testid="terminal-news-panel"
        data-layout="viewport"
      >
        <section
          className="flex-none rounded-sm border border-solid border-info/25 bg-info/5 px-2 py-1.5"
          aria-label="Qwen, resumen de noticias"
          data-testid="qwen-news-briefing"
        >
          <button
            type="button"
            onClick={() => setDetail('briefing')}
            className="flex w-full cursor-pointer items-center justify-between gap-1 border-0 bg-transparent p-0 text-left text-label text-info"
            aria-label="Ver resumen y fuentes de Qwen"
          >
            <b>Qwen · panorama ETH</b>
            <small
              className={
                summaryState === BRIEFING_LABEL.ok ? 'text-ink-2' : 'text-warn'
              }
            >
              {summaryState === BRIEFING_LABEL.ok && briefing?.knownAtMs != null
                ? `${formatShortDateTime(briefing.knownAtMs).display.slice(-5)} UTC`
                : summaryState}
            </small>
          </button>
          <p
            className="m-0 mt-1 line-clamp-2 text-label leading-4 text-ink"
            title={briefing?.text ?? briefing?.reason ?? undefined}
          >
            {briefing?.text ??
              (briefing?.status === 'no_news'
                ? 'No hay noticias recientes suficientes para un resumen.'
                : 'Todavía no hay una síntesis reciente de Qwen.')}
          </p>
        </section>
        <div
          ref={spaceRef}
          className="relative min-h-0 flex-1"
          data-testid="news-available-space"
        >
          <div
            className="pointer-events-none invisible absolute inset-0 overflow-hidden"
            aria-hidden="true"
            inert
          >
            <ul ref={measureRef} className="m-0 grid list-none gap-2 p-0">
              {filtered.map((item) => (
                <NewsRow
                  key={item.id}
                  item={item}
                  nowMs={nowMs}
                  source={source}
                  compact
                  tight={tight}
                  onDetails={setDetail}
                />
              ))}
            </ul>
          </div>
          {!loaded && relevant.length === 0 ? (
            <p className="m-0 text-label text-ink-2">Cargando noticias…</p>
          ) : relevant.length === 0 ? (
            <p className="m-0 text-label text-ink-2">
              {relevantOnly
                ? 'Aún no hay noticias de importancia Baja, Media o Alta.'
                : 'Aún no hay noticias recibidas.'}
            </p>
          ) : filtered.length === 0 ? (
            <p className="m-0 text-label text-ink-2">
              Sin noticias para esa fecha u hora.
            </p>
          ) : fits === null ? (
            <p className="m-0 text-label text-warn" role="status">
              Ampliá la altura de la ventana para ver los titulares.
            </p>
          ) : (
            <ul
              aria-label="Lista de noticias"
              className="m-0 grid list-none gap-2 p-0"
              data-page-size={paged.length}
            >
              {paged.map((item, index) => (
                <NewsRow
                  key={item.id}
                  item={item}
                  nowMs={nowMs}
                  source={source}
                  compact
                  tight={tight}
                  minHeight={
                    (measure.heights[range!.start + index] ?? 0) + extra
                  }
                  onDetails={setDetail}
                />
              ))}
            </ul>
          )}
        </div>
        <div
          className="flex flex-none items-center justify-between gap-1 border-t border-t-solid border-line pt-1 text-label text-ink-2"
          aria-label="Paginación de noticias"
        >
          <button
            type="button"
            className={`${COMPACT_BTN} px-1.5`}
            onClick={() => setDetail('search')}
            aria-label="Buscar noticias"
          >
            {needle ? 'Buscar •' : 'Buscar'}
          </button>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className={`${COMPACT_BTN} px-1.5`}
              disabled={safePage === 0}
              onClick={() => setPage(Math.max(0, safePage - 1))}
              aria-label="Anterior"
            >
              ‹
            </button>
            <span aria-live="polite">
              {safePage + 1} / {totalPages}
            </span>
            <button
              type="button"
              className={`${COMPACT_BTN} px-1.5`}
              disabled={safePage >= totalPages - 1}
              onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
              aria-label="Siguiente"
            >
              ›
            </button>
          </div>
          <button
            type="button"
            className={`cursor-pointer border-0 bg-transparent p-0 text-label ${issues.length ? 'text-warn' : 'text-ink-2'}`}
            aria-label="Estado y permisos de noticias"
            title={
              issues.join(' · ') || `${filtered.length} noticias · solo lectura`
            }
            onClick={() => setDetail('status')}
          >
            {issues.length
              ? `⚠ ${pending || 'Estado'}`
              : `${filtered.length} noticias`}
          </button>
        </div>
        {detail !== null && (
          <ModalFrame
            label={
              typeof detail === 'string'
                ? detail === 'search'
                  ? 'Buscar noticias'
                  : detail === 'briefing'
                    ? 'Resumen y fuentes de Qwen'
                    : 'Estado de noticias'
                : 'Procedencia y vigencia de la noticia'
            }
            onClose={() => setDetail(null)}
          >
            {detail === 'search' ? (
              <>
                <h2>Buscar noticias</h2>
                <input
                  type="search"
                  autoFocus
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setPage(0)
                  }}
                  placeholder="Fecha, hora, fuente o titular…"
                  aria-label="Buscar noticia por fecha u hora"
                  className="min-h-8 rounded-sm border border-solid border-line bg-canvas px-2 text-body text-ink"
                />
                <p>
                  {filtered.length} coincidencias. El resumen de Qwen permanece
                  fijo.
                </p>
                <button
                  type="button"
                  className={COMPACT_BTN}
                  onClick={() => {
                    setQuery('')
                    setPage(0)
                  }}
                >
                  Limpiar búsqueda
                </button>
              </>
            ) : detail === 'briefing' ? (
              <>
                <h2>Qwen · resumen de noticias</h2>
                <p>{summaryState}</p>
                <p>
                  {briefing?.text ??
                    'Todavía no hay una síntesis reciente de Qwen.'}
                </p>
                {briefing?.reason && (
                  <p className="text-warn">{briefing.reason}</p>
                )}
                <p>
                  Solo resume noticias: no opina sobre velas, no pronostica
                  precios y no decide operaciones.
                </p>
                <p>
                  {briefing?.knownAtMs == null
                    ? 'Análisis sin completar'
                    : `Analizado ${formatShortDateTime(briefing.knownAtMs).display} UTC`}{' '}
                  · {briefing?.sourceCount ?? 0} fuentes
                </p>
                {briefing?.expiresAtMs != null && (
                  <p>
                    Vence {formatShortDateTime(briefing.expiresAtMs).display}{' '}
                    UTC
                  </p>
                )}
                <ul>
                  {briefing?.sources.map((item) => (
                    <li key={item.id}>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {item.source}
                      </a>{' '}
                      ·{' '}
                      {item.publishedAtMs == null
                        ? 'Publicación sin fecha'
                        : `Publicada ${formatShortDateTime(item.publishedAtMs).display} UTC`}{' '}
                      · Recibida{' '}
                      {formatShortDateTime(item.receivedAtMs).display} UTC ·
                      Permiso: {item.licenseStatus}
                    </li>
                  ))}
                </ul>
              </>
            ) : detail === 'status' ? (
              <>
                <h2>Estado de noticias</h2>
                {issues.length ? (
                  issues.map((issue) => (
                    <p key={issue} className="text-warn">
                      {issue}
                    </p>
                  ))
                ) : (
                  <p>
                    {source?.state === 'ok'
                      ? 'Lectura confirmada.'
                      : 'Lectura sin confirmar.'}{' '}
                    {filtered.length} noticias coinciden con la selección.
                  </p>
                )}
                <p>
                  Importancia no es probabilidad de ganar. Un permiso sin
                  verificar no habilita una operación.
                </p>
              </>
            ) : typeof detail === 'object' ? (
              <>
                <h2>{detail.title}</h2>
                <p>{newsTimeline(detail)}</p>
                <p>
                  {source?.state === 'error' || source?.state === 'off'
                    ? 'Sin confirmar'
                    : lifecycleLabel(detail, nowMs)}
                </p>
                <p>Permiso: {detail.licenseStatus ?? 'unknown'}</p>
                <a href={detail.url} target="_blank" rel="noopener noreferrer">
                  Abrir en {detail.source}
                </a>
                {detail.licenseUrl && (
                  <a
                    href={detail.licenseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Condiciones del proveedor
                  </a>
                )}
              </>
            ) : null}
            <button
              type="button"
              className={COMPACT_BTN}
              onClick={() => setDetail(null)}
            >
              Cerrar
            </button>
          </ModalFrame>
        )}
      </section>
    )

  return (
    <section
      className="flex flex-col gap-1.5"
      aria-label="Últimas noticias"
      data-testid="terminal-news-panel"
    >
      {relevantOnly && pending > 0 && (
        <small className="text-ink-2" role="status">
          {pending} pendiente{pending === 1 ? '' : 's'} de clasificar
        </small>
      )}
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
      {relevant.length > 0 && (
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
      {!loaded && relevant.length === 0 ? (
        <p className="m-0 text-hint text-ink-2">Cargando noticias…</p>
      ) : relevant.length === 0 ? (
        <p className="m-0 text-hint text-ink-2">
          {relevantOnly
            ? 'Aún no hay noticias de importancia Baja, Media o Alta.'
            : 'Aún no hay noticias recibidas.'}
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
                    className="mt-1 block line-clamp-2 text-hint text-ink no-underline hover:underline"
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
