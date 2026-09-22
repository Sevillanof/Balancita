import type { NewsItem, NewsStatus } from './news-fixtures'
import './news.css'

type NewsPanelProps = {
  readonly status?: NewsStatus
  readonly items?: readonly NewsItem[]
  readonly onRetry?: () => void
}

const DEFAULT_ITEMS: readonly NewsItem[] = []

/** Renders server-provided news state; transport and reconnection stay in the hook. */
export default function NewsPanel({
  status = 'ready',
  items = DEFAULT_ITEMS,
  onRetry,
}: NewsPanelProps) {
  const showItems = status === 'ready' || status === 'stale'
  const showEmpty = status === 'empty' || (showItems && items.length === 0)
  const sortedItems = [...items].sort(compareNewsItems)

  return (
    <section className="news" aria-label="Noticias BTC-EUR">
      {status === 'loading' && (
        <p role="status" aria-busy="true" className="news__state">
          Cargando noticias…
        </p>
      )}

      {status === 'error' && (
        <div role="alert" className="news__state news__state--error">
          <span>No se pudieron cargar las noticias.</span>
          {onRetry !== undefined && (
            <button type="button" className="news__retry" onClick={onRetry}>
              Reintentar
            </button>
          )}
        </div>
      )}

      {status === 'stale' && (
        <p role="status" className="news__state news__state--stale">
          Noticias desactualizadas; mostrando la última evidencia disponible.
        </p>
      )}

      {showEmpty && (
        <p role="status" className="news__state">
          No hay noticias disponibles.
        </p>
      )}

      {showItems && sortedItems.length > 0 && (
        <ul className="news__list" aria-label="Lista de noticias">
          {sortedItems.map((item) => {
            const importanceLabel = item.important
              ? 'Importante'
              : 'No importante'

            return (
              <li key={item.id} className="news__item">
                <div className="news__meta">
                  <span className="news__source">{item.source}</span>
                  <span className="news__time-group">
                    <span
                      className={`news__importance news__importance--${item.important ? 'important' : 'normal'}`}
                      aria-label={importanceLabel}
                      title={importanceLabel}
                    >
                      <span aria-hidden="true">
                        {item.important ? '!' : '·'}
                      </span>{' '}
                      {importanceLabel}
                    </span>
                    <time className="news__time" dateTime={item.publishedAt}>
                      {formatNewsTime(item.publishedAt)}
                    </time>
                  </span>
                </div>
                <a
                  className="news__title"
                  href={item.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {item.title}
                </a>
                <div className="news__provenance" aria-label="Proveniencia">
                  <span>
                    URL: <span className="news__url">{item.url}</span>
                  </span>
                  <span>
                    Publicado:{' '}
                    <time dateTime={item.publishedAt}>
                      {formatNewsDateTime(item.publishedAt)}
                    </time>
                  </span>
                  <span>
                    Ingestado:{' '}
                    <time dateTime={item.ingestedAt}>
                      {formatNewsDateTime(item.ingestedAt)}
                    </time>
                  </span>
                  <span>
                    Mostrado:{' '}
                    <time dateTime={item.displayedAt}>
                      {formatNewsDateTime(item.displayedAt)}
                    </time>
                  </span>
                  <span>
                    Frescura: {formatFreshness(item.freshness.ageMs)}
                    {item.freshness.isStale ? ' · stale' : ''}
                  </span>
                  <span>Licencia: {item.licenseStatus}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function formatNewsTime(publishedAt: string): string {
  const date = new Date(publishedAt)
  if (Number.isNaN(date.getTime())) return '--:--'
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

function formatNewsDateTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'fecha inválida' : date.toISOString()
}

function formatFreshness(ageMs: number): string {
  if (ageMs < 1_000) return `${ageMs} ms`
  return `${Math.round(ageMs / 1_000)} s`
}

function compareNewsItems(left: NewsItem, right: NewsItem): number {
  const leftTime = Date.parse(left.publishedAt)
  const rightTime = Date.parse(right.publishedAt)
  const leftInvalid = Number.isNaN(leftTime)
  const rightInvalid = Number.isNaN(rightTime)

  if (leftInvalid || rightInvalid) {
    if (leftInvalid && rightInvalid) return 0
    return leftInvalid ? 1 : -1
  }

  return rightTime - leftTime
}
