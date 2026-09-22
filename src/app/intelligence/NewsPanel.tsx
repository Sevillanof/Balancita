import type { NewsItem, NewsStatus } from './news-fixtures'
import './news.css'

type NewsPanelProps = {
  readonly status?: NewsStatus
  readonly items?: readonly NewsItem[]
  readonly onRetry?: () => void
}

const DEFAULT_ITEMS: readonly NewsItem[] = []

/**
 * Phase 1 news surface. Renders only local fixtures; it never fetches. The
 * loading/empty/error/stale branches exist so the state contract is testable
 * now and reusable when the server pipeline arrives in Phase 3.
 */
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
      <div className="section-header news__header">
        <h2 id="dashboard-news-title">NOTICIAS EN TIEMPO REAL</h2>
      </div>

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
