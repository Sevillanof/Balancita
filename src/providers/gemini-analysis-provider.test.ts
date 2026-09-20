import { describe, expect, it, vi } from 'vitest'
import type { AnalysisInput } from '../domain/analysis'
import {
  AnalysisInvalidResponseError,
  AnalysisQuotaExceededError,
  AnalysisTimeoutError,
  AnalysisUnavailableError,
} from '../domain/analysis-errors'
import { moneyFromString } from '../domain/money'
import { makeCandle, makeQuote } from '../test/fake-market-data-provider'
import { GeminiAnalysisProvider } from './gemini-analysis-provider'

function makeInput(): AnalysisInput {
  return {
    instrumentId: 'BTC-EUR',
    symbol: 'BTC-EUR',
    assetClass: 'crypto',
    currency: 'EUR',
    quote: makeQuote({ instrumentId: 'BTC-EUR', price: 60_000 }),
    candles: [makeCandle({ time: '2024-01-01T00:00:00.000Z' })],
    holding: {
      quantity: moneyFromString('0.5'),
      averageCost: moneyFromString('50000'),
    },
  }
}

const VALID_RESULT = {
  instrumentId: 'BTC-EUR',
  classification: 'watch',
  reasons: ['Latest quote moved up 0.50%; noteworthy move.'],
  warnings: [],
  volatility: { lookbackCandles: 1, averageTrueRangePercent: 2, level: 'low' },
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

function payloadOf(fetchMock: ReturnType<typeof vi.fn<FetchLike>>): unknown {
  const init = fetchMock.mock.calls[0]![1] as { body?: string }
  return JSON.parse(init.body ?? '')
}

function fakeFetch(status: number, body: unknown) {
  const json = vi.fn().mockResolvedValue(body) as ReturnType<typeof vi.fn>
  const fetchMock = vi.fn<FetchLike>().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json,
  } as unknown as Response)
  return { fetchMock, json }
}

describe('GeminiAnalysisProvider', () => {
  it('posts a decimal-safe payload and returns the validated result', async () => {
    const { fetchMock } = fakeFetch(200, {
      result: VALID_RESULT,
      cached: false,
    })
    const provider = new GeminiAnalysisProvider(
      'http://localhost:8787',
      fetchMock,
    )

    const result = await provider.analyze(makeInput())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'http://localhost:8787/api/analyze',
    )
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual({ 'content-type': 'application/json' })
    expect(init.body).not.toMatch(/secret/)

    const payload = payloadOf(fetchMock) as {
      instrumentId: string
      holding: { quantity: string; averageCost: string }
      quote: { price: number }
      candles: readonly { time: string }[]
    }
    expect(payload.instrumentId).toBe('BTC-EUR')
    expect(payload.holding).toEqual({ quantity: '0.5', averageCost: '50000' })
    expect(payload.quote.price).toBe(60_000)
    expect(payload.candles[0]!.time).toBe('2024-01-01T00:00:00.000Z')

    expect(result).toEqual(VALID_RESULT)
  })

  it('keeps full decimal precision when serializing money', async () => {
    const { fetchMock } = fakeFetch(200, {
      result: VALID_RESULT,
      cached: false,
    })
    const provider = new GeminiAnalysisProvider(
      'http://localhost:8787',
      fetchMock,
    )
    const input = makeInput()
    input.holding = {
      quantity: moneyFromString('0.12345678'),
      averageCost: moneyFromString('0.99999999'),
    }

    await provider.analyze(input)

    const payload = payloadOf(fetchMock) as {
      holding: { quantity: string; averageCost: string }
    }
    expect(payload.holding).toEqual({
      quantity: '0.12345678',
      averageCost: '0.99999999',
    })
  })

  it('serializes a missing holding as null', async () => {
    const { fetchMock } = fakeFetch(200, {
      result: VALID_RESULT,
      cached: false,
    })
    const provider = new GeminiAnalysisProvider(
      'http://localhost:8787',
      fetchMock,
    )
    const input = makeInput()
    input.holding = null

    await provider.analyze(input)

    const payload = payloadOf(fetchMock) as { holding: unknown }
    expect(payload.holding).toBeNull()
  })

  it.each([
    [429, 'quota_exceeded', AnalysisQuotaExceededError],
    [504, 'timeout', AnalysisTimeoutError],
    [502, 'invalid_response', AnalysisInvalidResponseError],
    [503, 'missing_key', AnalysisUnavailableError],
    [502, 'upstream_error', AnalysisUnavailableError],
  ] as const)(
    'maps HTTP %i error code %s to a typed error',
    async (status, code, ExpectedError) => {
      const { fetchMock } = fakeFetch(status, {
        error: { code, message: `${code} happened` },
      })
      const provider = new GeminiAnalysisProvider(
        'http://localhost:8787',
        fetchMock,
      )

      await expect(provider.analyze(makeInput())).rejects.toBeInstanceOf(
        ExpectedError,
      )
    },
  )

  it('fails closed as unavailable when the network is unreachable', async () => {
    const fetchMock = vi
      .fn<FetchLike>()
      .mockRejectedValue(new TypeError('fetch failed'))
    const provider = new GeminiAnalysisProvider(
      'http://localhost:8787',
      fetchMock,
    )

    await expect(provider.analyze(makeInput())).rejects.toBeInstanceOf(
      AnalysisUnavailableError,
    )
  })

  it('fails closed as invalid response when the body is not JSON', async () => {
    const fetchMock = vi.fn<FetchLike>().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
    } as unknown as Response)
    const provider = new GeminiAnalysisProvider(
      'http://localhost:8787',
      fetchMock,
    )

    await expect(provider.analyze(makeInput())).rejects.toBeInstanceOf(
      AnalysisInvalidResponseError,
    )
  })

  it('validates the result shape even on a 200', async () => {
    const unknownClassification = {
      ...VALID_RESULT,
      classification: 'buy',
    }
    const { fetchMock } = fakeFetch(200, {
      result: unknownClassification,
      cached: false,
    })
    const provider = new GeminiAnalysisProvider(
      'http://localhost:8787',
      fetchMock,
    )

    await expect(provider.analyze(makeInput())).rejects.toBeInstanceOf(
      AnalysisInvalidResponseError,
    )
  })
})
