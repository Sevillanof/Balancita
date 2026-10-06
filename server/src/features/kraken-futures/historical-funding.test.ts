import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FuturesMarketStore } from './futures-market-store.ts'
import {
  createHistoricalFundingClient,
  historicalFundingAt,
  parseHistoricalFundingResponse,
} from './historical-funding.ts'

const capture = readFileSync(
  new URL(
    '../../../../playwright-artifacts/futures-diagnostics/funding-current-20261003T225404Z/response.json',
    import.meta.url,
  ),
  'utf8',
)
const receivedAt = Date.parse('2026-10-03T22:54:04.316Z')

describe('public historical Kraken futures funding', () => {
  it('normalizes the latest explicit PF_XBTUSD period without floating-point loss', () => {
    const parsed = parseHistoricalFundingResponse(capture, receivedAt)
    expect(parsed.serverTime).toBe('2026-10-03T22:54:04.316Z')
    expect(parsed.records.at(-1)).toMatchObject({
      startMs: Date.parse('2026-10-03T22:00:00Z'),
      endMs: Date.parse('2026-10-03T23:00:00Z'),
      fundingRate: '-0.075852351405',
      unit: 'USD/BTC/hour',
    })
  })

  it('does not make late-known or future periods available to an earlier decision', () => {
    const records = parseHistoricalFundingResponse(capture, receivedAt).records
    expect(
      historicalFundingAt(
        records,
        Date.parse('2026-10-03T22:30:00Z'),
        receivedAt,
      ),
    ).toBeNull()
    expect(
      historicalFundingAt(
        records,
        Date.parse('2026-10-03T22:55:00Z'),
        receivedAt + 1,
      ),
    ).toMatchObject({
      startMs: Date.parse('2026-10-03T22:00:00Z'),
      fundingRate: '-0.075852351405',
    })
    expect(
      historicalFundingAt(
        records,
        Date.parse('2026-10-03T23:00:00Z'),
        receivedAt,
      ),
    ).toBeNull()
    expect(
      historicalFundingAt(
        records,
        Date.parse('2026-10-03T22:30:00Z'),
        receivedAt - 1000,
      ),
    ).toBeNull()
  })

  it('keeps absent, malformed and conflicting period evidence unknown', () => {
    const empty = parseHistoricalFundingResponse(
      '{"result":"success","serverTime":"2026-10-03T22:54:04.316Z","rates":[]}',
      receivedAt,
    )
    expect(
      historicalFundingAt(
        empty.records,
        Date.parse('2026-10-03T22:30:00Z'),
        receivedAt,
      ),
    ).toBeNull()
    expect(() => parseHistoricalFundingResponse('{bad', 1)).toThrow()
    expect(() =>
      parseHistoricalFundingResponse(
        '{"result":"success","serverTime":"2026-10-03T22:54:04.316Z","rates":[{"timestamp":"2026-10-03T22:00:00Z","fundingRate":1,"relativeFundingRate":1},{"timestamp":"2026-10-03T22:00:00Z","fundingRate":2,"relativeFundingRate":1}]}',
        receivedAt,
      ),
    ).toThrow()
    const response = (rate: number) =>
      parseHistoricalFundingResponse(
        `{"result":"success","serverTime":"2026-10-03T22:54:04.316Z","rates":[{"timestamp":"2026-10-03T22:00:00Z","fundingRate":${rate},"relativeFundingRate":0}]}`,
        receivedAt,
      ).records[0]!
    expect(
      historicalFundingAt(
        [response(1), response(2)],
        Date.parse('2026-10-03T22:55:00Z'),
        receivedAt + 1,
      ),
    ).toBeNull()
  })

  it('bounds and aborts the injected anonymous request', async () => {
    let requestUrl = ''
    let signal: AbortSignal | undefined
    const client = createHistoricalFundingClient({
      fetch: async (input, init) => {
        requestUrl = String(input)
        signal = init?.signal as AbortSignal
        return new Response(capture, { status: 200 })
      },
      timeoutMs: 1000,
    })
    const result = await client.fetch(Date.parse('2026-10-03T22:54:04.316Z'))
    expect(requestUrl).toContain('/historical-funding-rates?symbol=PF_XBTUSD')
    expect(signal).toBeDefined()
    expect(result.records.at(-1)?.fundingRate).toBe('-0.075852351405')
  })

  it('keeps immutable raw audit and exact normalized evidence across SQLite reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'funding-source-'))
    const path = join(directory, 'market.sqlite')
    const response = parseHistoricalFundingResponse(capture, receivedAt)
    try {
      const first = new FuturesMarketStore(path)
      first.appendFundingResponse(response)
      first.appendFundingResponse(response)
      expect(first.fundingRecordsAsOf(receivedAt)).toHaveLength(8815)
      first.close()
      const reopened = new FuturesMarketStore(path)
      expect(reopened.fundingRecordsAsOf(receivedAt).at(-1)).toMatchObject({
        startMs: Date.parse('2026-10-03T22:00:00Z'),
        fundingRate: '-0.075852351405',
        sha256: response.sha256,
      })
      expect(reopened.fundingResponse(response.sha256)?.rawResponse).toBe(
        capture,
      )
      reopened.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
