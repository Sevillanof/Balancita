import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesMarketStore } from './futures-market-store.ts'
import {
  fundingLiteralExtract,
  parseHistoricalFundingResponse,
} from './historical-funding.ts'

const HOUR = 3_600_000
const T0 = Math.floor(1_790_000_000_000 / HOUR) * HOUR

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const open = () => {
  const dir = mkdtempSync(join(tmpdir(), 'funding-sightings-'))
  dirs.push(dir)
  const path = join(dir, 'market.sqlite')
  return { path, store: new FuturesMarketStore(path) }
}

// Periods start at T0 + k hours; `rates` maps k to the exact rate text.
const response = (
  rates: Array<[number, string]>,
  receivedAt: number,
  serverTime = new Date(receivedAt).toISOString(),
) =>
  parseHistoricalFundingResponse(
    JSON.stringify({
      result: 'success',
      serverTime,
      rates: rates.map(([k, rate]) => ({
        timestamp: new Date(T0 + k * HOUR).toISOString(),
        fundingRate: Number(rate),
        relativeFundingRate: 0.00001,
      })),
    }),
    receivedAt,
  )

const poll = (
  store: FuturesMarketStore,
  receivedAt: number,
  rates: Array<[number, string]>,
  purpose: 'startup' | 'hourly' | 'retry' | 'settle' = 'hourly',
  productId = 'PF_XBTUSD',
) =>
  store.recordFundingPoll({
    productId,
    purpose,
    scheduledAt: receivedAt - 5,
    startedAt: receivedAt - 3,
    finishedAt: receivedAt,
    outcome: 'ok',
    response: response(rates, receivedAt),
  })

