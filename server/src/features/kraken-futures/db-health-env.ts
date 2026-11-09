import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DEFAULT_INTEGRITY_MS,
  DEFAULT_INTEGRITY_TIMEOUT_MS,
  type BackupTarget,
} from './db-health.ts'

type Env = Readonly<Record<string, string | undefined>>

const MINUTE = 60_000

const minutesFromEnv = (env: Env, name: string, fallbackMs: number): number => {
  const value = Number(env[name])
  return Number.isFinite(value) && value > 0 ? value * MINUTE : fallbackMs
}

/**
 * Integrity check cadence from the environment: `FUTURES_DB_INTEGRITY_MINUTES` (default 360) and
 * `FUTURES_DB_INTEGRITY_TIMEOUT_MINUTES` (default 45). A missing, non-numeric or non-positive value
 * keeps the default.
 */
export function integrityFromEnv(env: Env): {
  integrityMs: number
  integrityTimeoutMs: number
} {
  return {
    integrityMs: minutesFromEnv(
      env,
      'FUTURES_DB_INTEGRITY_MINUTES',
      DEFAULT_INTEGRITY_MS,
    ),
    integrityTimeoutMs: minutesFromEnv(
      env,
      'FUTURES_DB_INTEGRITY_TIMEOUT_MINUTES',
      DEFAULT_INTEGRITY_TIMEOUT_MS,
    ),
  }
}

/**
 * Wait before the first integrity check after the capture starts: `FUTURES_DB_INTEGRITY_FIRST_DELAY_MINUTES`
 * (default 60). Reading the 10 GB market database right after a restart saturated the VPS disk for ~20-40 min,
 * exactly while Qwen warms up (odd/tasks/noticias-y-auditor.md T16). A missing or invalid value keeps 60.
 */
export function integrityFirstDelayFromEnv(env: Env): number {
  return minutesFromEnv(
    env,
    'FUTURES_DB_INTEGRITY_FIRST_DELAY_MINUTES',
    60 * MINUTE,
  )
}

/**
 * Databases the app's own daily backup copies. `futures-market` (10 GB) is OUT by default: the VPS copies it
 * every night (ops/vps balancita-respaldo.timer, 03:30 UTC) and the internal copy never finished there
 * (cut at 90 min, 57 times in a row; analisis/vps-qwen-lento). `FUTURES_DB_BACKUP_MARKET=1` puts it back
 * (first). The other databases are copied when their file exists.
 */
export function backupTargetsFromEnv(input: {
  env: Env
  marketDbPath: string
  exists?: (path: string) => boolean
}): BackupTarget[] {
  const { env } = input
  const exists = input.exists ?? existsSync
  const dataDir = dirname(input.marketDbPath)
  const market: BackupTarget[] =
    env.FUTURES_DB_BACKUP_MARKET === '1'
      ? [{ name: 'futures-market', dbPath: input.marketDbPath }]
      : []
  const others = (
    [
      [
        'qwen-live',
        env.QWEN_LIVE_DB_PATH ?? join(dataDir, 'qwen-live', 'live.sqlite'),
      ],
      [
        'futures-verdicts',
        env.FUTURES_VERDICTS_DB_PATH ??
          join(dataDir, 'futures-verdicts.sqlite'),
      ],
      [
        'positioning',
        env.POSITIONING_DB_PATH ?? join(dataDir, 'positioning.sqlite'),
      ],
      [
        'futures-news',
        env.FUTURES_NEWS_DB_PATH ?? join(dataDir, 'futures-news.sqlite'),
      ],
      [
        'futures-forecast-scores',
        join(dataDir, 'futures-forecast-scores.sqlite'),
      ],
      [
        'futures-llm-decisions',
        env.FUTURES_DECISIONS_DB_PATH ??
          join(dataDir, 'futures-llm-decisions.sqlite'),
      ],
    ] as const
  )
    .filter(([, path]) => exists(path))
    .map(([name, dbPath]) => ({ name, dbPath }))
  return [...market, ...others]
}
