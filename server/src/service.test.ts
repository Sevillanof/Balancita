import { describe, expect, it, vi } from 'vitest'
import {
  AnalysisInvalidResponseError,
  AnalysisQuotaExceededError,
  AnalysisTimeoutError,
} from './analysis-errors.ts'
import { AnalysisCache } from './cache.ts'
import type { GeminiClient, GeminiGenerateParams } from './gemini-client.ts'
import { AnalysisRateLimiter } from './limits.ts'
import { AnalyzeService } from './service.ts'
import type { AnalysisInputRequest } from './wire.ts'

const input: AnalysisInputRequest = {
  instrumentId: 'BTC-EUR',
  symbol: 'BTC-EUR',
  assetClass: 'crypto',
  currency: 'EUR',
  quote: {
    price: 60_000,
    change: 300,
    changePercent: 0.5,
    timestamp: '2026-09-20T12:00:00.000Z',
    status: 'mock',
  },
  candles: [
    {
      time: '2024-01-01T00:00:00.000Z',
      open: 50_000,
      high: 51_000,
      low: 49_000,
      close: 50_500,
      volume: 1000,
    },
  ],
  holding: { quantity: '0.5', averageCost: '50000' },
}

const resultText = JSON.stringify({
  instrumentId: 'BTC-EUR',
  classification: 'watch',
  recommendation: 'hold',
  reasons: ['Latest quote moved up 0.50%; noteworthy move.'],
  warnings: [],
  volatility: { lookbackCandles: 1, averageTrueRangePercent: 2, level: 'low' },
  disclaimer:
    'Recomendación educativa e informativa: no es asesoramiento financiero y no ejecuta órdenes.',
})

class FakeGeminiClient implements GeminiClient {
  generateStructuredText =
    vi.fn<(params: GeminiGenerateParams) => Promise<string>>()
}

function makeService(
  overrides: {
    client?: FakeGeminiClient
    maxPerMinute?: number
    maxPerDay?: number
    now?: () => number
  } = {},
) {
  const client = overrides.client ?? new FakeGeminiClient()
  const limiter = new AnalysisRateLimiter({
    maxPerMinute: overrides.maxPerMinute ?? 100,
    maxPerDay: overrides.maxPerDay ?? 100,
    now: overrides.now,
  })
  return {
    client,
    service: new AnalyzeService({
      client,
      limiter,
      cache: new AnalysisCache(10),
      model: 'gemini-3.5-flash-lite',
      maxOutputTokens: 1024,
      timeoutMs: 15_000,
    }),
  }
}

describe('AnalyzeService', () => {
  it('returns a parsed, validated result and forwards structured config', async () => {
    const { client, service } = makeService()
    client.generateStructuredText.mockResolvedValue(resultText)

    const outcome = await service.analyze(input)

    expect(outcome.cached).toBe(false)
    expect(outcome.result.classification).toBe('watch')
    expect(outcome.result.volatility.level).toBe('low')
    expect(client.generateStructuredText).toHaveBeenCalledTimes(1)
    const params = client.generateStructuredText.mock.calls[0]![0]
    expect(params.model).toBe('gemini-3.5-flash-lite')
    expect(params.maxOutputTokens).toBe(1024)
    expect(params.jsonSchema).toEqual(
      expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          classification: expect.objectContaining({
            enum: ['watch', 'neutral', 'review'],
          }),
          recommendation: expect.objectContaining({
            enum: ['buy', 'sell', 'hold'],
          }),
        }),
      }),
    )
    expect(params.prompt).toContain('BTC-EUR')
    expect(params.signal).toBeInstanceOf(AbortSignal)
  })

  it('serves identical requests from the cache without calling the model again', async () => {
    const { client, service } = makeService()
    client.generateStructuredText.mockResolvedValue(resultText)

    const first = await service.analyze(input)
    const second = await service.analyze(input)

    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(second.result).toEqual(first.result)
    expect(client.generateStructuredText).toHaveBeenCalledTimes(1)
  })

  it('calls the model again when the input differs', async () => {
    const { client, service } = makeService()
    client.generateStructuredText.mockResolvedValue(resultText)

    await service.analyze(input)
    await service.analyze({
      ...input,
      quote: { ...input.quote, price: 61_000 },
    })

    expect(client.generateStructuredText).toHaveBeenCalledTimes(2)
  })

  it('fails closed with a typed quota error when the internal budget is spent', async () => {
    const { client, service } = makeService({ maxPerMinute: 1, maxPerDay: 100 })
    client.generateStructuredText.mockResolvedValue(resultText)
    const differentInput = {
      ...input,
      quote: { ...input.quote, price: 59_999 },
    }

    await service.analyze(input)

    await expect(service.analyze(differentInput)).rejects.toThrow(
      AnalysisQuotaExceededError,
    )
    await expect(service.analyze(differentInput)).rejects.toThrow(/limit/i)
  })

  it('maps an upstream 429 to a quota error', async () => {
    const { client, service } = makeService()
    client.generateStructuredText.mockRejectedValue({ status: 429 })

    await expect(service.analyze(input)).rejects.toThrow(
      AnalysisQuotaExceededError,
    )
  })

  it('maps an abort/timeout to a typed timeout error', async () => {
    const { client, service } = makeService()
    client.generateStructuredText.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
    )

    await expect(service.analyze(input)).rejects.toThrow(AnalysisTimeoutError)
  })

  it('treats non-JSON model output as an invalid response', async () => {
    const { client, service } = makeService()
    client.generateStructuredText.mockResolvedValue('this is not json')

    await expect(service.analyze(input)).rejects.toThrow(
      AnalysisInvalidResponseError,
    )
  })

  it('rejects well-formed JSON that violates the result shape', async () => {
    const { client, service } = makeService()
    client.generateStructuredText.mockResolvedValue(
      JSON.stringify({ ...JSON.parse(resultText), classification: 'buy' }),
    )

    await expect(service.analyze(input)).rejects.toThrow(
      AnalysisInvalidResponseError,
    )
  })

  it('rejects a model recommendation outside buy, sell or hold', async () => {
    const { client, service } = makeService()
    client.generateStructuredText.mockResolvedValue(
      JSON.stringify({ ...JSON.parse(resultText), recommendation: 'review' }),
    )

    await expect(service.analyze(input)).rejects.toThrow(
      AnalysisInvalidResponseError,
    )
  })
})
