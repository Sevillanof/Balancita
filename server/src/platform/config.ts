/**
 * Runtime configuration of the capture and gateway processes. Values come from
 * the environment and are validated once at bootstrap. Only public Kraken
 * Futures data is used: no API key or credential is ever read.
 */
export interface ServerConfig {
  host: string
  port: number
  corsOrigin: string
  marketStaleAfterMs: number
  marketReconnectMinMs: number
  marketReconnectMaxMs: number
  futuresMarketDbPath: string
}

export class ServerConfigError extends Error {
  readonly code = 'server_config' as const

  constructor(message: string) {
    super(message)
    this.name = 'ServerConfigError'
  }
}

const FUTURES_MODE_RETIRED_MESSAGE =
  'FUTURES_MODE fue retirado / FUTURES_MODE was retired: the futures live ' +
  'mode now runs via `pnpm run dev` (capture, gateway, verdict and paper ' +
  'processes). Elimina FUTURES_MODE de .env / Remove FUTURES_MODE from .env.'

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

  // The single-process futures modes were retired: live now runs as separate
  // processes (`pnpm run dev`). An empty value counts as unset.
  if (env.FUTURES_MODE !== undefined && env.FUTURES_MODE.trim() !== '')
    throw new ServerConfigError(FUTURES_MODE_RETIRED_MESSAGE)

  return {
    host: stringValue(env, 'HOST', '127.0.0.1'),
    port: positiveInt(env, 'PORT', 8787),
    corsOrigin: stringValue(env, 'CORS_ORIGIN', 'http://localhost:5173'),
    marketStaleAfterMs: positiveInt(env, 'MARKET_STALE_AFTER_MS', 15_000),
    marketReconnectMinMs,
    marketReconnectMaxMs,
    futuresMarketDbPath: stringValue(
      env,
      'FUTURES_MARKET_DB_PATH',
      './data/futures-market.sqlite',
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
