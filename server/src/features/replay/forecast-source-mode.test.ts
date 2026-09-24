import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { parseTimestampMs, type TimestampMs } from '../../domain/contracts.ts'
import {
  generateForecast,
  type ForecastEngineInput,
} from '../forecasts/forecast-engine.ts'
import { validateForecastRecord } from '../forecasts/forecast-validation.ts'
import { MarketStore } from '../market-data/market-store.ts'

const directories: string[] = []

const time = (value: number): TimestampMs => {
  const result = parseTimestampMs(value)
  if (!result.valid) throw new Error('test timestamp must be valid')
  return result.value
}

function makePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'balancita-forecast-source-'))
  directories.push(directory)
  return join(directory, 'market.sqlite')
}

function baseInput(): ForecastEngineInput {
  return {
    id: 'forecast-source-1',
    version: '1',
    createdAt: time(1_100),
    asOfTimestamp: time(1_000),
    eventCutoff: time(1_000),
    horizon: '1h',
    referencePrice: 100,
    candles: [
      {
        eventTimeEnd: time(900),
        bucketEnd: time(1_000),
        close: 100,
        isClosed: true,
        status: 'live',
      },
    ],
    technicalFeatureSnapshot: {
      version: 'technical-features.v1',
      asOfTimestamp: time(900),
      isClosed: true,
      ready: true,
      warmUp: { requiredCandles: 1, availableCandles: 1, missingCandles: 0 },
      values: { sma: 99, rsi: 60, macdHistogram: 1, structuralSlope: 1 },
    },
    dataFreshness: { ageMs: 100, isStale: false, clockInverted: false },
    dataGaps: {
      gapCount: 0,
      expectedOpportunities: 1,
      rate: 0,
      sequenceAvailable: true,
    },
    newsEvidenceReferences: [],
  }
}

const LEGACY_FORECAST_JSON = JSON.stringify({
  id: 'legacy-1',
  version: '1',
  instrumentId: 'BTC-EUR',
  createdAt: 1_100,
  asOfTimestamp: 1_000,
  eventCutoff: 1_000,
  horizon: '1h',
  referencePrice: 100,
  probabilityUp: 0.5,
  probabilityDown: 0.25,
  probabilityFlat: 0.25,
  technicalFeatureSnapshot: {
    version: 'technical-features.v1',
    asOfTimestamp: 900,
    isClosed: true,
    ready: true,
    warmUp: { requiredCandles: 1, availableCandles: 1, missingCandles: 0 },
    values: { sma: 99 },
  },
  newsEvidenceReferences: [],
  dataFreshness: { ageMs: 100, isStale: false, clockInverted: false },
  dataGaps: {
    gapCount: 0,
    expectedOpportunities: 1,
    rate: 0,
    sequenceAvailable: true,
  },
  modelVersion: 'deterministic-baseline.v1',
  ruleVersion: 'technical-direction.v1',
  abstained: false,
  contentHash: 'legacy-content-hash',
})

