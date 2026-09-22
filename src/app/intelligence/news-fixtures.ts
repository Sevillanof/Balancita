/** Test-only news values; production rendering receives the same shape from SSE. */

export type NewsStatus = 'loading' | 'ready' | 'empty' | 'error' | 'stale'

export type NewsItem = {
  readonly id: string
  readonly version: string
  readonly source: string
  readonly title: string
  readonly url: string
  readonly publishedAt: string
  readonly ingestedAt: string
  readonly displayedAt: string
  readonly licenseStatus: 'official_public' | 'licensed' | 'unknown'
  readonly freshness: { readonly ageMs: number; readonly isStale: boolean }
  readonly important: boolean
}

export const NEWS_FIXTURES: readonly NewsItem[] = [
  {
    id: 'fixture-btc-support',
    version: '1',
    source: 'Fixture Wire',
    title: 'Bitcoin se mantiene sobre el soporte clave en euros',
    url: 'https://example.test/news/bitcoin-soporte',
    publishedAt: '2026-09-20T11:32:00.000Z',
    ingestedAt: '2026-09-20T11:33:00.000Z',
    displayedAt: '2026-09-20T11:34:00.000Z',
    licenseStatus: 'official_public',
    freshness: { ageMs: 60_000, isStale: false },
    important: true,
  },
  {
    id: 'fixture-ecb-digital-assets',
    version: '1',
    source: 'Fixture Ledger',
    title: 'El BCE publica un informe sobre activos digitales',
    url: 'https://example.test/news/bce-activos-digitales',
    publishedAt: '2026-09-20T11:20:00.000Z',
    ingestedAt: '2026-09-20T11:21:00.000Z',
    displayedAt: '2026-09-20T11:22:00.000Z',
    licenseStatus: 'official_public',
    freshness: { ageMs: 60_000, isStale: false },
    important: true,
  },
  {
    id: 'fixture-miners-hashrate',
    version: '1',
    source: 'Fixture Markets',
    title: 'El hashrate de la red alcanza un nuevo máximo',
    url: 'https://example.test/news/hashrate-maximo',
    publishedAt: '2026-09-20T10:58:00.000Z',
    ingestedAt: '2026-09-20T10:59:00.000Z',
    displayedAt: '2026-09-20T11:00:00.000Z',
    licenseStatus: 'official_public',
    freshness: { ageMs: 60_000, isStale: false },
    important: false,
  },
  {
    id: 'fixture-etf-flows',
    version: '1',
    source: 'Fixture Desk',
    title: 'Flujos institucionales mixtos en los ETF spot',
    url: 'https://example.test/news/etf-flujos',
    publishedAt: '2026-09-20T10:41:00.000Z',
    ingestedAt: '2026-09-20T10:42:00.000Z',
    displayedAt: '2026-09-20T10:43:00.000Z',
    licenseStatus: 'official_public',
    freshness: { ageMs: 60_000, isStale: false },
    important: false,
  },
]
