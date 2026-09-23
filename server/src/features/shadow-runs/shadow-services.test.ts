import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  SupportedInstrumentId,
  TimestampMs,
} from '../../domain/contracts.ts'
import { MarketStore } from '../market-data/market-store.ts'
import { ShadowRunService, ShadowRunNotFoundError } from './shadow-services.ts'
import { makeForecast, makeOutcome } from './shadow-fixtures.ts'
import { readFileSync } from 'node:fs'

const DAY = 24 * 3_600_000
const START = 100_000_000_000

const directory = mkdtempSync(join(tmpdir(), 'balancita-shadow-services-'))

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

function makeService(at: number = START) {
  let now = at
  const store = new MarketStore({
    path: join(directory, `service-${Math.random().toString(36).slice(2)}.db`),
    clock: () => now as TimestampMs,
  })
  const service = new ShadowRunService({
    store,
    instrumentId: 'BTC-EUR' as SupportedInstrumentId,
    clock: () => now as TimestampMs,
  })
  return {
    store,
    service,
    advanceTo: (next: number) => {
      now = next
    },
  }
}

function seedOneOutcome(store: MarketStore, asOfTimestamp: number) {
  const forecast = makeForecast({ id: 'svc-forecast', asOfTimestamp })
  store.insertForecast(forecast)
  store.insertOutcome(makeOutcome(forecast))
}

function seedMany(store: MarketStore, count: number, asOfTimestamp: number) {
  for (let index = 0; index < count; index += 1) {
    const forecast = makeForecast({
      id: `svc-forecast-${index}`,
      asOfTimestamp,
    })
    store.insertForecast(forecast)
    store.insertOutcome(makeOutcome(forecast))
  }
}

describe('ShadowRunService', () => {
  it('starts a canonical 30-day shadow run idempotently', () => {
    const { service } = makeService()
    const started = service.start(START)
    expect(started.outcome).toBe('inserted')
    expect(started.run.id).toBe('shadow:BTC-EUR')
    expect(started.run.plannedEndAt).toBe(START + 30 * DAY)
    const again = service.start(START)
    expect(again.outcome).toBe('duplicate')
    expect(again.run.plannedEndAt).toBe(START + 30 * DAY)
  })

  it('reports collecting status before the window completes', () => {
    const { store, service } = makeService()
    service.start(START)
    seedOneOutcome(store, START)
    const status = service.status(START + DAY)
    expect(status.computedStatus).toBe('collecting')
    expect(status.status).toBe('collecting')
    expect(status.evaluatedOutcomeCount).toBe(1)
    expect(status.minimumEvidence).toBe(10)
  })

  it('reports ready_for_review after the window with enough evidence', () => {
    const { store, service } = makeService()
    service.start(START)
    seedMany(store, 10, START)
    const status = service.status(START + 30 * DAY)
    expect(status.computedStatus).toBe('ready_for_review')
    expect(status.evaluatedOutcomeCount).toBe(10)
  })

  it('reports insufficient_evidence after the window with sparse outcomes', () => {
    const { service } = makeService()
    service.start(START)
    const status = service.status(START + 30 * DAY)
    expect(status.computedStatus).toBe('insufficient_evidence')
    expect(status.evaluatedOutcomeCount).toBe(0)
  })

  it('builds a report that references the run policy and news gaps honestly', () => {
    const { store, service } = makeService()
    service.start(START)
    seedMany(store, 10, START)
    const built = service.buildReport(START + 30 * DAY)
    expect(built.report.enoughData).toBe(true)
    expect(built.report.metrics.meta.referencePriceBase).toBe(
      'shadow-baseline.v1',
    )
    expect(built.report.metrics.news.available).toBe(false)
    expect(built.report.metrics.news.unavailableReason).toBe(
      'news_scores_not_persisted',
    )
    expect(built.report.runId).toBe('shadow:BTC-EUR')
    expect(built.report.metrics.comparative.baseline.ruleVersion).toBe(
      'shadow-baseline.v1',
    )
  })

  it('refuses to decide before the window completes', () => {
    const { store, service } = makeService()
    service.start(START)
    seedOneOutcome(store, START)
    const built = service.buildReport(START + DAY)
    expect(built.report.status).toBe('collecting')
    const result = service.decide({
      decision: 'go',
      actor: 'admin',
      reason: 'too early',
      at: START + DAY,
    })
    expect(result.outcome).toBe('rejected')
    if (result.outcome === 'rejected') {
      expect(result.reason).toBe('report_not_reviewable')
    }
  })

  it('decides go after a reviewable report and persists it once', () => {
    const { store, service } = makeService()
    service.start(START)
    seedMany(store, 10, START)
    service.buildReport(START + 30 * DAY)
    const decided = service.decide({
      decision: 'go',
      actor: 'admin',
      reason: '30 days completed',
      at: START + 30 * DAY,
    })
    expect(decided.outcome).toBe('inserted')
    const persisted =
      decided.outcome !== 'rejected' ? decided.decision : undefined
    expect(persisted?.decision).toBe('go')
    expect(persisted?.setUpstream).toBe(true)
    const replay = service.decide({
      decision: 'go',
      actor: 'admin',
      reason: '30 days completed',
      at: START + 30 * DAY,
    })
    expect(replay.outcome).toBe('duplicate')
    const stored = service.status(START + 30 * DAY)
    expect(stored.status).toBe('go')
    expect(stored.decidedAt).toBe(START + 30 * DAY)
  })

  it('rejects a go decision when the report hash does not match the latest', () => {
    const { store, service } = makeService()
    service.start(START)
    seedOneOutcome(store, START)
    service.buildReport(START + 30 * DAY)
    const result = service.decide({
      decision: 'no_go',
      actor: 'admin',
      reason: 'stale hash',
      reportHash: 'deadbeef'.repeat(8),
      at: START + 30 * DAY,
    })
    expect(result.outcome).toBe('rejected')
    if (result.outcome === 'rejected') {
      expect(result.reason).toBe('report_hash_mismatch')
    }
  })

  it('does not expose order execution, broker or Gemini capabilities', () => {
    const { service } = makeService()
    const instance = service as unknown as Record<string, unknown>
    expect(instance.previewOrder).toBeUndefined()
    expect(instance.submitOrder).toBeUndefined()
    expect(instance.executeOrder).toBeUndefined()
    expect(instance.connectBroker).toBeUndefined()
    expect(instance.analyzeNewsSentiment).toBeUndefined()
    const source = readFileSync(
      new URL('./shadow-services.ts', import.meta.url),
      'utf-8',
    )
    expect(source).not.toMatch(/OrderExecutionProvider|Gemini|gemini|coinbase/i)
    expect(source).not.toMatch(/WebSocket\(|fetch\(/)
  })

  it('raises a domain error when the run does not exist', () => {
    const { service } = makeService()
    expect(() => service.status(START + DAY)).toThrowError(
      ShadowRunNotFoundError,
    )
  })
})
