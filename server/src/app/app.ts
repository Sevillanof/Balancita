import cors from '@fastify/cors'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { readFileSync } from 'node:fs'
import { refreshSimulations } from '../features/simulations/refresh-simulations.ts'
import {
  AnalysisInvalidRequestError,
  AnalysisInvalidResponseError,
  AnalysisMissingKeyError,
  AnalysisQuotaExceededError,
  AnalysisTimeoutError,
  AnalysisUpstreamError,
  type AnalysisGatewayErrorCode,
} from '../platform/analysis-errors.ts'
import { AnalysisCache } from '../platform/cache.ts'
import type { ServerConfig } from '../platform/config.ts'
import {
  createGeminiClient,
  type GeminiClient,
} from '../platform/gemini/gemini-client.ts'
import { GeminiGate } from '../platform/gemini/gemini-gate.ts'
import type { SupportedInstrumentId, TimestampMs } from '../domain/contracts.ts'
import { LiveForecastService } from '../features/forecasts/live-forecast.ts'
import { KrakenMarketCollector } from '../features/market-data/kraken-market-collector.ts'
import { MarketStore } from '../features/market-data/market-store.ts'
import { NewsPollingService } from '../features/news/news-poller.ts'
import type { NewsHttpFetcher } from '../features/news/rss-collector.ts'
import { OFFICIAL_RSS_SOURCES } from '../features/news/rss-collector.ts'
import {
  TREE_NEWS_SOURCE,
  TreeNewsService,
} from '../features/news/tree-news.ts'
import {
  ShadowRunNotFoundError,
  ShadowRunService,
  type ShadowStatusView,
} from '../features/shadow-runs/shadow-services.ts'
import {
  createIntelligenceSnapshot,
  IntelligenceStreamHub,
  type IntelligenceCollectorObserver,
} from '../features/observability/stream.ts'
import { AnalysisRateLimiter } from '../platform/limits.ts'
import { AnalyzeService } from '../features/analysis/service.ts'
import { parseAnalysisInputRequest } from '../features/analysis/wire.ts'

export interface AnalysisDependencies {
  client: GeminiClient
  limiter: AnalysisRateLimiter
  cache: AnalysisCache
}

export interface MarketCollectorLifecycle extends IntelligenceCollectorObserver {
  start(instrumentId: string): void | Promise<void>
  stop(): void | Promise<void>
}

