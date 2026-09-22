import cors from '@fastify/cors'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import {
  AnalysisInvalidRequestError,
  AnalysisInvalidResponseError,
  AnalysisMissingKeyError,
  AnalysisQuotaExceededError,
  AnalysisTimeoutError,
  AnalysisUpstreamError,
  type AnalysisGatewayErrorCode,
} from './analysis-errors.ts'
import { AnalysisCache } from './cache.ts'
import type { ServerConfig } from './config.ts'
import { createGeminiClient, type GeminiClient } from './gemini-client.ts'
import type {
  SupportedInstrumentId,
  TimestampMs,
} from './intelligence/contracts.ts'
import { LiveForecastService } from './intelligence/live-forecast.ts'
import { KrakenMarketCollector } from './intelligence/market/kraken-market-collector.ts'
import { MarketStore } from './intelligence/market/market-store.ts'
import { NewsPollingService } from './intelligence/news/news-poller.ts'
import type { NewsHttpFetcher } from './intelligence/news/rss-collector.ts'
import {
  ShadowRunNotFoundError,
  ShadowRunService,
  type ShadowStatusView,
} from './intelligence/shadow/shadow-services.ts'
import {
  createIntelligenceSnapshot,
  IntelligenceStreamHub,
  type IntelligenceCollectorObserver,
} from './intelligence/stream.ts'
import { AnalysisRateLimiter } from './limits.ts'
import { AnalyzeService } from './service.ts'
import { parseAnalysisInputRequest } from './wire.ts'

export interface AnalysisDependencies {
  client: GeminiClient
  limiter: AnalysisRateLimiter
  cache: AnalysisCache
}

export interface MarketCollectorLifecycle extends IntelligenceCollectorObserver {
  start(instrumentId: string): void | Promise<void>
  stop(): void | Promise<void>
}

export interface LiveForecastRunner {
  runOnce(now?: TimestampMs): unknown
}

/**
 * Injectable interval scheduler so the forecast loop can be exercised without
 * leaving real timers running in tests.
 */
export interface ForecastLoopScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown
  clearInterval(handle: unknown): void
}

export type MarketRestFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>

const defaultForecastScheduler: ForecastLoopScheduler = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
}

export interface MarketDependencies {
  marketCollector: MarketCollectorLifecycle
  marketFetch?: MarketRestFetch
  marketStore?: MarketStore
  liveForecastService?: LiveForecastRunner
  forecastScheduler?: ForecastLoopScheduler
  newsFetch?: NewsHttpFetcher
  newsPollingService?: NewsPollingService
  newsScheduler?: ForecastLoopScheduler
  newsClock?: () => TimestampMs
}

type ErrorEnvelope = {
  error: { code: AnalysisGatewayErrorCode | 'internal_error'; message: string }
}

export type ShadowStatusState =
  | { readonly kind: 'active'; readonly view: ShadowStatusView }
  | { readonly kind: 'disabled'; readonly reason: 'collector_disabled' }
  | {
      readonly kind: 'unavailable'
      readonly reason: 'market_store_unavailable' | 'shadow_run_not_found'
    }

export interface ShadowStatusResponse {
  readonly instrumentId: SupportedInstrumentId
  readonly state: ShadowStatusState
}

function envelope(error: {
  code: AnalysisGatewayErrorCode | 'internal_error'
  message: string
}): ErrorEnvelope {
  return { error: { code: error.code, message: error.message } }
}

