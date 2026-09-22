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

      {showItems && items.length > 0 && (
        <ul className="news__list" aria-label="Lista de noticias">
          {items.map((item) => (
            <li key={item.id} className="news__item">
              <div className="news__meta">
                <span className="news__source">{item.source}</span>
                <time className="news__time" dateTime={item.publishedAt}>
                  {formatNewsTime(item.publishedAt)}
                </time>
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
          ))}
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
