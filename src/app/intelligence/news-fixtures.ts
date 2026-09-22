/**
 * Phase 1 news fixtures. Deterministic, local and offline: every URL uses the
 * reserved `.test` TLD and every item is explicitly labelled as a fixture, so
 * nothing here is a real news claim. Phase 3 replaces this module with the
 * server pipeline while keeping the same `NewsItem` shape.
 */

export type NewsStatus = 'loading' | 'ready' | 'empty' | 'error' | 'stale'

export type NewsItem = {
  readonly id: string
  readonly source: string
  readonly title: string
  readonly url: string
  readonly publishedAt: string
  readonly important: boolean
}

export const NEWS_FIXTURES: readonly NewsItem[] = [
  {
    id: 'fixture-btc-support',
    source: 'Fixture Wire',
    title: 'Bitcoin se mantiene sobre el soporte clave en euros',
    url: 'https://example.test/news/bitcoin-soporte',
    publishedAt: '2026-09-20T11:32:00.000Z',
    important: true,
  },
  {
    id: 'fixture-ecb-digital-assets',
    source: 'Fixture Ledger',
    title: 'El BCE publica un informe sobre activos digitales',
    url: 'https://example.test/news/bce-activos-digitales',
    publishedAt: '2026-09-20T11:20:00.000Z',
    important: true,
  },
  {
    id: 'fixture-miners-hashrate',
    source: 'Fixture Markets',
    title: 'El hashrate de la red alcanza un nuevo máximo',
    url: 'https://example.test/news/hashrate-maximo',
    publishedAt: '2026-09-20T10:58:00.000Z',
    important: false,
  },
  {
    id: 'fixture-etf-flows',
    source: 'Fixture Desk',
    title: 'Flujos institucionales mixtos en los ETF spot',
    url: 'https://example.test/news/etf-flujos',
    publishedAt: '2026-09-20T10:41:00.000Z',
    important: false,
  },
]
