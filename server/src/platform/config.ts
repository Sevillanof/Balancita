import { ServerConfigError } from './analysis-errors.ts'
import type { RssSourceConfig } from '../features/news/rss-collector.ts'

export { ServerConfigError } from './analysis-errors.ts'

/**
 * Runtime configuration of the Gemini gateway. Values come from the
 * environment and are validated once at bootstrap, so the rest of the server
 * can rely on sane numbers. The API key is read here and never logged or sent
 * to the browser.
 */
export interface ServerConfig {
  host: string
  port: number
  apiKey: string
  model: string
  maxOutputTokens: number
  timeoutMs: number
  maxRequestsPerMinute: number
  maxRequestsPerDay: number
  cacheMaxEntries: number
  cacheTtlMs: number
  maxCandles: number
  corsOrigin: string
  marketCollectorEnabled: boolean
  krakenWsCollectorEnabled: boolean
  krakenRestOhlcWorkerEnabled: boolean
  krakenPaperTradingEnabled: boolean
  marketCollectorIntervalMs: number
  forecastLoopEnabled: boolean
  forecastLoopIntervalMs: number
  newsPollingEnabled: boolean
  newsPollIntervalMs: number
  newsStaleAfterMs: number
  newsUserAgent: string
  treeNewsEnabled: boolean
  treeNewsUrl: string
  treeNewsReconnectMinMs: number
  treeNewsReconnectMaxMs: number
  extraNewsRssSources: readonly RssSourceConfig[]
  marketDbPath: string
  shadowRunId: string
  simulationsReportPath: string
  krakenWsUrl: string
  krakenRestUrl: string
  marketStaleAfterMs: number
  marketReconnectMinMs: number
  marketReconnectMaxMs: number
  intelligenceStreamMaxClients: number
  intelligenceStreamKeepAliveMs: number
  intelligenceStreamWindowSize: number
  futuresMode: 'mock' | 'paper_live' | 'replay' | undefined
  futuresDbPath: string
  futuresMarketDbPath: string
  futuresReplaySourceDbPath: string | undefined
  futuresReplaySourceRunId: string | undefined
}

const DEFAULT_MODEL = 'gemini-3.5-flash-lite'