function writeLegacyV4Database(path: string): void {
  const database = new DatabaseSync(path)
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE forecast_records (
      id TEXT NOT NULL,
      version TEXT NOT NULL,
      instrument_id TEXT NOT NULL CHECK (instrument_id = 'BTC-EUR'),
      created_at INTEGER NOT NULL,
      as_of_timestamp INTEGER NOT NULL,
      event_cutoff INTEGER NOT NULL,
      horizon TEXT NOT NULL CHECK (horizon IN ('15m', '1h', '4h', '24h')),
      content_hash TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL,
      PRIMARY KEY (id, version)
    ) STRICT;

    INSERT INTO schema_migrations (version, applied_at) VALUES
      (1, 0), (2, 0), (3, 0), (4, 0);
  `)
  database
    .prepare(
      `INSERT INTO forecast_records
        (id, version, instrument_id, created_at, as_of_timestamp, event_cutoff,
         horizon, content_hash, record_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'legacy-1',
      '1',
      'BTC-EUR',
      1_100,
      1_000,
      1_000,
      '1h',
      'legacy-content-hash',
      LEGACY_FORECAST_JSON,
    )
  database.close()
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('forecast source mode contracts', () => {
  it('defaults generated forecasts to shadow_live with no replay run', () => {
    const forecast = generateForecast(baseInput())
    expect(forecast.sourceMode).toBe('shadow_live')
    expect(forecast.replayRunId).toBeNull()

    const replay = generateForecast({
      ...baseInput(),
      sourceMode: 'historical_replay',
      replayRunId: 'run-1',
    })
    expect(replay.sourceMode).toBe('historical_replay')
    expect(replay.replayRunId).toBe('run-1')
    expect(replay.contentHash).not.toBe(forecast.contentHash)
  })

  it('validates the source mode and requires a replay run for replays', () => {
    const shadow = generateForecast(baseInput())
    expect(validateForecastRecord(shadow).valid).toBe(true)

    const replay = generateForecast({
      ...baseInput(),
      sourceMode: 'historical_replay',
      replayRunId: 'run-1',
    })
    expect(validateForecastRecord(replay).valid).toBe(true)

    const missingRun = validateForecastRecord({
      ...replay,
      replayRunId: null,
    })
    expect(missingRun.valid).toBe(false)
    if (!missingRun.valid)
      expect(missingRun.issues.map((issue) => issue.code)).toContain(
        'replay_run_required',
      )

    const strayRun = validateForecastRecord({
      ...shadow,
      replayRunId: 'run-1',
    })
    expect(strayRun.valid).toBe(false)
    if (!strayRun.valid)
      expect(strayRun.issues.map((issue) => issue.code)).toContain(
        'replay_run_forbidden',
      )

    const unsupported = validateForecastRecord({
      ...shadow,
      sourceMode: 'paper_trade',
    })
    expect(unsupported.valid).toBe(false)
    if (!unsupported.valid)
      expect(unsupported.issues.map((issue) => issue.code)).toContain(
        'invalid_source_mode',
      )
  })
})

describe('forecast source mode migration', () => {
  it('migrates a v4 database to v5 and reads legacy rows as shadow_live', () => {
    const path = makePath()
    writeLegacyV4Database(path)

    const store = new MarketStore({ path })
    expect(store.schemaVersion()).toBe(9)

    const legacy = store.getForecast('legacy-1')
    expect(legacy?.sourceMode).toBe('shadow_live')
    expect(legacy?.replayRunId).toBeNull()
    expect(store.listForecasts({ sourceMode: 'shadow_live' })).toHaveLength(1)
    expect(store.listForecasts({ sourceMode: 'historical_replay' })).toEqual([])
    store.close()
  })

  it('persists historical_replay forecasts with a replay run id', () => {
    const store = new MarketStore({ path: makePath() })
    const replay = generateForecast({
      ...baseInput(),
      sourceMode: 'historical_replay',
      replayRunId: 'run-1',
    })

    expect(store.insertForecast(replay).outcome).toBe('inserted')
    expect(store.getForecast(replay.id)).toMatchObject({
      sourceMode: 'historical_replay',
      replayRunId: 'run-1',
    })
    expect(
      store.listForecasts({ sourceMode: 'historical_replay' }),
    ).toHaveLength(1)
    expect(store.listForecasts({ sourceMode: 'shadow_live' })).toEqual([])
    store.close()
  })

  it('is idempotent across reopen and preserves migrated data', () => {
    const path = makePath()
    writeLegacyV4Database(path)

    const first = new MarketStore({ path })
    expect(first.schemaVersion()).toBe(9)
    first.close()

    const second = new MarketStore({ path })
    expect(second.schemaVersion()).toBe(9)
    expect(second.getForecast('legacy-1')?.sourceMode).toBe('shadow_live')

    const raw = new DatabaseSync(path)
    const versions = raw
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all() as { version: number }[]
    expect(versions.map((row) => row.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
    raw.close()
    second.close()
  })
})