describe('funding sightings and attempts (#184)', () => {
  it('records one sighting per closed period inside the two hour window', () => {
    const { store } = open()
    // At T0+3h+30s: periods 0..2 are closed; only 1 and 2 ended within 2 h; 3 is open.
    const result = poll(store, T0 + 3 * HOUR + 30_000, [
      [0, '0.1'],
      [1, '0.2'],
      [2, '0.3'],
      [3, '0.4'],
    ])
    expect(result.sightings).toBe(2)
    const rows = store.fundingSightings('PF_XBTUSD', Number.MAX_SAFE_INTEGER)!
    expect(rows.map((r) => [r.startMs, r.fundingRate])).toEqual([
      [T0 + 1 * HOUR, '0.2'],
      [T0 + 2 * HOUR, '0.3'],
    ])
    expect(rows[0]!.endMs).toBe(T0 + 2 * HOUR)
    store.close()
  })

  it('keeps every sighting, even the same rate with another hash, and shows a rate change as two rows', () => {
    const { store } = open()
    poll(store, T0 + 2 * HOUR + 30_000, [[1, '0.2']], 'hourly')
    poll(store, T0 + 2 * HOUR + 660_000, [[1, '0.2']], 'settle')
    poll(store, T0 + 3 * HOUR + 30_000, [[1, '0.25']], 'hourly')
    const rows = store.fundingSightings('PF_XBTUSD', Number.MAX_SAFE_INTEGER)!
    expect(rows.map((r) => [r.receivedAt, r.fundingRate])).toEqual([
      [T0 + 2 * HOUR + 30_000, '0.2'],
      [T0 + 2 * HOUR + 660_000, '0.2'],
      [T0 + 3 * HOUR + 30_000, '0.25'],
    ])
    expect(new Set(rows.map((r) => r.sha256)).size).toBe(3)
    store.close()
  })

  it('does not write a sighting twice for the same product, period and instant', () => {
    const { store } = open()
    const at = T0 + 2 * HOUR + 30_000
    poll(store, at, [[1, '0.2']])
    expect(poll(store, at, [[1, '0.2']]).sightings).toBe(0)
    store.close()
  })

  it('keeps the raw serverTime and a verifiable literal extract per attempt', () => {
    const { store, path } = open()
    const at = T0 + 2 * HOUR + 30_000
    store.recordFundingPoll({
      productId: 'PF_XBTUSD',
      purpose: 'hourly',
      scheduledAt: at,
      startedAt: at,
      finishedAt: at + 10,
      outcome: 'ok',
      response: parseHistoricalFundingResponse(
        JSON.stringify({
          result: 'success',
          serverTime: '2026-10-05T12:00:30.12Z',
          rates: [
            {
              timestamp: new Date(T0 + HOUR).toISOString(),
              fundingRate: 0.2,
              relativeFundingRate: 0.00001,
            },
          ],
        }),
        at,
      ),
    })
    store.close()
    const db = new DatabaseSync(path, { readOnly: true })
    const sighting = db
      .prepare('SELECT * FROM paper_futures_funding_sightings')
      .get() as { server_time: string }
    expect(sighting.server_time).toBe('2026-10-05T12:00:30.12Z')
    const row = db
      .prepare(
        'SELECT extract_text, extract_sha256 FROM paper_futures_funding_polls',
      )
      .get() as { extract_text: string; extract_sha256: string }
    expect(row.extract_text.split('\n')[0]).toBe(
      'serverTime=2026-10-05T12:00:30.12Z',
    )
    expect(row.extract_text).toContain('"fundingRate":0.2')
    expect(createHash('sha256').update(row.extract_text).digest('hex')).toBe(
      row.extract_sha256,
    )
    db.close()
  })

  it('records a failed attempt without a hash and a sighting-free ok attempt', () => {
    const { store, path } = open()
    store.recordFundingPoll({
      productId: 'PF_ETHUSD',
      purpose: 'settle',
      scheduledAt: 10,
      startedAt: 12,
      finishedAt: 20,
      outcome: 'http_error',
      httpStatus: 503,
      detail: 'x'.repeat(500),
    })
    store.close()
    const db = new DatabaseSync(path, { readOnly: true })
    const row = db
      .prepare('SELECT * FROM paper_futures_funding_polls')
      .get() as Record<string, unknown>
    expect(row).toMatchObject({
      product_id: 'PF_ETHUSD',
      purpose: 'settle',
      outcome: 'http_error',
      http_status: 503,
      response_sha256: null,
      extract_text: null,
    })
    expect(String(row.detail)).toHaveLength(200)
    expect(
      Number(
        (
          db
            .prepare(
              'SELECT COUNT(*) AS n FROM paper_futures_funding_sightings',
            )
            .get() as { n: number }
        ).n,
      ),
    ).toBe(0)
    db.close()
  })

  it('refuses UPDATE and DELETE and writes on a read-only store', () => {
    const { store, path } = open()
    poll(store, T0 + 2 * HOUR + 30_000, [[1, '0.2']])
    store.close()
    const db = new DatabaseSync(path)
    for (const table of [
      'paper_futures_funding_polls',
      'paper_futures_funding_sightings',
    ]) {
      expect(() => db.exec(`UPDATE ${table} SET product_id='x'`)).toThrow(
        /immutable/,
      )
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/immutable/)
    }
    db.close()
    const readOnly = new FuturesMarketStore(path, { readOnly: true })
    expect(() => poll(readOnly, T0 + 3 * HOUR, [[1, '0.2']])).toThrow(
      /read-only/,
    )
    readOnly.close()
  })

  it('tells a missing table (old database) apart from an empty one', () => {
    const { store, path } = open()
    expect(
      store.fundingSightings('PF_XBTUSD', Number.MAX_SAFE_INTEGER),
    ).toEqual([])
    store.close()
    const db = new DatabaseSync(path)
    db.exec('DROP TABLE paper_futures_funding_sightings')
    db.close()
    const readOnly = new FuturesMarketStore(path, { readOnly: true })
    expect(
      readOnly.fundingSightings('PF_XBTUSD', Number.MAX_SAFE_INTEGER),
    ).toBeNull()
    readOnly.close()
  })

  it('keeps the schema version and the existing funding tables untouched', () => {
    const { store, path } = open()
    poll(store, T0 + 2 * HOUR + 30_000, [[1, '0.2']])
    store.close()
    const db = new DatabaseSync(path, { readOnly: true })
    const versions = (
      db
        .prepare(
          'SELECT version FROM paper_futures_market_migrations ORDER BY version',
        )
        .all() as Array<{ version: number }>
    ).map((r) => r.version)
    expect(Math.max(...versions)).toBe(7)
    for (const table of [
      'paper_futures_funding_responses',
      'paper_futures_funding_periods',
    ])
      expect(
        Number(
          (
            db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
              n: number
            }
          ).n,
        ),
      ).toBe(0)
    db.close()
  })

  it('extracts only the requested periods, literally', () => {
    const raw =
      '{"result":"success","serverTime":"2026-10-05T12:00:30.000Z","rates":[{"timestamp":"2026-10-05T10:00:00.000Z","fundingRate":0.10,"relativeFundingRate":1e-5},{"timestamp":"2026-10-05T11:00:00.000Z","fundingRate":-0.20,"relativeFundingRate":2e-5}]}'
    const extract = fundingLiteralExtract(
      { serverTime: '2026-10-05T12:00:30.000Z', rawResponse: raw },
      new Set([Date.parse('2026-10-05T11:00:00.000Z')]),
    )
    expect(extract.text).toBe(
      'serverTime=2026-10-05T12:00:30.000Z\n{"timestamp":"2026-10-05T11:00:00.000Z","fundingRate":-0.20,"relativeFundingRate":2e-5}',
    )
  })
})
