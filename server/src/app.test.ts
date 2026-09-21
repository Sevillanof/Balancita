import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AnalysisCache } from './cache.ts'
import { serverConfigFrom } from './config.ts'
import type { GeminiClient, GeminiGenerateParams } from './gemini-client.ts'
import { AnalysisRateLimiter } from './limits.ts'
import { buildApp } from './app.ts'
import type { MarketCollectorLifecycle } from './app.ts'
import type { SupportedInstrumentId } from './intelligence/contracts.ts'
import { MarketStore } from './intelligence/market/market-store.ts'
import { createShadowRunStart } from './intelligence/shadow/shadow-run.ts'

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

function validBody() {
  return {
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
}

class FakeGeminiClient implements GeminiClient {
  calls: GeminiGenerateParams[] = []
  text = resultText
  error?: unknown

  async generateStructuredText(params: GeminiGenerateParams): Promise<string> {
    this.calls.push(params)
    if (this.error !== undefined) {
      throw this.error
    }
    return this.text
  }
}

async function makeApp(options: {
  env?: Record<string, string | undefined>
  client?: FakeGeminiClient
  limiter?: AnalysisRateLimiter
  saturateLimiter?: boolean
  maxCandles?: number
}) {
  const config = serverConfigFrom({
    GEMINI_MAX_CANDLES: String(options.maxCandles ?? 500),
    ...options.env,
  })
  const overrides: {
    client?: GeminiClient
    limiter?: AnalysisRateLimiter
    cache?: AnalysisCache
  } = {}
  if (options.client !== undefined) {
    overrides.client = options.client
  }
  if (options.limiter !== undefined) {
    overrides.limiter = options.limiter
  } else if (options.saturateLimiter === true) {
    overrides.client = overrides.client ?? new FakeGeminiClient()
    const limiter = new AnalysisRateLimiter({
      maxPerMinute: 1,
      maxPerDay: 1,
      now: () => 0,
    })
    limiter.tryConsume()
    overrides.limiter = limiter
  }
  const app = await buildApp({ config, overrides })
  return app
}

class FakeMarketCollector implements MarketCollectorLifecycle {
  readonly starts: string[] = []
  stopCount = 0

  start(instrumentId: string): void {
    this.starts.push(instrumentId)
  }

  stop(): void {
    this.stopCount += 1
  }
}

describe('analysis gateway API', () => {
  it('reports health', async () => {
    const app = await makeApp({})
    const response = await app.inject({ method: 'GET', url: '/health' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('returns a validated result for a well-formed request', async () => {
    const client = new FakeGeminiClient()
    const app = await makeApp({ client })

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.error).toBeUndefined()
    expect(body.cached).toBe(false)
    expect(body.result.classification).toBe('watch')
    expect(body.result.recommendation).toBe('hold')
    expect(body.result.volatility.level).toBe('low')
    expect(client.calls).toHaveLength(1)
  })

  it('serves an identical request from the cache', async () => {
    const client = new FakeGeminiClient()
    const app = await makeApp({ client })

    const first = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })
    const second = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(first.json().cached).toBe(false)
    expect(second.statusCode).toBe(200)
    expect(second.json().cached).toBe(true)
    expect(client.calls).toHaveLength(1)
  })

  it('rejects a body with a non-decimal holding with 400 invalid_request', async () => {
    const app = await makeApp({})
    const payload = validBody()
    payload.holding = { quantity: '0,5', averageCost: '50000' }

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload,
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_request' },
    })
  })

  it('rejects a malformed JSON body with the same envelope', async () => {
    const app = await makeApp({})
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_request' },
    })
  })

  it('fails with 503 missing_key when no API key is configured', async () => {
    const app = await makeApp({ env: { GEMINI_API_KEY: '' } })
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toMatchObject({ error: { code: 'missing_key' } })
  })

  it('fails with 429 quota_exceeded when the internal budget is spent', async () => {
    const app = await makeApp({ saturateLimiter: true })
    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(response.statusCode).toBe(429)
    expect(response.json()).toMatchObject({ error: { code: 'quota_exceeded' } })
  })

  it('maps an upstream 429 into quota_exceeded', async () => {
    const client = new FakeGeminiClient()
    client.error = { status: 429 }
    const app = await makeApp({ client })

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(response.statusCode).toBe(429)
    expect(response.json()).toMatchObject({ error: { code: 'quota_exceeded' } })
  })

  it('maps a timeout into 504 timeout', async () => {
    const client = new FakeGeminiClient()
    client.error = Object.assign(new Error('aborted'), { name: 'TimeoutError' })
    const app = await makeApp({ client })

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(response.statusCode).toBe(504)
    expect(response.json()).toMatchObject({ error: { code: 'timeout' } })
  })

  it('maps non-JSON model output into 502 invalid_response', async () => {
    const client = new FakeGeminiClient()
    client.text = 'not json at all'
    const app = await makeApp({ client })

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload: validBody(),
    })

    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({
      error: { code: 'invalid_response' },
    })
  })

  it('truncates candle history to maxCandles before prompting', async () => {
    const client = new FakeGeminiClient()
    const app = await makeApp({ client, maxCandles: 2 })
    const payload = validBody()
    payload.candles = [1, 2, 3, 4].map((index) => ({
      time: `2024-01-0${index}T00:00:00.000Z`,
      open: 50_000,
      high: 51_000,
      low: 49_000,
      close: 50_500,
      volume: 1000,
    }))

    const response = await app.inject({
      method: 'POST',
      url: '/api/analyze',
      payload,
    })

    expect(response.statusCode).toBe(200)
    expect(client.calls).toHaveLength(1)
    const prompt = client.calls[0]!.prompt
    expect(prompt).toContain('2024-01-03T')
    expect(prompt).toContain('2024-01-04T')
    expect(prompt).not.toContain('2024-01-01T')
  })
})

