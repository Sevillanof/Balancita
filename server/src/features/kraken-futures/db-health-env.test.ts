import { describe, expect, it } from 'vitest'
import {
  backupTargetsFromEnv,
  integrityFirstDelayFromEnv,
  integrityFromEnv,
} from './db-health-env.ts'

const MIN = 60_000

describe('integrity check settings from the environment', () => {
  it('waits 60 minutes after start before the first check, so a restart does not saturate the disk while Qwen warms up', () => {
    expect(integrityFirstDelayFromEnv({})).toBe(60 * MIN)
  })

  it('FUTURES_DB_INTEGRITY_FIRST_DELAY_MINUTES overrides the first wait; an invalid value keeps 60', () => {
    expect(
      integrityFirstDelayFromEnv({
        FUTURES_DB_INTEGRITY_FIRST_DELAY_MINUTES: '5',
      }),
    ).toBe(5 * MIN)
    expect(
      integrityFirstDelayFromEnv({
        FUTURES_DB_INTEGRITY_FIRST_DELAY_MINUTES: 'abc',
      }),
    ).toBe(60 * MIN)
  })

  it('defaults to every 6 hours with a 45 minute limit', () => {
    expect(integrityFromEnv({})).toEqual({
      integrityMs: 360 * MIN,
      integrityTimeoutMs: 45 * MIN,
    })
  })

  it('FUTURES_DB_INTEGRITY_MINUTES overrides the interval only', () => {
    expect(integrityFromEnv({ FUTURES_DB_INTEGRITY_MINUTES: '15' })).toEqual({
      integrityMs: 15 * MIN,
      integrityTimeoutMs: 45 * MIN,
    })
  })

  it('FUTURES_DB_INTEGRITY_TIMEOUT_MINUTES overrides the limit only', () => {
    expect(
      integrityFromEnv({ FUTURES_DB_INTEGRITY_TIMEOUT_MINUTES: '10' }),
    ).toEqual({ integrityMs: 360 * MIN, integrityTimeoutMs: 10 * MIN })
  })

  it.each(['', 'abc', '0', '-5'])(
    'ignores the invalid value %j and keeps the defaults',
    (value) => {
      expect(
        integrityFromEnv({
          FUTURES_DB_INTEGRITY_MINUTES: value,
          FUTURES_DB_INTEGRITY_TIMEOUT_MINUTES: value,
        }),
      ).toEqual({ integrityMs: 360 * MIN, integrityTimeoutMs: 45 * MIN })
    },
  )
})

describe('databases copied by the internal backup', () => {
  const marketDbPath = '/data/dev-live/futures-market.sqlite'
  const names = (
    env: Record<string, string | undefined>,
    exists = () => true,
  ) => backupTargetsFromEnv({ env, marketDbPath, exists }).map((t) => t.name)

  it('leaves futures-market out by default (the nightly ops/vps backup covers it)', () => {
    expect(names({})).toEqual([
      'qwen-live',
      'futures-verdicts',
      'positioning',
      'futures-news',
      'futures-forecast-scores',
      'futures-llm-decisions',
    ])
  })

  it('FUTURES_DB_BACKUP_MARKET=1 puts futures-market back, first, even if its file is not there yet', () => {
    const targets = backupTargetsFromEnv({
      env: { FUTURES_DB_BACKUP_MARKET: '1' },
      marketDbPath,
      exists: () => false,
    })
    expect(targets).toEqual([{ name: 'futures-market', dbPath: marketDbPath }])
    expect(names({ FUTURES_DB_BACKUP_MARKET: '1' })[0]).toBe('futures-market')
  })

  it.each(['0', '', 'true'])(
    'FUTURES_DB_BACKUP_MARKET=%j keeps it out (only 1 turns it on)',
    (value) => {
      expect(names({ FUTURES_DB_BACKUP_MARKET: value })).not.toContain(
        'futures-market',
      )
    },
  )

  it('keeps skipping databases that do not exist and honours the path variables', () => {
    const targets = backupTargetsFromEnv({
      env: { QWEN_LIVE_DB_PATH: '/q/live.sqlite' },
      marketDbPath,
      exists: (path) => path === '/q/live.sqlite',
    })
    expect(targets).toEqual([{ name: 'qwen-live', dbPath: '/q/live.sqlite' }])
  })
})