export async function buildApp(options: {
  config: ServerConfig
  overrides?: Partial<AnalysisDependencies & MarketDependencies>
}): Promise<FastifyInstance> {
  const { config } = options
  const marketFetch: MarketRestFetch =
    options.overrides?.marketFetch ??
    ((input, init) => globalThis.fetch(input, init))

  const limiter =
    options.overrides?.limiter ??
    new AnalysisRateLimiter({
      maxPerMinute: config.maxRequestsPerMinute,
      maxPerDay: config.maxRequestsPerDay,
    })
  const cache =
    options.overrides?.cache ??
    new AnalysisCache(config.cacheMaxEntries, config.cacheTtlMs)
  const client =
    options.overrides?.client ??
    (config.apiKey === '' ? undefined : createGeminiClient(config.apiKey))
  const service =
    client === undefined
      ? undefined
      : new AnalyzeService({
          client,
          limiter,
          cache,
          model: config.model,
          maxOutputTokens: config.maxOutputTokens,
          timeoutMs: config.timeoutMs,
        })

  let marketStore: MarketStore | undefined
  if (
    config.marketCollectorEnabled ||
    config.newsPollingEnabled ||
    options.overrides?.marketStore !== undefined
  ) {
    marketStore =
      options.overrides?.marketStore ??
      new MarketStore({ path: config.marketDbPath })
  }
  const marketCollector =
    marketStore === undefined
      ? undefined
      : (options.overrides?.marketCollector ??
        new KrakenMarketCollector({
          store: marketStore,
          wsUrl: config.krakenWsUrl,
          restBaseUrl: config.krakenRestUrl,
          staleAfterMs: config.marketStaleAfterMs,
          reconnectMinMs: config.marketReconnectMinMs,
          reconnectMaxMs: config.marketReconnectMaxMs,
          clock: () => Date.now(),
        }))
  const shadowService =
    marketStore === undefined
      ? undefined
      : new ShadowRunService({
          store: marketStore,
          instrumentId: 'BTC-EUR',
          runId: config.shadowRunId,
          clock: () => Date.now() as TimestampMs,
        })
  const liveForecastService =
    marketStore === undefined
      ? undefined
      : (options.overrides?.liveForecastService ??
        new LiveForecastService({
          store: marketStore,
          instrumentId: 'BTC-EUR',
          interval: '15m',
          horizon: '15m',
          clock: () => Date.now() as TimestampMs,
        }))
  const forecastScheduler =
    options.overrides?.forecastScheduler ?? defaultForecastScheduler
  let forecastLoopHandle: unknown
  let publishNewsUpdate = (): void => undefined
  const newsScheduler =
    options.overrides?.newsScheduler ?? defaultForecastScheduler
  const newsPollingService =
    options.overrides?.newsPollingService ??
    (config.newsPollingEnabled && marketStore !== undefined
      ? new NewsPollingService({
          store: marketStore,
          userAgent: config.newsUserAgent,
          fetcher: options.overrides?.newsFetch,
          clock:
            options.overrides?.newsClock ?? (() => Date.now() as TimestampMs),
          staleAfterMs: config.newsStaleAfterMs,
          onChange: () => publishNewsUpdate(),
        })
      : undefined)
  let newsLoopHandle: unknown

  const startForecastLoop = (): void => {
    if (
      !config.forecastLoopEnabled ||
      liveForecastService === undefined ||
      forecastLoopHandle !== undefined
    )
      return
    forecastLoopHandle = forecastScheduler.setInterval(() => {
      try {
        liveForecastService.runOnce()
      } catch {
        // A single failed tick must never crash the server loop.
      }
    }, config.forecastLoopIntervalMs)
  }

  const stopForecastLoop = (): void => {
    if (forecastLoopHandle === undefined) return
    forecastScheduler.clearInterval(forecastLoopHandle)
    forecastLoopHandle = undefined
  }

  const startNewsLoop = (): void => {
    if (
      !config.newsPollingEnabled ||
      newsPollingService === undefined ||
      newsLoopHandle !== undefined
    )
      return
    void newsPollingService.pollOnce()
    newsLoopHandle = newsScheduler.setInterval(() => {
      void newsPollingService.pollOnce().catch(() => undefined)
    }, config.newsPollIntervalMs)
  }

  const stopNewsLoop = (): void => {
    if (newsLoopHandle === undefined) return
    newsScheduler.clearInterval(newsLoopHandle)
    newsLoopHandle = undefined
  }

  const ensureShadowRunExists = (): void => {
    if (shadowService === undefined || marketStore === undefined) return
    if (marketStore.getShadowRun(config.shadowRunId) !== undefined) return
    shadowService.start()
  }

  const streamHub = new IntelligenceStreamHub({
    snapshot: () =>
      createIntelligenceSnapshot({
        collectorEnabled: config.marketCollectorEnabled,
        marketStore,
        collector: marketCollector,
        news:
          config.newsPollingEnabled && newsPollingService !== undefined
            ? newsPollingService
            : undefined,
        staleAfterMs: config.marketStaleAfterMs,
        clock: () => Date.now(),
        windowSize: config.intelligenceStreamWindowSize,
      }),
    maxClients: config.intelligenceStreamMaxClients,
    keepAliveMs: config.intelligenceStreamKeepAliveMs,
    clock: () => Date.now(),
  })
  publishNewsUpdate = () => streamHub.publish()
  const unsubscribeCollector = marketCollector?.subscribe?.(() =>
    streamHub.publish(),
  )

  const app = Fastify({ logger: false })

  const proxyMarketRequest = async (
    reply: FastifyReply,
    path: string,
  ): Promise<FastifyReply> => {
    try {
      const upstream = await marketFetch(
        `${config.krakenRestUrl.replace(/\/+$/, '')}${path}`,
        { headers: { Accept: 'application/json' } },
      )
      return reply.code(upstream.status).send(await upstream.json())
    } catch {
      return reply.code(502).send({
        error: {
          code: 'upstream_error',
          message: 'The Kraken market data service could not be reached.',
        },
      })
    }
  }

  if (config.corsOrigin !== '') {
    await app.register(cors, { origin: config.corsOrigin })
  }

  app.get('/health', async () => ({ status: 'ok' }))

  app.get('/api/market/instruments', (_request, reply) =>
    proxyMarketRequest(reply, '/public/AssetPairs?pair=XBTEUR'),
  )

  app.get('/api/market/history', (request, reply) => {
    const query = request.query as { instrumentId?: unknown }
    if (query.instrumentId !== 'BTC-EUR') {
      return reply.code(400).send({
        error: {
          code: 'unsupported_instrument',
          message: 'Only BTC-EUR market history is supported.',
        },
      })
    }
    return proxyMarketRequest(reply, '/public/OHLC?pair=XBTEUR&interval=1')
  })

  app.get('/api/intelligence/stream', (request, reply) => {
    const query = request.query as { instrumentId?: unknown }
    if (query.instrumentId !== 'BTC-EUR') {
      return reply.code(400).send({
        error: {
          code: 'unsupported_instrument',
          message: 'Only BTC-EUR intelligence streams are supported.',
        },
      })
    }
    if (streamHub.clientCount() >= config.intelligenceStreamMaxClients) {
      return reply
        .code(429)
        .header('retry-after', '5')
        .send({
          error: {
            code: 'stream_limit_reached',
            message: 'The intelligence stream client limit has been reached.',
          },
        })
    }

    reply.hijack()
    reply.raw.statusCode = 200
    reply.raw.setHeader('content-type', 'text/event-stream; charset=utf-8')
    reply.raw.setHeader('cache-control', 'no-cache, no-transform')
    reply.raw.setHeader('connection', 'keep-alive')
    reply.raw.setHeader('x-accel-buffering', 'no')
    reply.raw.flushHeaders()
    const lastEventId = request.headers['last-event-id']
    const requestedEventId = Array.isArray(lastEventId)
      ? lastEventId[0]
      : lastEventId
    const cleanup = streamHub.connect(
      {
        write: (chunk) => reply.raw.write(chunk),
        close: () => reply.raw.end(),
      },
      requestedEventId,
    )
    reply.raw.on('close', cleanup)
  })

  app.get('/api/intelligence/shadow/status', (request, reply) => {
    const query = request.query as { instrumentId?: unknown }
    if (query.instrumentId !== 'BTC-EUR') {
      return reply.code(400).send({
        error: {
          code: 'unsupported_instrument',
          message: 'Only BTC-EUR shadow run status is supported.',
        },
      })
    }
    if (!config.marketCollectorEnabled) {
      return reply.send({
        instrumentId: 'BTC-EUR',
        state: { kind: 'disabled', reason: 'collector_disabled' },
      } satisfies ShadowStatusResponse)
    }
    if (shadowService === undefined) {
      return reply.send({
        instrumentId: 'BTC-EUR',
        state: { kind: 'unavailable', reason: 'market_store_unavailable' },
      } satisfies ShadowStatusResponse)
    }
    try {
      const view = shadowService.status()
      return reply.send({
        instrumentId: 'BTC-EUR',
        state: { kind: 'active', view },
      } satisfies ShadowStatusResponse)
    } catch (error) {
      if (error instanceof ShadowRunNotFoundError) {
        return reply.send({
          instrumentId: 'BTC-EUR',
          state: { kind: 'unavailable', reason: 'shadow_run_not_found' },
        } satisfies ShadowStatusResponse)
      }
      throw error
    }
  })

  app.addHook('onReady', async () => {
    if (config.marketCollectorEnabled) {
      ensureShadowRunExists()
      await marketCollector?.start('BTC-EUR')
      startForecastLoop()
    }
    startNewsLoop()
  })
  app.addHook('onClose', async () => {
    stopForecastLoop()
    stopNewsLoop()
    streamHub.close()
    unsubscribeCollector?.()
    await marketCollector?.stop()
    marketStore?.close()
  })

  app.post('/api/analyze', async (request, reply) => {
    let input
    try {
      input = parseAnalysisInputRequest(request.body, config.maxCandles)
    } catch (error) {
      if (error instanceof AnalysisInvalidRequestError) {
        return reply.code(400).send(envelope(error))
      }
      throw error
    }

    if (service === undefined) {
      return reply
        .code(503)
        .send(
          envelope(
            new AnalysisMissingKeyError(
              'No Gemini API key is configured on the server.',
            ),
          ),
        )
    }

    try {
      const outcome = await service.analyze(input)
      return reply
        .code(200)
        .send({ result: outcome.result, cached: outcome.cached })
    } catch (error) {
      if (error instanceof AnalysisQuotaExceededError) {
        return reply.code(429).send(envelope(error))
      }
      if (error instanceof AnalysisTimeoutError) {
        return reply.code(504).send(envelope(error))
      }
      if (
        error instanceof AnalysisInvalidResponseError ||
        error instanceof AnalysisUpstreamError
      ) {
        return reply.code(502).send(envelope(error))
      }
      return reply.code(500).send(
        envelope({
          code: 'internal_error',
          message: 'An unexpected server error occurred.',
        }),
      )
    }
  })

  app.setErrorHandler((error, _request, reply) => {
    if (
      error instanceof Fastify.errorCodes.FST_ERR_CTP_INVALID_JSON_BODY ||
      error instanceof Fastify.errorCodes.FST_ERR_CTP_BODY_TOO_LARGE
    ) {
      return reply
        .code(400)
        .send(
          envelope(
            new AnalysisInvalidRequestError(
              'The request body must be valid JSON.',
            ),
          ),
        )
    }
    return reply.code(500).send(
      envelope({
        code: 'internal_error',
        message: 'An unexpected server error occurred.',
      }),
    )
  })

  return app
}