describe('market collector lifecycle', () => {
  it('rejects non-BTC-EUR intelligence streams before opening a connection', async () => {
    const app = await makeApp({})
    const response = await app.inject({
      method: 'GET',
      url: '/api/intelligence/stream?instrumentId=ETH-EUR',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({
      error: { code: 'unsupported_instrument' },
    })

    const missingInstrument = await app.inject({
      method: 'GET',
      url: '/api/intelligence/stream',
    })
    expect(missingInstrument.statusCode).toBe(400)
  })

  it('does not start a collector when market ingestion is disabled by default', async () => {
    const collector = new FakeMarketCollector()
    const app = await buildApp({
      config: serverConfigFrom({}),
      overrides: { marketCollector: collector },
    })

    await app.ready()
    await app.close()

    expect(collector.starts).toEqual([])
    expect(collector.stopCount).toBe(0)
  })

  it('starts and stops an enabled collector through Fastify lifecycle hooks', async () => {
    const collector = new FakeMarketCollector()
    const store = new MarketStore({ path: ':memory:' })
    const app = await buildApp({
      config: serverConfigFrom({ MARKET_COLLECTOR_ENABLED: 'true' }),
      overrides: { marketCollector: collector, marketStore: store },
    })

    await app.ready()
    expect(collector.starts).toEqual(['BTC-EUR'])
    await app.close()

    expect(collector.stopCount).toBe(1)
  })
})

describe('shadow run lifecycle and status endpoint', () => {
  const shadowDirectory = mkdtempSync(join(tmpdir(), 'balancita-app-shadow-'))

  afterEach(() => {
    rmSync(shadowDirectory, { recursive: true, force: true })
  })

  function storePath(): string {
    return join(
      shadowDirectory,
      `shadow-${Math.random().toString(36).slice(2)}.db`,
    )
  }

  async function makeAppWithStore(options: {
    enabled: boolean
    store: MarketStore
  }) {
    const app = await buildApp({
      config: serverConfigFrom(
        options.enabled ? { MARKET_COLLECTOR_ENABLED: 'true' } : {},
      ),
      overrides: {
        marketCollector: new FakeMarketCollector(),
        marketStore: options.store,
      },
    })
    return app
  }

  it('creates the canonical shadow run idempotently across onReady boots', async () => {
    const path = storePath()
    const firstCollector = new FakeMarketCollector()
    const firstStore = new MarketStore({ path })
    const firstApp = await buildApp({
      config: serverConfigFrom({ MARKET_COLLECTOR_ENABLED: 'true' }),
      overrides: {
        marketCollector: firstCollector,
        marketStore: firstStore,
      },
    })

    await firstApp.ready()
    expect(firstCollector.starts).toEqual(['BTC-EUR'])
    expect(firstStore.shadowRunCount()).toBe(1)
    const run = firstStore.getShadowRun('shadow:BTC-EUR')
    expect(run?.id).toBe('shadow:BTC-EUR')
    expect(run?.status).toBe('collecting')
    expect(run?.plannedEndAt).toBe(run!.startedAt + 30 * 24 * 3_600_000)
    await firstApp.close()

    const againCollector = new FakeMarketCollector()
    const secondStore = new MarketStore({ path })
    const secondApp = await buildApp({
      config: serverConfigFrom({ MARKET_COLLECTOR_ENABLED: 'true' }),
      overrides: {
        marketCollector: againCollector,
        marketStore: secondStore,
      },
    })

    await secondApp.ready()
    expect(againCollector.starts).toEqual(['BTC-EUR'])
    expect(secondStore.shadowRunCount()).toBe(1)
    expect(secondStore.getShadowRun('shadow:BTC-EUR')?.startedAt).toBe(
      run?.startedAt,
    )
    await secondApp.close()
  })

  it('does not create a shadow run when the collector is disabled', async () => {
    const store = new MarketStore({ path: storePath() })
    const app = await makeAppWithStore({ enabled: false, store })

    await app.ready()
    expect(store.shadowRunCount()).toBe(0)
    expect(store.getShadowRun('shadow:BTC-EUR')).toBeUndefined()
    await app.close()
  })

  it('reports active collecting status before the 30-day window completes', async () => {
    const store = new MarketStore({ path: storePath() })
    const app = await makeAppWithStore({ enabled: true, store })

    const response = await app.inject({
      method: 'GET',
      url: '/api/intelligence/shadow/status?instrumentId=BTC-EUR',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.error).toBeUndefined()
    expect(body.instrumentId).toBe('BTC-EUR')
    expect(body.state.kind).toBe('active')
    expect(body.state.view.computedStatus).toBe('collecting')
    expect(body.state.view.status).toBe('collecting')
    expect(body.state.view.run.id).toBe('shadow:BTC-EUR')
    expect(body.state.view.evaluatedOutcomeCount).toBe(0)
    expect(body.state.view.minimumEvidence).toBe(10)
    expect(typeof body.state.view.now).toBe('number')
    await app.close()
  })

  it('reports disabled when the collector is off and never invents run data', async () => {
    const store = new MarketStore({ path: storePath() })
    const app = await makeAppWithStore({ enabled: false, store })

    const response = await app.inject({
      method: 'GET',
      url: '/api/intelligence/shadow/status?instrumentId=BTC-EUR',
    })

    expect(response.statusCode).toBe(200)
    const body = response.json()
    expect(body.state.kind).toBe('disabled')
    expect(body.state.reason).toBe('collector_disabled')
    expect(body.state.view).toBeUndefined()
    await app.close()
  })

  it('rejects a non-BTC-EUR instrument with 400', async () => {
    const store = new MarketStore({ path: storePath() })
    const app = await makeAppWithStore({ enabled: true, store })

    const other = await app.inject({
      method: 'GET',
      url: '/api/intelligence/shadow/status?instrumentId=ETH-EUR',
    })
    expect(other.statusCode).toBe(400)
    expect(other.json()).toMatchObject({
      error: { code: 'unsupported_instrument' },
    })

    const missing = await app.inject({
      method: 'GET',
      url: '/api/intelligence/shadow/status',
    })
    expect(missing.statusCode).toBe(400)
    await app.close()
  })

  it('reuses an existing run without mutating its start, end or policy', async () => {
    const path = storePath()
    const startedAt = 1_500_000_000_000
    const seededStore = new MarketStore({ path })
    const run = createShadowRunStart(
      startedAt,
      'BTC-EUR' as SupportedInstrumentId,
    )
    seededStore.createShadowRun(run, startedAt)
    expect(seededStore.shadowRunCount()).toBe(1)
    seededStore.close()

    const store = new MarketStore({ path })
    const app = await makeAppWithStore({ enabled: true, store })

    await app.ready()
    expect(store.shadowRunCount()).toBe(1)
    const existing = store.getShadowRun('shadow:BTC-EUR')
    expect(existing?.startedAt).toBe(startedAt)
    expect(existing?.plannedEndAt).toBe(startedAt + 30 * 24 * 3_600_000)
    expect(existing?.status).toBe('collecting')
    expect(existing?.versions.policyVersion).toBe('shadow-policy.v1')
    expect(store.listShadowStatuses('shadow:BTC-EUR')).toHaveLength(1)
    await app.close()
  })
})
