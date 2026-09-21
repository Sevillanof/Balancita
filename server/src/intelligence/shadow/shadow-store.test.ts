import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TimestampMs } from '../contracts.ts'
import { MarketStore } from '../market/market-store.ts'
import { contentHashFor } from '../forecast-hashing.ts'
import {
  createShadowRunStart,
  createShadowStatusRecord,
} from '../shadow/shadow-run.ts'
import { buildShadowReport } from '../shadow/shadow-report.ts'
import { createShadowDecisionInput } from '../shadow/shadow-decision.ts'
import { buildShadowMetrics } from '../shadow/shadow-aggregation.ts'
import {
  makeForecast,
  makeNewsEvidence,
  makeOutcome,
} from '../shadow/shadow-fixtures.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const START = 100_000_000_000
const AFTER_30_DAYS = START + 30 * DAY

const directory = mkdtempSync(join(tmpdir(), 'balancita-shadow-store-'))

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function openStore(path: string): MarketStore {
  return new MarketStore({
    path,
    clock: () => AFTER_30_DAYS as TimestampMs,
  })
}

function fixtureRun(store: MarketStore) {
  const start = createShadowRunStart(START as TimestampMs, 'BTC-EUR')
  store.createShadowRun(start)
  const forecast = makeForecast({
    id: 'store-forecast',
    asOfTimestamp: START,
  })
  store.insertForecast(forecast)
  const outcome = makeOutcome(forecast)
  store.insertOutcome(outcome)
  store.insertNewsEvidence(makeNewsEvidence())
  return { start, forecast, outcome }
}

function reportFor(store: MarketStore, at: number) {
  const run = store.getShadowRun(`shadow:BTC-EUR`)
  const start =
    run ??
    (() => {
      throw new Error('run missing')
    })()
  const forecasts = store
    .listForecasts({ instrumentId: 'BTC-EUR' })
    .filter(
      (forecast) =>
        forecast.asOfTimestamp >= start.startedAt &&
        forecast.asOfTimestamp <= at,
    )
  const outcomeIds = new Set(forecasts.map((f) => `${f.id}:${f.version}`))
  const outcomes = store
    .listOutcomes()
    .filter((o) => outcomeIds.has(`${o.forecastId}:${o.forecastVersion}`))
  const newsEvidence = store.listNewsEvidence({}).length
  const metrics = buildShadowMetrics(forecasts, outcomes, at, newsEvidence)
  return buildShadowReport({
    run: start,
    metrics,
    now: at,
    storedNewsEvidenceCount: newsEvidence,
    minimumEvidence: 1,
  })
}

describe('MarketStore shadow migrations', () => {
  it('migrates schema v3 to v4 adding shadow tables', () => {
    const dbPath = join(directory, 'shadow-migration.db')
    {
      const store = openStore(dbPath)
      store.close()
    }
    const store = openStore(dbPath)
    expect(store.schemaVersion()).toBe(5)
    const names = store.listShadowTables()
    expect(names).toEqual(
      expect.arrayContaining([
        'shadow_runs',
        'shadow_run_status',
        'shadow_reports',
        'shadow_decisions',
      ]),
    )
    store.close()
  })
})

describe('MarketStore shadow runs', () => {
  it('creates an idempotent 30-day run that survives restart', () => {
    const dbPath = join(directory, 'shadow-persist.db')
    const first = openStore(dbPath)
    const start = createShadowRunStart(START as TimestampMs, 'BTC-EUR')
    const inserted = first.createShadowRun(start)
    expect(inserted.outcome).toBe('inserted')
    expect(inserted.contentHash).toBe(start.contentHash)
    const duplicate = first.createShadowRun(start)
    expect(duplicate.outcome).toBe('duplicate')
    first.close()

    const reopened = openStore(dbPath)
    const run = reopened.getShadowRun('shadow:BTC-EUR')
    expect(run).toBeDefined()
    expect(run?.plannedEndAt).toBe(START + 30 * DAY)
    expect(run?.status).toBe('collecting')
    expect(run?.versions.policyVersion).toBe('shadow-policy.v1')
    reopened.close()
  })

  it('records append-only status transitions', () => {
    const store = openStore(join(directory, 'shadow-status.db'))
    fixtureRun(store)
    const collecting = createShadowStatusRecord(
      'shadow:BTC-EUR',
      'collecting',
      START,
    )
    store.recordShadowStatus(collecting)
    const reviewable = createShadowStatusRecord(
      'shadow:BTC-EUR',
      'ready_for_review',
      AFTER_30_DAYS,
      { reportHash: 'deadbeef'.repeat(8) },
    )
    store.recordShadowStatus(reviewable)
    const replay = createShadowStatusRecord(
      'shadow:BTC-EUR',
      'ready_for_review',
      AFTER_30_DAYS,
      { reportHash: 'deadbeef'.repeat(8) },
    )
    expect(store.recordShadowStatus(replay).outcome).toBe('duplicate')

    const latest = store.getShadowStatus('shadow:BTC-EUR')
    expect(latest?.status).toBe('ready_for_review')
    expect(store.listShadowStatuses('shadow:BTC-EUR')).toHaveLength(3)
    store.close()
  })

  it('rejects unknown runs for status records', () => {
    const store = openStore(join(directory, 'shadow-status-unknown.db'))
    const status = createShadowStatusRecord('shadow:nope', 'collecting', START)
    expect(() => store.recordShadowStatus(status)).toThrowError(/run/i)
    store.close()
  })
})