export function serverConfigFrom(
  env: Readonly<Record<string, string | undefined>>,
): ServerConfig {
  const marketReconnectMinMs = positiveInt(
    env,
    'MARKET_RECONNECT_MIN_MS',
    1_000,
  )
  const marketReconnectMaxMs = positiveInt(
    env,
    'MARKET_RECONNECT_MAX_MS',
    30_000,
  )
  if (marketReconnectMaxMs < marketReconnectMinMs) {
    throw new ServerConfigError(
      'MARKET_RECONNECT_MAX_MS must be greater than or equal to MARKET_RECONNECT_MIN_MS.',
    )
  }

  const treeNewsReconnectMinMs = positiveInt(
    env,
    'TREE_NEWS_RECONNECT_MIN_MS',
    1_000,
  )
  const treeNewsReconnectMaxMs = positiveInt(
    env,
    'TREE_NEWS_RECONNECT_MAX_MS',
    30_000,
  )
  if (treeNewsReconnectMaxMs < treeNewsReconnectMinMs) {
    throw new ServerConfigError(
      'TREE_NEWS_RECONNECT_MAX_MS must be greater than or equal to TREE_NEWS_RECONNECT_MIN_MS.',
    )
  }

  const futuresMode = futuresModeFrom(env.FUTURES_MODE)
  const futuresDbPath = stringValue(
    env,
    'FUTURES_DB_PATH',
    './data/futures-paper.sqlite',
  )
  const futuresReplaySourceDbPath = optionalStringValue(
    env.FUTURES_REPLAY_SOURCE_DB_PATH,
  )
  const futuresReplaySourceRunId = optionalStringValue(
    env.FUTURES_REPLAY_SOURCE_RUN_ID,
  )
  if (futuresMode === 'replay') {
    if (futuresReplaySourceDbPath === undefined)
      throw new ServerConfigError(
        'FUTURES_REPLAY_SOURCE_DB_PATH is required when FUTURES_MODE=replay.',
      )
    if (futuresReplaySourceDbPath === futuresDbPath)
      throw new ServerConfigError(
        'FUTURES_REPLAY_SOURCE_DB_PATH and FUTURES_DB_PATH must differ.',
      )
  } else if (
    futuresReplaySourceDbPath !== undefined ||
    futuresReplaySourceRunId !== undefined
  ) {
    throw new ServerConfigError(
      'FUTURES_REPLAY_SOURCE_DB_PATH and FUTURES_REPLAY_SOURCE_RUN_ID require FUTURES_MODE=replay.',
    )
  }

  return {
    host: stringValue(env, 'HOST', '127.0.0.1'),
    port: positiveInt(env, 'PORT', 8787),
    apiKey: env.GEMINI_API_KEY ?? '',
    model:
      env.GEMINI_MODEL === undefined || env.GEMINI_MODEL === ''
        ? DEFAULT_MODEL
        : env.GEMINI_MODEL,
    maxOutputTokens: positiveInt(env, 'GEMINI_MAX_OUTPUT_TOKENS', 1024),
    timeoutMs: positiveInt(env, 'GEMINI_TIMEOUT_MS', 15_000),
    maxRequestsPerMinute: positiveInt(
      env,
      'GEMINI_MAX_REQUESTS_PER_MINUTE',
      10,
    ),
    maxRequestsPerDay: positiveInt(env, 'GEMINI_MAX_REQUESTS_PER_DAY', 300),
    cacheMaxEntries: positiveInt(env, 'GEMINI_CACHE_MAX_ENTRIES', 100),
    cacheTtlMs: positiveInt(env, 'GEMINI_CACHE_TTL_MS', 300_000),
    maxCandles: positiveInt(env, 'GEMINI_MAX_CANDLES', 500),
    corsOrigin: stringValue(
      env,
      'GEMINI_SERVER_CORS_ORIGIN',
      'http://localhost:5173',
    ),
    marketCollectorEnabled: collectorFlag(
      env,
      'KRAKEN_WS_COLLECTOR_ENABLED',
      false,
    ),
    krakenWsCollectorEnabled: collectorFlag(
      env,
      'KRAKEN_WS_COLLECTOR_ENABLED',
      false,
    ),
    krakenRestOhlcWorkerEnabled: collectorFlag(
      env,
      'KRAKEN_REST_OHLC_WORKER_ENABLED',
      true,
    ),
    krakenPaperTradingEnabled: booleanValue(
      env,
      'PAPER_TRADING_ENABLED',
      booleanValue(env, 'KRAKEN_PAPER_TRADING_ENABLED', true),
    ),
    marketCollectorIntervalMs: positiveInt(
      env,
      'MARKET_COLLECTOR_INTERVAL_MS',
      60_000,
    ),
    forecastLoopEnabled: booleanValue(env, 'FORECAST_LOOP_ENABLED', false),
    forecastLoopIntervalMs: positiveInt(
      env,
      'FORECAST_LOOP_INTERVAL_MS',
      60_000,
    ),
    newsPollingEnabled: booleanValue(env, 'NEWS_POLLING_ENABLED', false),
    newsPollIntervalMs: positiveInt(env, 'NEWS_POLL_INTERVAL_MS', 300_000),
    newsStaleAfterMs: positiveInt(env, 'NEWS_STALE_AFTER_MS', 900_000),
    newsUserAgent: stringValue(env, 'NEWS_USER_AGENT', 'Balancita/1.0'),
    treeNewsEnabled: booleanValue(env, 'TREE_NEWS_ENABLED', false),
    treeNewsUrl: stringValue(
      env,
      'TREE_NEWS_URL',
      'wss://news.treeofalpha.com/ws',
    ),
    treeNewsReconnectMinMs,
    treeNewsReconnectMaxMs,
    extraNewsRssSources: parseExtraRssSources(env.NEWS_EXTRA_RSS_FEEDS),
    marketDbPath: stringValue(env, 'MARKET_DB_PATH', './data/market.sqlite'),
    shadowRunId: stringValue(env, 'SHADOW_RUN_ID', 'shadow:BTC-EUR'),
    simulationsReportPath: stringValue(
      env,
      'SIMULATIONS_REPORT_PATH',
      './data/simulations-report.json',
    ),
    krakenWsUrl: stringValue(env, 'KRAKEN_WS_URL', 'wss://ws.kraken.com/v2'),
    krakenRestUrl: stringValue(
      env,
      'KRAKEN_REST_URL',
      'https://api.kraken.com/0',
    ),
    marketStaleAfterMs: positiveInt(env, 'MARKET_STALE_AFTER_MS', 15_000),
    marketReconnectMinMs,
    marketReconnectMaxMs,
    intelligenceStreamMaxClients: positiveInt(
      env,
      'INTELLIGENCE_SSE_MAX_CLIENTS',
      20,
    ),
    intelligenceStreamKeepAliveMs: positiveInt(
      env,
      'INTELLIGENCE_SSE_KEEPALIVE_MS',
      15_000,
    ),
    intelligenceStreamWindowSize: positiveInt(
      env,
      'INTELLIGENCE_SSE_WINDOW_SIZE',
      200,
    ),
    futuresMode,
    futuresDbPath,
    futuresMarketDbPath: stringValue(
      env,
      'FUTURES_MARKET_DB_PATH',
      './data/futures-market.sqlite',
    ),
    futuresReplaySourceDbPath,
    futuresReplaySourceRunId,
  }
}

