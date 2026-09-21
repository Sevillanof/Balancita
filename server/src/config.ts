import { ServerConfigError } from './analysis-errors.ts'

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
  marketDbPath: string
  krakenWsUrl: string
  krakenRestUrl: string
  marketStaleAfterMs: number
  marketReconnectMinMs: number
  marketReconnectMaxMs: number
  intelligenceStreamMaxClients: number
  intelligenceStreamKeepAliveMs: number
  intelligenceStreamWindowSize: number
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
    marketCollectorEnabled: booleanValue(
      env,
      'MARKET_COLLECTOR_ENABLED',
      false,
    ),
    marketDbPath: stringValue(env, 'MARKET_DB_PATH', './data/market.sqlite'),
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
  }
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
