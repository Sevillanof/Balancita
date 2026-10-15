import { describe, expect, it } from 'vitest'
import {
  KRONOS_MAX_AGE_MS,
  activityAt,
  kronosActivity,
  loadKronosActivity,
} from './kronos-activity.ts'
import type { QwenScores } from './qwen-scores.ts'

// DATOS DE EJEMPLO: cifras sintéticas de pruebas.
const NOW = 1_800_000_000_000
const product = (extra: Record<string, unknown> = {}) =>
  ({
    product_id: 'PF_XBTUSD',
    rows: [{ bucket_start: NOW - 3_600_000 }],
    trades: [{ entry_time_ms: NOW - 7_200_000, exit_time_ms: NOW - 3_600_000 }],
    ...extra,
  }) as unknown as QwenScores['products'][number]
const ok: QwenScores = { status: 'ok', products: [product()] }
const empty: QwenScores = { status: 'ok', products: [] }
const system = (updated: unknown) => ({
  kronos: { updated_ms: updated, trades: 4, decisions: 30, running: true },
})

describe('kronosActivity', () => {
  it('verifies only with a fresh summary and scores with data', () => {
    expect(kronosActivity(system(NOW - 60_000), ok, NOW)).toEqual({
      verified: true,
      updated_ms: NOW - 60_000,
      trades: 4,
      decisions: 30,
    })
    expect(
      kronosActivity(system(NOW - KRONOS_MAX_AGE_MS), ok, NOW).verified,
    ).toBe(true)
  })
  it('does not accept status ok with no products or no evidence', () => {
    expect(kronosActivity(system(NOW - 1000), empty, NOW)).toEqual({
      verified: false,
      reason: 'scores_without_evidence',
    })
    const bare: QwenScores = {
      status: 'ok',
      products: [product({ rows: [], trades: [] })],
    }
    expect(kronosActivity(system(NOW - 1000), bare, NOW).verified).toBe(false)
    const noStamps: QwenScores = {
      status: 'ok',
      products: [product({ rows: [{}], trades: [{ entry_time_ms: 1 }] })],
    }
    expect(kronosActivity(system(NOW - 1000), noStamps, NOW).verified).toBe(
      false,
    )
  })
  it('rejects future timestamps with a reason', () => {
    expect(kronosActivity(system(NOW + 60_000), ok, NOW)).toEqual({
      verified: false,
      reason: 'summary_in_future',
    })
    expect(kronosActivity(system(NOW + 4_000), ok, NOW).verified).toBe(true)
    for (const extra of [
      { rows: [{ bucket_start: NOW + 60_000 }] },
      { trades: [{ entry_time_ms: NOW - 1, exit_time_ms: NOW + 60_000 }] },
    ])
      expect(
        kronosActivity(
          system(NOW - 1000),
          { status: 'ok', products: [product(extra)] },
          NOW,
        ),
      ).toEqual({ verified: false, reason: 'scores_timestamp_in_future' })
  })
  it('expires with the clock', () => {
    const read = kronosActivity(system(NOW - 60_000), ok, NOW)
    expect(activityAt(read, NOW + 1000)).toBe(read)
    expect(activityAt(read, NOW - 60_000 + KRONOS_MAX_AGE_MS + 1)).toEqual({
      verified: false,
      reason: 'summary_stale',
    })
    expect(activityAt(null, NOW)).toBeNull()
  })
  it('stays unverified for every other case', () => {
    const off: QwenScores = {
      status: 'off',
      reason: 'kronos_not_configured',
      products: [],
    }
    expect(kronosActivity(system(NOW - 1000), off, NOW)).toEqual({
      verified: false,
      reason: 'kronos_not_configured',
    })
    expect(kronosActivity(system(null), ok, NOW).verified).toBe(false)
    expect(
      kronosActivity(system(NOW - KRONOS_MAX_AGE_MS - 1), ok, NOW).verified,
    ).toBe(false)
    expect(kronosActivity(null, ok, NOW).verified).toBe(false)
    expect(kronosActivity(system(NOW), null, NOW).verified).toBe(false)
    // A running process without a fresh summary is not activity.
    expect(
      kronosActivity({ kronos: { running: true, trades: 9 } }, ok, NOW)
        .verified,
    ).toBe(false)
  })
})

describe('loadKronosActivity', () => {
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }))
  it('reads /api-live/system and /api-live/kronos/scores', async () => {
    const urls: string[] = []
    const fetcher = ((url: string) => {
      urls.push(url)
      return url.includes('/system') ? json(system(NOW - 5000)) : json(ok)
    }) as unknown as typeof fetch
    const activity = await loadKronosActivity(fetcher, () => NOW)
    expect(activity.verified).toBe(true)
    expect(urls[0]).toBe('/api-live/system')
    expect(urls[1]).toContain('/api-live/kronos/scores')
  })
  it('is unverified when the gateway does not answer', async () => {
    const fetcher = (() => Promise.reject(new Error('down'))) as typeof fetch
    expect((await loadKronosActivity(fetcher, () => NOW)).verified).toBe(false)
  })
})
