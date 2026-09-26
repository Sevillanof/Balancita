import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { readMarketDataCoverage } from './market-data-coverage.ts'

function databaseWithSources(): DatabaseSync {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    CREATE TABLE market_observations (
      source TEXT, instrument_id TEXT, event_time INTEGER, received_time INTEGER
    );
    CREATE TABLE candles_1m_kraken (timestamp INTEGER);
  `)
  return database
}

describe('readMarketDataCoverage', () => {
  it('does not interpret quiet periods between irregular observations as gaps', () => {
    const database = databaseWithSources()
    database.exec(`
      INSERT INTO market_observations VALUES
        ('kraken', 'BTC-EUR', 100000, 101000),
        ('kraken', 'BTC-EUR', 220000, 221000);
    `)
    database.exec('PRAGMA query_only = ON')

    const coverage = readMarketDataCoverage(database, 250_000)
    expect(coverage.observations.gaps).toEqual({
      status: 'not_measured',
      reason: expect.stringContaining('irregular'),
    })
    expect(coverage.observations.timeSpanMs).toBe(120_000)
    expect(coverage.observations.coverageAdequacy).toBe('insufficient')
    expect(coverage.observations.freshnessStatus).toBe('fresh')
    database.close()
  })

  it('uses maximum receive time independently of event ordering and aggregates rows', () => {
    const database = databaseWithSources()
    database.exec(`
      INSERT INTO market_observations VALUES
        ('kraken', 'BTC-EUR', 220000, 230000),
        ('kraken', 'BTC-EUR', 100000, 300000);
    `)
    database.exec('PRAGMA query_only = ON')

    const coverage = readMarketDataCoverage(database, 350_000)
    expect(coverage.observations.maxReceivedTime).toBe(300_000)
    expect(coverage.observations.count).toBe(2)
    database.close()
  })

  it('reports OHLC gaps, stale samples, and clamps future-event age with a clock warning', () => {
    const database = databaseWithSources()
    database.exec(`
      INSERT INTO market_observations VALUES
        ('kraken', 'BTC-EUR', 500000, 499000);
      INSERT INTO candles_1m_kraken VALUES (100), (160), (280);
    `)
    database.exec('PRAGMA query_only = ON')

    const coverage = readMarketDataCoverage(database, 500_000, {
      staleAfterMs: 60_000,
    })
    expect(coverage.observations).toMatchObject({
      ageMs: 0,
      clockInverted: false,
      coverageAdequacy: 'insufficient',
      freshnessStatus: 'fresh',
    })
    expect(coverage.ohlc).toMatchObject({
      gapCount: 1,
      status: 'insufficient',
      freshnessStatus: 'stale',
      coverageAdequacy: 'insufficient',
    })
    expect(
      readMarketDataCoverage(database, 200_000, { staleAfterMs: 60_000 })
        .observations,
    ).toMatchObject({
      ageMs: 0,
      clockInverted: true,
      freshnessStatus: 'future_dated',
      status: 'insufficient',
    })
    database.close()
  })

  it('marks insufficient one-row coverage and absent legacy tables without migration', () => {
    const database = databaseWithSources()
    database.exec(
      `INSERT INTO market_observations VALUES ('kraken', 'BTC-EUR', 100000, 100000)`,
    )
    database.exec('PRAGMA query_only = ON')
    expect(readMarketDataCoverage(database, 100_000).observations.status).toBe(
      'insufficient',
    )
    database.close()

    const legacy = new DatabaseSync(':memory:')
    legacy.exec('PRAGMA query_only = ON')
    const absent = readMarketDataCoverage(legacy, 100_000)
    expect(absent.observations).toMatchObject({
      count: 0,
      gaps: { status: 'not_measured' },
      status: 'missing',
    })
    expect(absent.ohlc).toMatchObject({ count: 0, status: 'missing' })
    legacy.close()
  })

  it('does not call a year of OHLC span adequate when internal bars are missing', () => {
    const database = databaseWithSources()
    const yearSeconds = 365 * 24 * 60 * 60
    database.exec(
      `INSERT INTO candles_1m_kraken VALUES (0), (${yearSeconds + 60})`,
    )
    database.exec('PRAGMA query_only = ON')

    const coverage = readMarketDataCoverage(
      database,
      (yearSeconds + 60) * 1000,
      { staleAfterMs: 0 },
    )
    expect(coverage.ohlc.timeSpanMs).toBeGreaterThanOrEqual(
      365 * 24 * 60 * 60 * 1000,
    )
    expect(coverage.ohlc.gapCount).toBe(1)
    expect(coverage.ohlc.coverageAdequacy).toBe('insufficient')
    expect(coverage.ohlc.status).toBe('insufficient')
    expect(coverage.ohlc.reason).toMatch(/internal gap/i)
    database.close()
  })

  it('keeps long observation spans separate from unmeasured source completeness', () => {
    const database = databaseWithSources()
    const yearMs = 365 * 24 * 60 * 60 * 1000
    database.exec(`
      INSERT INTO market_observations VALUES
        ('kraken', 'BTC-EUR', 0, 0),
        ('kraken', 'BTC-EUR', ${yearMs}, ${yearMs});
    `)
    database.exec('PRAGMA query_only = ON')

    const coverage = readMarketDataCoverage(database, yearMs)
    expect(coverage.observations.timeSpanMs).toBe(yearMs)
    expect(coverage.observations.coverageAdequacy).toBe('unknown')
    expect(coverage.observations.completeness).toBe('unknown')
    expect(coverage.observations.freshnessStatus).toBe('fresh')
    expect(coverage.observations.status).toBe('unverified')
    database.close()
  })
})
