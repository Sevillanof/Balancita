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
  readonly licenseStatus:
    'official_public' | 'licensed' | 'permission_required' | 'unknown'
  readonly freshness: { readonly ageMs: number; readonly isStale: boolean }
  readonly important: boolean
  readonly summary: string
  readonly tradeIntent: 'buy' | 'sell' | 'neutral'
}

/**
 * UTC calendar day the fixtures belong to, derived from the real clock at
 * module load. Fixtures must always fall on "today" because NewsPanel filters
 * to the current UTC day; fixed calendar dates rot as soon as the day rolls
 * over and turn every consumer test red.
 */
export const NEWS_FIXTURE_DAY_UTC: string = new Date()
  .toISOString()
  .slice(0, 10)

function atTime(time: string): string {
  return `${NEWS_FIXTURE_DAY_UTC}T${time}.000Z`
}

export const NEWS_FIXTURES: readonly NewsItem[] = [
  {
    id: 'fixture-btc-support',
    version: '1',
    source: 'Fixture Wire',
    title: 'Bitcoin se mantiene sobre el soporte clave en euros',
    url: 'https://example.test/news/bitcoin-soporte',
    publishedAt: atTime('11:32:00'),
    ingestedAt: atTime('11:33:00'),
    displayedAt: atTime('11:34:00'),
    licenseStatus: 'official_public',
    freshness: { ageMs: 60_000, isStale: false },
    important: true,
    summary: 'Bitcoin se mantiene sobre el soporte clave en euros.',
    tradeIntent: 'neutral',
  },
  {
    id: 'fixture-ecb-digital-assets',
    version: '1',
    source: 'Fixture Ledger',
    title: 'El BCE publica un informe sobre activos digitales',
    url: 'https://example.test/news/bce-activos-digitales',
    publishedAt: atTime('11:20:00'),
    ingestedAt: atTime('11:21:00'),
    displayedAt: atTime('11:22:00'),
    licenseStatus: 'official_public',
    freshness: { ageMs: 60_000, isStale: false },
    important: true,
    summary: 'El BCE publica un informe sobre activos digitales.',
    tradeIntent: 'neutral',
  },
  {
    id: 'fixture-miners-hashrate',
    version: '1',
    source: 'Fixture Markets',
    title: 'El hashrate de la red alcanza un nuevo máximo',
    url: 'https://example.test/news/hashrate-maximo',
    publishedAt: atTime('10:58:00'),
    ingestedAt: atTime('10:59:00'),
    displayedAt: atTime('11:00:00'),
    licenseStatus: 'official_public',
    freshness: { ageMs: 60_000, isStale: false },
    important: false,
    summary: 'El hashrate de la red alcanza un nuevo máximo.',
    tradeIntent: 'neutral',
  },
  {
    id: 'fixture-etf-flows',
    version: '1',
    source: 'Fixture Desk',
    title: 'Flujos institucionales mixtos en los ETF spot',
    url: 'https://example.test/news/etf-flujos',
    publishedAt: atTime('10:41:00'),
    ingestedAt: atTime('10:42:00'),
    displayedAt: atTime('10:43:00'),
    licenseStatus: 'official_public',
    freshness: { ageMs: 60_000, isStale: false },
    important: false,
    summary: 'Flujos institucionales mixtos en los ETF spot.',
    tradeIntent: 'neutral',
  },
]