function futuresModeFrom(raw: string | undefined): ServerConfig['futuresMode'] {
  if (raw === undefined || raw === '') return undefined
  if (raw === 'mock' || raw === 'paper_live' || raw === 'replay') return raw
  throw new ServerConfigError(
    'FUTURES_MODE must be mock, paper_live, or replay when specified.',
  )
}

function optionalStringValue(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  return raw.trim()
}

function collectorFlag(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: boolean,
): boolean {
  return booleanValue(
    env,
    name,
    env.MARKET_COLLECTOR_ENABLED === undefined
      ? fallback
      : booleanValue(env, 'MARKET_COLLECTOR_ENABLED', fallback),
  )
}

function stringValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: string,
): string {
  const raw = env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  return raw
}

function positiveInt(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]
  if (raw === undefined || raw === '') {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new ServerConfigError(
      `${name} must be a positive integer, got ${JSON.stringify(raw)}.`,
    )
  }
  return value
}

export function parseExtraRssSources(
  raw: string | undefined,
): readonly RssSourceConfig[] {
  if (raw === undefined || raw.trim() === '') return []
  const ids = new Set<string>()
  return raw.split(',').map((entry, index) => {
    const [sourceId, source, feedUrl, licenseStatus = 'unknown'] = entry
      .split('|')
      .map((value) => value.trim())
    if (
      sourceId === undefined ||
      !/^[a-z0-9][a-z0-9_-]*$/.test(sourceId) ||
      ids.has(sourceId) ||
      source === undefined ||
      source === '' ||
      feedUrl === undefined ||
      feedUrl === '' ||
      !isHttpsUrl(feedUrl) ||
      (licenseStatus !== 'unknown' && licenseStatus !== 'licensed')
    ) {
      throw new ServerConfigError(
        `NEWS_EXTRA_RSS_FEEDS entry ${index + 1} must be sourceId|source|httpsUrl[|unknown|licensed].`,
      )
    }
    ids.add(sourceId)
    return {
      sourceId,
      source,
      feedUrl,
      documentationUrl: '',
      licenseUrl: '',
      sourceLevel: 'licensed_reporting',
      licenseStatus,
    } satisfies RssSourceConfig
  })
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function booleanValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new ServerConfigError(
    `${name} must be true, false, 1, or 0, got ${JSON.stringify(raw)}.`,
  )
}
