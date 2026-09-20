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
  maxCandles: number
  corsOrigin: string
}

const DEFAULT_MODEL = 'gemini-3.5-flash-lite'

export function serverConfigFrom(
  env: Readonly<Record<string, string | undefined>>,
): ServerConfig {
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
      15,
    ),
    maxRequestsPerDay: positiveInt(env, 'GEMINI_MAX_REQUESTS_PER_DAY', 500),
    cacheMaxEntries: positiveInt(env, 'GEMINI_CACHE_MAX_ENTRIES', 100),
    maxCandles: positiveInt(env, 'GEMINI_MAX_CANDLES', 500),
    corsOrigin: stringValue(
      env,
      'GEMINI_SERVER_CORS_ORIGIN',
      'http://localhost:5173',
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