describe('MarketStore shadow reports', () => {
  it('saves idempotent reports and refuses conflicts', () => {
    const store = openStore(join(directory, 'shadow-report.db'))
    fixtureRun(store)
    const report = reportFor(store, AFTER_30_DAYS)
    expect(report.status).toBe('ready_for_review')
    const inserted = store.saveShadowReport(report)
    expect(inserted.outcome).toBe('inserted')

    const again = store.saveShadowReport(report)
    expect(again.outcome).toBe('duplicate')

    const loaded = store.getShadowReport('shadow:BTC-EUR')
    expect(loaded?.contentHash).toBe(report.contentHash)
    expect(loaded?.runId).toBe('shadow:BTC-EUR')

    const conflicted = { ...report, contentHash: 'different'.repeat(8) }
    expect(() => store.saveShadowReport(conflicted)).toThrowError(/conflict/i)
    store.close()
  })

  it('records the report status with the report hash on save', () => {
    const store = openStore(join(directory, 'shadow-report-status.db'))
    fixtureRun(store)
    const report = reportFor(store, AFTER_30_DAYS)
    store.saveShadowReport(report)
    const latest = store.getShadowStatus('shadow:BTC-EUR')
    expect(latest?.status).toBe('ready_for_review')
    expect(latest?.reportHash).toBe(report.contentHash)
    store.close()
  })
})

