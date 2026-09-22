import type { NewsItem, NewsStatus } from './news-fixtures'
import './news.css'

type NewsPanelProps = {
  readonly status?: NewsStatus
  readonly items?: readonly NewsItem[]
  readonly onRetry?: () => void
  readonly now?: () => number
}

const DEFAULT_ITEMS: readonly NewsItem[] = []

/** Renders server-provided news state; transport and reconnection stay in the hook. */
export default function NewsPanel({
  status = 'ready',
  items = DEFAULT_ITEMS,
  onRetry,
  now = Date.now,
}: NewsPanelProps) {
  const showItems = status === 'ready' || status === 'stale'
  const todayItems = items.filter(
    (item) => isToday(item.publishedAt, now()) && isValidSummary(item.summary),
  )
  const showEmpty = status === 'empty' || (showItems && todayItems.length === 0)
  const sortedItems = [...todayItems].sort(compareNewsItems)

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
                <p className="news__summary">{item.summary}</p>
                <span
                  className={`news__trade-intent news__trade-intent--${item.tradeIntent}`}
                >
                  {tradeIntentLabel(item.tradeIntent)}
                </span>
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

function isToday(value: string, reference: number): boolean {
  const publishedAt = Date.parse(value)
  if (Number.isNaN(publishedAt)) return false
  const date = new Date(reference)
  const start = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
  )
  return publishedAt >= start && publishedAt < start + 86_400_000
}

function isValidSummary(value: string): boolean {
  const normalized = value.trim()
  return (
    normalized !== '' &&
    normalized.split(/(?<=[.!?])\s+/u).filter(Boolean).length <= 5
  )
}

function tradeIntentLabel(intent: NewsItem['tradeIntent']): string {
  return intent === 'buy' ? 'Compra' : intent === 'sell' ? 'Venta' : 'Neutral'
}
