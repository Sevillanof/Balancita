import { describe, expect, it } from 'vitest'
import { getActiveCandidates, getAllCandidates } from './candidate-manifest.ts'
import {
  confirmationCohort,
  selectSeededTimeWindow,
  selectSeededWindow,
} from './sample-window.ts'

describe('selectSeededWindow', () => {
  it('selects reproducible contiguous windows without shuffling observations', () => {
    const observations = Array.from({ length: 30 }, (_, index) => index)
    const first = selectSeededWindow(observations, 10, 17, (value) => value)
    const again = selectSeededWindow(observations, 10, 17, (value) => value)
    expect(first).toEqual(again)
    expect(first.values).toEqual(
      observations.slice(first.startIndex, first.startIndex + 10),
    )
  })

  it('fails when no continuous segment can hold the requested window', () => {
    expect(() =>
      selectSeededWindow([0, 1, 8, 9], 3, 2, (value) => value, 2),
    ).toThrow(/continuous/i)
  })

  it('samples minute-aligned time starts for an exact one-hour interval', () => {
    const minute = 60_000
    const timestamps = Array.from({ length: 180 }, (_, index) => index * minute)
    const selected = selectSeededTimeWindow(
      timestamps,
      60 * minute,
      19,
      (value) => value,
    )
    expect(selected.since % minute).toBe(0)
    expect(selected.until - selected.since).toBe(60 * minute)
    expect(selected.seed).toBe(19)
  })

  it('chooses uniformly over minute starts, independent of tick density', () => {
    const minute = 60_000
    const trades = [
      { time: 0, id: 'a' },
      ...Array.from({ length: 100 }, (_, index) => ({
        time: minute + index,
        id: `dense-${index}`,
      })),
      { time: 2 * minute, id: 'b' },
      { time: 3 * minute, id: 'c' },
    ]
    const selected = selectSeededTimeWindow(
      trades,
      2 * minute,
      7,
      (trade) => trade.time,
    )
    expect(selected.since % minute).toBe(0)
    expect(selected.until - selected.since).toBe(2 * minute)
  })

  it('does not allow a confirmation block to overlap smoke plus horizon embargo', () => {
    const minute = 60_000
    const values = Array.from(
      { length: 8 * 24 * 60 },
      (_, index) => index * minute,
    )
    const smoke = { since: 60 * minute, until: 120 * minute }
    const confirmation = selectSeededTimeWindow(
      values,
      3 * 24 * 60 * minute,
      3,
      (value) => value,
      {
        maxGapMs: minute,
        after: smoke.until + 60 * minute,
      },
    )
    expect(confirmation.since).toBeGreaterThanOrEqual(smoke.until + 60 * minute)
  })

  it('rejects missing, stale, and manifest-mismatched smoke reports', () => {
    const smoke = {
      manifestHash: 'current',
      sample: {
        stage: 'smoke',
        until: 90_000,
        horizons: ['15m'],
        candidateIds: [],
      },
      request: { horizons: ['15m'] },
      reports: [],
    }
    expect(() => confirmationCohort(null, 'current', new Set())).toThrow(
      /latest compatible/i,
    )
    expect(() =>
      confirmationCohort(
        { ...smoke, manifestHash: 'old' },
        'current',
        new Set(),
      ),
    ).toThrow(/latest compatible/i)
    expect(() =>
      confirmationCohort(
        { ...smoke, sample: { ...smoke.sample, stage: 'confirm' } },
        'current',
        new Set(),
      ),
    ).toThrow(/latest compatible/i)
  })

  it('keeps every known active candidate regardless of selection score and records the embargo', () => {
    const cohort = confirmationCohort(
      {
        manifestHash: 'current',
        sample: {
          stage: 'smoke',
          until: 90_000,
          horizons: ['15m'],
          candidateIds: ['fourth', 'best', 'second', 'third'],
        },
        request: { horizons: ['15m'] },
        reports: [
          {
            horizon: '15m',
            contentHash: 'selection-hash',
            rows: [
              { candidateId: 'fourth', brier: 0.4 },
              { candidateId: 'best', brier: 0.1 },
              { candidateId: 'second', brier: 0.2 },
              { candidateId: 'third', brier: 0.3 },
              { candidateId: 'no-score', brier: null },
            ],
          },
        ],
      },
      'current',
      new Set(['best', 'second', 'third', 'fourth']),
    )
    expect(cohort).toEqual({
      candidateIds: ['fourth', 'best', 'second', 'third'],
      embargoedUntil: 3_690_000,
      smokeReportHash: 'selection-hash',
    })
  })

  it('keeps all active micro candidates from diagnostics when the smoke has no legacy rows', () => {
    const cohort = confirmationCohort(
      {
        manifestHash: 'current',
        sample: {
          stage: 'smoke',
          until: 90_000,
          horizons: ['15m'],
          candidateIds: ['micro-a', 'micro-b', 'micro-c', 'micro-d'],
        },
        request: { horizons: ['15m'] },
        reports: [
          {
            horizon: '15m',
            contentHash: 'micro-selection-hash',
            rows: [],
            microCandidateDiagnostics: {
              candidates: [
                { candidateId: 'micro-a', selectionBrier: 0.3 },
                { candidateId: 'micro-b', selectionBrier: 0.1 },
                { candidateId: 'micro-c', selectionBrier: 0.2 },
                { candidateId: 'micro-d', selectionBrier: 0.4 },
              ],
            },
          },
        ],
      },
      'current',
      new Set(['micro-a', 'micro-b', 'micro-c', 'micro-d']),
    )
    expect(cohort.candidateIds).toEqual([
      'micro-a',
      'micro-b',
      'micro-c',
      'micro-d',
    ])
  })

  it('fails closed when smoke provenance omits or adds a candidate', () => {
    const smoke = {
      manifestHash: 'current',
      sample: {
        stage: 'smoke',
        until: 90_000,
        horizons: ['15m'],
        candidateIds: ['active-a', 'active-b', 'active-c'],
      },
      request: { horizons: ['15m'] },
      reports: [
        {
          horizon: '15m',
          contentHash: 'selection-hash',
          rows: [{ candidateId: 'winner', brier: 0.01 }],
        },
      ],
    }
    expect(() =>
      confirmationCohort(
        smoke,
        'current',
        new Set(['active-a', 'active-b', 'active-c', 'active-d']),
      ),
    ).toThrow(/candidate set does not match/i)
  })

  it('rejects duplicate active candidate IDs even when provenance length matches', () => {
    const activeIds = getActiveCandidates().map(
      ({ candidateId }) => candidateId,
    )
    const duplicatedIds = [...activeIds]
    duplicatedIds[duplicatedIds.length - 1] = duplicatedIds[0]!

    expect(() =>
      confirmationCohort(
        {
          manifestHash: 'current',
          sample: {
            stage: 'smoke',
            until: 90_000,
            horizons: ['15m'],
            candidateIds: duplicatedIds,
          },
          request: { horizons: ['15m'] },
          reports: [
            { horizon: '15m', contentHash: 'selection-hash', rows: [] },
          ],
        },
        'current',
        new Set(activeIds),
      ),
    ).toThrow(/candidate set does not match/i)
  })

  it('rejects an unknown same-length candidate and never returns archived IDs', () => {
    const activeIds = getActiveCandidates().map(
      ({ candidateId }) => candidateId,
    )
    const archived = getAllCandidates().find(
      ({ status }) => status === 'archived',
    )!
    const unknownIds = [...activeIds.slice(0, -1), 'unregistered-candidate']
    const report = {
      manifestHash: 'current',
      sample: {
        stage: 'smoke',
        until: 90_000,
        horizons: ['15m'],
        candidateIds: activeIds,
      },
      request: { horizons: ['15m'] },
      reports: [
        {
          horizon: '15m',
          contentHash: 'selection-hash',
          rows: [{ candidateId: archived.candidateId, brier: 0 }],
        },
      ],
    }

    expect(() =>
      confirmationCohort(
        { ...report, sample: { ...report.sample, candidateIds: unknownIds } },
        'current',
        new Set(activeIds),
      ),
    ).toThrow(/candidate set does not match/i)

    const cohort = confirmationCohort(report, 'current', new Set(activeIds))
    expect(cohort.candidateIds).toEqual(activeIds)
    expect(cohort.candidateIds).not.toContain(archived.candidateId)
  })
})