describe('MarketStore shadow decisions', () => {
  it('records a go decision only after a reviewable report', () => {
    const store = openStore(join(directory, 'shadow-decision-go.db'))
    fixtureRun(store)
    const report = reportFor(store, AFTER_30_DAYS)
    store.saveShadowReport(report)
    const decision = createShadowDecisionInput({
      runId: 'shadow:BTC-EUR',
      decision: 'go',
      reportId: report.id,
      reportHash: report.contentHash,
      actor: 'admin',
      reason: '30 days completed',
      decidedAt: AFTER_30_DAYS,
    })
    expect(store.recordShadowDecision(decision).outcome).toBe('inserted')
    const replay = createShadowDecisionInput({
      runId: 'shadow:BTC-EUR',
      decision: 'go',
      reportId: report.id,
      reportHash: report.contentHash,
      actor: 'admin',
      reason: '30 days completed',
      decidedAt: AFTER_30_DAYS,
    })
    expect(store.recordShadowDecision(replay).outcome).toBe('duplicate')
    expect(store.getShadowDecision('shadow:BTC-EUR')?.decision).toBe('go')
    expect(store.getShadowStatus('shadow:BTC-EUR')?.status).toBe('go')
    store.close()
  })

  it('rejects a no_go decision that re-enables upstream buying', () => {
    const store = openStore(join(directory, 'shadow-decision-nogo.db'))
    fixtureRun(store)
    const report = reportFor(store, AFTER_30_DAYS)
    store.saveShadowReport(report)
    const noGo = createShadowDecisionInput({
      runId: 'shadow:BTC-EUR',
      decision: 'no_go',
      reportId: report.id,
      reportHash: report.contentHash,
      actor: 'admin',
      reason: 'coverage below minimum',
      decidedAt: AFTER_30_DAYS,
    })
    expect(store.recordShadowDecision(noGo).outcome).toBe('inserted')
    expect(noGo.setUpstream).toBe(false)
    store.close()
  })

  it('rejects a go decision for a collecting run', () => {
    const store = openStore(join(directory, 'shadow-decision-collecting.db'))
    fixtureRun(store)
    const report = reportFor(store, START + DAY)
    expect(report.status).toBe('collecting')
    store.saveShadowReport(report)
    const decision = createShadowDecisionInput({
      runId: 'shadow:BTC-EUR',
      decision: 'go',
      reportId: report.id,
      reportHash: report.contentHash,
      actor: 'admin',
      reason: 'too early',
      decidedAt: START + DAY,
    })
    expect(() => store.recordShadowDecision(decision)).toThrowError(
      /reviewable/i,
    )
    store.close()
  })

  it('rejects decisions for unknown reports or mismatched hashes', () => {
    const store = openStore(join(directory, 'shadow-decision-unknown.db'))
    fixtureRun(store)
    const missingReport = createShadowDecisionInput({
      runId: 'shadow:BTC-EUR',
      decision: 'go',
      reportHash: 'deadbeef'.repeat(8),
      actor: 'admin',
      reason: 'whatever',
      decidedAt: AFTER_30_DAYS,
    })
    expect(() => store.recordShadowDecision(missingReport)).toThrowError(
      /report/i,
    )
    const report = reportFor(store, AFTER_30_DAYS)
    store.saveShadowReport(report)
    const wrongHash = createShadowDecisionInput({
      runId: 'shadow:BTC-EUR',
      decision: 'no_go',
      reportId: report.id,
      reportHash: 'deadbeef'.repeat(8),
      actor: 'admin',
      reason: 'stale hash',
      decidedAt: AFTER_30_DAYS,
    })
    expect(() => store.recordShadowDecision(wrongHash)).toThrowError(/hash/i)
    store.close()
  })

  it('rejects a second different decision after the run is decided', () => {
    const store = openStore(join(directory, 'shadow-decision-twice.db'))
    fixtureRun(store)
    const report = reportFor(store, AFTER_30_DAYS)
    store.saveShadowReport(report)
    const first = createShadowDecisionInput({
      runId: 'shadow:BTC-EUR',
      decision: 'go',
      reportId: report.id,
      reportHash: report.contentHash,
      actor: 'admin',
      reason: 'manual_decision',
      decidedAt: AFTER_30_DAYS,
    })
    store.recordShadowDecision(first)
    const second = createShadowDecisionInput({
      runId: 'shadow:BTC-EUR',
      decision: 'no_go',
      reportId: report.id,
      reportHash: report.contentHash,
      actor: 'admin',
      reason: 'changed my mind',
      decidedAt: AFTER_30_DAYS + 1,
    })
    expect(() => store.recordShadowDecision(second)).toThrowError(/already/i)
    store.close()
  })

  it('restores a persisted decision identically across restarts', () => {
    const dbPath = join(directory, 'shadow-decision-restore.db')
    const store = openStore(dbPath)
    fixtureRun(store)
    const report = reportFor(store, AFTER_30_DAYS)
    store.saveShadowReport(report)
    const decision = createShadowDecisionInput({
      runId: 'shadow:BTC-EUR',
      decision: 'go',
      reportId: report.id,
      reportHash: report.contentHash,
      actor: 'admin',
      reason: 'manual_decision',
      decidedAt: AFTER_30_DAYS,
    })
    const inserted = store.recordShadowDecision(decision)
    store.close()

    const reopened = openStore(dbPath)
    const stored = reopened.getShadowDecision('shadow:BTC-EUR')
    const restored = createShadowDecisionInput({
      runId: stored!.runId,
      decision: stored!.decision,
      reportId: stored!.reportId,
      reportHash: stored!.reportHash,
      actor: stored!.actor,
      reason: stored!.reason,
      decidedAt: stored!.decidedAt,
    })
    expect(restored.contentHash).toBe(inserted.contentHash)
    expect(restored).toEqual(decision)
    reopened.close()
  })
})

describe('MarketStore shadow immutability', () => {
  it('does not mutate forecast, outcome or news evidence counts', () => {
    const store = openStore(join(directory, 'shadow-immutable.db'))
    fixtureRun(store)
    expect(store.forecastCount()).toBe(1)
    expect(store.newsEvidenceCount()).toBe(1)
    expect(store.listOutcomes()).toHaveLength(1)
    const report = reportFor(store, AFTER_30_DAYS)
    store.saveShadowReport(report)
    const decision = createShadowDecisionInput({
      runId: 'shadow:BTC-EUR',
      decision: 'go',
      reportId: report.id,
      reportHash: report.contentHash,
      actor: 'admin',
      reason: 'manual_decision',
      decidedAt: AFTER_30_DAYS,
    })
    store.recordShadowDecision(decision)
    expect(store.forecastCount()).toBe(1)
    expect(store.newsEvidenceCount()).toBe(1)
    expect(store.listOutcomes()).toHaveLength(1)
    store.close()
  })

  it('keeps report hashes stable across identical regeneration', () => {
    const store = openStore(join(directory, 'shadow-report-hash.db'))
    fixtureRun(store)
    const a = reportFor(store, AFTER_30_DAYS)
    const b = reportFor(store, AFTER_30_DAYS)
    expect(a.contentHash).toBe(b.contentHash)
    expect(contentHashFor({ ...a, contentHash: undefined })).toBe(a.contentHash)
    store.close()
  })
})