export interface TreeNewsLifecycle {
  start(): void
  stop(): void
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
  treeNewsService?: TreeNewsLifecycle
  /**
   * Read-only source for the latest persisted simulations report. The
   * default reads the JSON file written by `pnpm simulations:run`; the GET
   * route never triggers a computation.
   */
  simulationsReportReader?: () => string | undefined
  simulationsRefresher?: () => Promise<void>
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

function defaultSimulationsReportReader(
  reportPath: string,
): () => string | undefined {
  return () => {
    try {
      return readFileSync(reportPath, 'utf8')
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: unknown }).code === 'ENOENT'
      )
        return undefined
      throw error
    }
  }
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
  const rawClient =
    options.overrides?.client ??
    (config.apiKey === '' ? undefined : createGeminiClient(config.apiKey))
  const geminiGate =
    rawClient === undefined ? undefined : new GeminiGate(rawClient)
  const client = geminiGate
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
    config.treeNewsEnabled ||
    config.extraNewsRssSources.length > 0 ||
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
  const newsSources = [
    ...Object.values(OFFICIAL_RSS_SOURCES),
    ...config.extraNewsRssSources,
  ]
  const newsPollingService =
    options.overrides?.newsPollingService ??
    (marketStore !== undefined &&
    (config.newsPollingEnabled || config.treeNewsEnabled)
      ? new NewsPollingService({
          store: marketStore,
          sources: newsSources,
          normalizerSources: [...newsSources, TREE_NEWS_SOURCE],
          userAgent: config.newsUserAgent,
          fetcher: options.overrides?.newsFetch,
          clock:
            options.overrides?.newsClock ?? (() => Date.now() as TimestampMs),
          staleAfterMs: config.newsStaleAfterMs,
          geminiClient: client,
          model: config.model,
          maxOutputTokens: config.maxOutputTokens,
          presentationTimeoutMs: config.timeoutMs,
          onChange: () => publishNewsUpdate(),
        })
      : undefined)
  let newsLoopHandle: unknown
  const treeNewsService =
    options.overrides?.treeNewsService ??
    (config.treeNewsEnabled && newsPollingService !== undefined
      ? new TreeNewsService({
          enabled: true,
          url: config.treeNewsUrl,
          reconnectMinMs: config.treeNewsReconnectMinMs,
          reconnectMaxMs: config.treeNewsReconnectMaxMs,
          onItem: async (item) => {
            await newsPollingService.ingestExternal(
              [item],
              TREE_NEWS_SOURCE.sourceId,
            )
          },
        })
      : undefined)

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
    if (newsPollingService === undefined) return
    if (config.newsPollingEnabled && newsLoopHandle === undefined) {
      void newsPollingService.pollOnce()
      newsLoopHandle = newsScheduler.setInterval(() => {
        void newsPollingService.pollOnce().catch(() => undefined)
      }, config.newsPollIntervalMs)
    }
  }

  const stopNewsLoop = (): void => {
    if (newsLoopHandle !== undefined) {
      newsScheduler.clearInterval(newsLoopHandle)
      newsLoopHandle = undefined
    }
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

  const geminiStatus = () =>
    geminiGate?.status(
      config.apiKey !== '' || options.overrides?.client !== undefined,
    ) ?? { enabled: false, apiKeyConfigured: false }
  app.get('/api/gemini/status', geminiStatus)
  app.put('/api/gemini/status', async (request, reply) => {
    const enabled = (request.body as { enabled?: unknown } | undefined)?.enabled
    if (typeof enabled !== 'boolean')
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'enabled must be a boolean.',
        },
      })
    if (enabled && geminiGate === undefined)
      return reply.code(503).send({
        error: {
          code: 'missing_key',
          message: 'No Gemini API key is configured on the server.',
        },
      })
    geminiGate?.setEnabled(enabled)
    return geminiStatus()
  })

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

  let simulationsRefreshing = false
  app.post('/api/intelligence/simulations/refresh', async (request, reply) => {
    const origin = request.headers.origin
    if (origin !== undefined && origin !== config.corsOrigin) {
      return reply.code(403).send({
        error: {
          code: 'forbidden_origin',
          message: 'Origin is not allowed.',
        },
      })
    }
    if (simulationsRefreshing) {
      return reply.code(409).send({
        error: {
          code: 'simulations_busy',
          message: 'A refresh is already running.',
        },
      })
    }
    simulationsRefreshing = true
    try {
      await (
        options.overrides?.simulationsRefresher ??
        (() => refreshSimulations(config))
      )()
      return reply.send({ status: 'updated' })
    } catch {
      return reply.code(422).send({
        error: {
          code: 'simulations_unavailable',
          message:
            'No contiguous Kraken window is ready. Check market gaps or use simulations:run with an explicit clean --since/--until range.',
        },
      })
    } finally {
      simulationsRefreshing = false
    }
  })

  app.get('/api/intelligence/simulations', (request, reply) => {
    const query = request.query as { instrumentId?: unknown }
    if (query.instrumentId !== undefined && query.instrumentId !== 'BTC-EUR') {
      return reply.code(400).send({
        error: {
          code: 'unsupported_instrument',
          message: 'Only BTC-EUR simulations are supported.',
        },
      })
    }
    const readReport =
      options.overrides?.simulationsReportReader ??
      defaultSimulationsReportReader(config.simulationsReportPath)
    let raw: string | undefined
    try {
      raw = readReport()
    } catch {
      return reply.code(500).send(
        envelope({
          code: 'internal_error',
          message: 'The simulations report could not be read.',
        }),
      )
    }
    if (raw === undefined) {
      return reply.code(404).send({
        error: {
          code: 'simulations_report_missing',
          message:
            'No simulations report has been generated yet. Run the comparison harness to create one.',
        },
        instrumentId: 'BTC-EUR',
        generateCommand: 'pnpm --dir server simulations:run',
      })
    }
    try {
      return reply.send(JSON.parse(raw))
    } catch {
      return reply.code(500).send(
        envelope({
          code: 'internal_error',
          message: 'The stored simulations report is not valid JSON.',
        }),
      )
    }
  })

  app.addHook('onReady', async () => {
    if (config.marketCollectorEnabled) {
      ensureShadowRunExists()
      await marketCollector?.start('BTC-EUR')
      startForecastLoop()
    }
    startNewsLoop()
    treeNewsService?.start()
  })
  app.addHook('onClose', async () => {
    stopForecastLoop()
    stopNewsLoop()
    treeNewsService?.stop()
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

    if (service === undefined || geminiGate?.isEnabled !== true) {
      return reply.code(503).send(
        envelope(
          service === undefined
            ? new AnalysisMissingKeyError(
                'No Gemini API key is configured on the server.',
              )
            : {
                code: 'missing_key',
                message: 'Gemini is disabled by the server.',
              },
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
