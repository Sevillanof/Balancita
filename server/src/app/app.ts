import cors from '@fastify/cors'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import WebSocket from 'ws'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { refreshSimulations } from '../features/simulations/refresh-simulations.ts'
import { getActiveCandidates } from '../features/simulations/candidate-manifest.ts'
import {
  listSimulationReportHistory,
  readSimulationReportHistoryDetail,
} from '../features/simulations/simulations-history.ts'
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
import {
  createHistoricalFundingClient,
  historicalFundingAt,
  type HistoricalFundingFetch,
  type HistoricalFundingRecord,
} from '../features/kraken-futures/historical-funding.ts'
import { KrakenOhlcCollector } from '../features/market-data/kraken-ohlc-collector.ts'
import { PaperForwardService } from '../features/simulations/paper-forward.ts'
import {
  fastReplayFeaturesAt,
  resample1mTo15m,
} from '../features/simulations/fast-replay-engine.ts'
import {
  buildStrategyPositions,
  getStrategiesAnalyticsSummary,
} from '../features/paper-trading/strategies-analytics.ts'
import {
  collectKrakenOhlc,
  KRAKEN_OHLC_MAX_CANDLES,
  KRAKEN_OHLC_MAX_HOURS,
} from '../features/market-data/kraken-ohlc.ts'
import {
  FAST_REPLAY_STRATEGIES,
  fastReplayHash,
  runFastReplay,
} from '../features/simulations/fast-replay-engine.ts'
import {
  PythonLedgerExecutionError,
  PythonLedgerTimeoutError,
  PythonLedgerUnavailableError,
  runPythonLedgerBridge,
} from '../features/simulations/python-ledger-bridge.ts'
import { NewsPollingService } from '../features/news/news-poller.ts'
import {
  KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO,
  SIMULATED_COSTS_CAVEAT,
} from '../features/simulations/fee-scenario.ts'
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
import { FuturesSessionRuntime } from '../features/paper-futures/futures-session-runtime.ts'
import { canonicalHash } from '../features/paper-futures/futures-canonical.ts'
import { registerTerminalStream } from '../features/terminal-stream/terminal-stream.ts'
import {
  FUTURES_PRODUCT,
  KrakenFuturesMarketCollector,
  PAPER_MARKET_QUALITY_POLICY,
  validateInstrumentCatalog,
  type FuturesSocket,
  type MarketStatus,
} from '../features/kraken-futures/futures-market.ts'
import { FuturesCandleBuilder } from '../features/kraken-futures/futures-candles.ts'
import { FuturesMarketStore } from '../features/kraken-futures/futures-market-store.ts'

export interface AnalysisDependencies {
  client: GeminiClient
  limiter: AnalysisRateLimiter
  cache: AnalysisCache
}

export interface MarketCollectorLifecycle extends IntelligenceCollectorObserver {
  start(instrumentId: string): void | Promise<void>
  stop(): void | Promise<void>
}

export interface OhlcCollectorLifecycle {
  start(): void
  stop(): void | Promise<void>
  getStatus(): {
    readonly running: boolean
    readonly lastSuccessfulSync: number
    readonly candleCount: number
    readonly minTimestamp: string | null
    readonly maxTimestamp: string | null
    readonly coverageHours: number
    readonly gapCount: number
  }
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

function assertReplaySourceIsSeparate(sourcePath: string, accountPath: string) {
  if (accountPath === ':memory:') return
  const source = realpathSync(sourcePath)
  const account = existsSync(accountPath)
    ? realpathSync(accountPath)
    : resolve(accountPath)
  const sourceStat = statSync(source)
  if (
    source === account ||
    (existsSync(accountPath) &&
      sourceStat.dev === statSync(account).dev &&
      sourceStat.ino === statSync(account).ino)
  )
    throw new Error(
      'Futures account database must be distinct from the replay source.',
    )
}

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export interface MarketDependencies {
  marketCollector: MarketCollectorLifecycle
  ohlcCollector?: OhlcCollectorLifecycle
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
  simulationsRefresher?: (sample?: {
    readonly stage: 'smoke' | 'confirm'
    readonly seed: number
  }) => Promise<void>
  futuresPublicCatalog?: () => Promise<unknown>
  futuresSocketFactory?: (url: string) => FuturesSocket
  futuresClock?: () => number
}

type ErrorEnvelope = {
  error: { code: AnalysisGatewayErrorCode | 'internal_error'; message: string }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

function isCurrentFeeScenario(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.version === KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO.version &&
    value.pair === KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO.pair &&
    value.role === KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO.role &&
    value.sourceUrl === KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO.sourceUrl &&
    value.commissionRate ===
      KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO.commissionRate &&
    value.slippageRate === KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO.slippageRate
  )
}

function isFastReplayHistoryRecord(value: unknown): boolean {
  if (!isRecord(value)) return false
  const window = value.window
  const trades = value.trades
  if (!isRecord(window) || !Array.isArray(trades)) return false
  if (
    typeof value.id !== 'string' ||
    !FAST_REPLAY_STRATEGIES.includes(
      value.strategyId as (typeof FAST_REPLAY_STRATEGIES)[number],
    ) ||
    !isRecord(value.request) ||
    typeof value.datasetHash !== 'string' ||
    typeof value.contentHash !== 'string' ||
    !isSafeInteger(value.createdAt) ||
    !isSafeInteger(value.candlesEvaluated) ||
    !isSafeInteger(value.sampleCount) ||
    !isSafeInteger(value.tradesCount) ||
    (value.rawSignalsCount !== undefined &&
      !isSafeInteger(value.rawSignalsCount)) ||
    (value.gateRejectionsCount !== undefined &&
      !isSafeInteger(value.gateRejectionsCount)) ||
    !isFiniteNumber(value.netPnlEur) ||
    !(value.winRatePct === null || isFiniteNumber(value.winRatePct)) ||
    !(value.profitFactor === null || isFiniteNumber(value.profitFactor)) ||
    !(
      value.brierScoreMulticlass === null ||
      isFiniteNumber(value.brierScoreMulticlass)
    ) ||
    !isFiniteNumber(value.baselineUniformBrier) ||
    !(
      value.baselineNoChangeBrier === null ||
      isFiniteNumber(value.baselineNoChangeBrier)
    ) ||
    !isFiniteNumber(value.executionTimeMs) ||
    !isSafeInteger(window.start_time) ||
    !isSafeInteger(window.end_time) ||
    (window.start_time as number) < 0 ||
    (window.end_time as number) < (window.start_time as number)
  )
    return false
  return trades.every(
    (trade) =>
      isRecord(trade) &&
      (trade.side === 'buy' || trade.side === 'sell') &&
      isSafeInteger(trade.timestamp) &&
      isFiniteNumber(trade.price) &&
      (trade.price as number) > 0 &&
      isFiniteNumber(trade.quantity) &&
      (trade.quantity as number) > 0 &&
      isFiniteNumber(trade.feeEur) &&
      (trade.pnlEur === undefined || isFiniteNumber(trade.pnlEur)),
  )
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

function fundingAvailableAt(
  store: FuturesMarketStore | undefined,
  at: number,
): HistoricalFundingRecord | null {
  const records = (store?.fundingForInterval(at, at) ?? []).map((record) => ({
    startMs: Number(record.startMs),
    endMs: Number(record.endMs),
    fundingRate: String(record.fundingRate),
    unit: 'USD/BTC/hour' as const,
    knownAtMs: Number(record.knownAtMs),
    serverTime: String(record.serverTime),
    sha256: String(record.sha256),
    rawResponse: '',
  }))
  return historicalFundingAt(records, at, at)
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

async function fetchFuturesPublicCatalog(): Promise<unknown> {
  const response = await fetch(
    'https://futures.kraken.com/derivatives/api/v3/instruments',
    {
      signal: AbortSignal.timeout(10_000),
      headers: {
        accept: 'application/json',
        'user-agent': 'Balancita public futures market',
      },
    },
  )
  if (!response.ok)
    throw new Error(
      `Public futures instrument catalog HTTP ${response.status}.`,
    )
  return response.json()
}

export async function buildApp(options: {
  config: ServerConfig
  overrides?: Partial<AnalysisDependencies & MarketDependencies> & {
    futuresFundingFetch?: HistoricalFundingFetch
  }
}): Promise<FastifyInstance> {
  const { config } = options
  const legacyServicesEnabled = config.futuresMode === undefined
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
  const rawClient = legacyServicesEnabled
    ? (options.overrides?.client ??
      (config.apiKey === '' ? undefined : createGeminiClient(config.apiKey)))
    : undefined
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
    (legacyServicesEnabled &&
      (config.krakenWsCollectorEnabled ||
        config.krakenPaperTradingEnabled ||
        config.krakenRestOhlcWorkerEnabled ||
        config.newsPollingEnabled ||
        config.treeNewsEnabled ||
        config.extraNewsRssSources.length > 0)) ||
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
  const paperForward =
    config.krakenPaperTradingEnabled && marketStore !== undefined
      ? new PaperForwardService({ store: marketStore })
      : undefined
  const ohlcCollector =
    marketStore === undefined || !config.krakenRestOhlcWorkerEnabled
      ? undefined
      : (options.overrides?.ohlcCollector ??
        new KrakenOhlcCollector({
          store: marketStore,
          baseUrl: config.krakenRestUrl,
          fetch: async (url, init) => {
            const headers = new Headers(init?.headers)
            headers.set('Accept', 'application/json')
            return marketFetch(url, { ...init, headers })
          },
          intervalMs: paperForward ? 60_000 : config.marketCollectorIntervalMs,
          onClosedCandles: (candles) => {
            if (paperForward === undefined) return
            const orderedCandles = [...candles].sort(
              (left, right) => left.candle.timestamp - right.candle.timestamp,
            )
            console.info('PaperForward received closed Kraken OHLC candles.', {
              count: orderedCandles.length,
              firstEventTime: new Date(
                orderedCandles[0]!.candle.timestamp * 1000,
              ).toISOString(),
              lastEventTime: new Date(
                orderedCandles.at(-1)!.candle.timestamp * 1000,
              ).toISOString(),
            })
            for (const { candle, nextOpen } of orderedCandles) {
              paperForward.recordReceivedEvent(
                candle.timestamp * 1000,
                Date.now(),
              )
              paperForward.processClosedCandle(candle, nextOpen)
              console.debug(
                'PaperForward processed closed candle for 15m evaluation.',
                {
                  eventTime: new Date(candle.timestamp * 1000).toISOString(),
                  lastProcessedEventTime: new Date(
                    (paperForward.lastProcessedCandleTimestamp() ?? 0) * 1000,
                  ).toISOString(),
                },
              )
              if ((candle.timestamp + 60) % 900 === 0)
                console.info('PaperForward evaluated completed 15m bucket.', {
                  bucketEnd: new Date(
                    (candle.timestamp + 60) * 1000,
                  ).toISOString(),
                  eventTime: new Date(candle.timestamp * 1000).toISOString(),
                })
            }
            paperForward.setRunning(true)
            paperForward.setStreamState('connected')
          },
          logger: {
            info: (fields, message) => console.info(message, fields),
            debug: (fields, message) => console.debug(message, fields),
            warn: (fields, message) => console.warn(message, fields),
          },
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
        collectorEnabled: config.krakenWsCollectorEnabled,
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
  let futuresMarketStore: FuturesMarketStore | undefined
  let futuresSourceHash: string | null = null
  let futuresSourceMetadataHash: string | null = null
  let futuresSourceQualityHash: string | null = null
  let sourceInitialHash: string | null = null
  let futuresReplayCutoffMs: number | null = null
  if (config.futuresMode === 'replay') {
    assertReplaySourceIsSeparate(
      config.futuresReplaySourceDbPath!,
      config.futuresDbPath,
    )
    sourceInitialHash = fileSha256(config.futuresReplaySourceDbPath!)
    futuresMarketStore = new FuturesMarketStore(
      config.futuresReplaySourceDbPath!,
      { readOnly: true },
    )
    const instruments = futuresMarketStore.instrumentVersions() as {
      metadata_hash: string
      payload_json: string
    }[]
    const policies = futuresMarketStore.qualityPolicies() as {
      version: string
      payloadJson: string
    }[]
    const sourceEvents = futuresMarketStore.eventsAsOf(
      Number.MAX_SAFE_INTEGER,
    ) as Record<string, unknown>[]
    const sourceCandles = futuresMarketStore.candleRevisions() as Record<
      string,
      unknown
    >[]
    const sourceFunding = futuresMarketStore.fundingSourceEvidence()
    if (
      instruments.length !== 1 ||
      policies.length === 0 ||
      JSON.parse(instruments[0]!.payload_json).productId !== FUTURES_PRODUCT
    ) {
      futuresMarketStore.close()
      throw new Error(
        'Replay source must contain one frozen PF_XBTUSD catalog and a quality policy.',
      )
    }
    futuresSourceMetadataHash = canonicalHash(instruments)
    futuresSourceQualityHash = canonicalHash(policies)
    futuresReplayCutoffMs =
      config.futuresReplayCutoffMs ??
      Math.max(
        0,
        ...sourceEvents.map((event) => Number(event.receivedAt)),
        ...sourceCandles.map((candle) => Number(candle.known_at)),
        ...sourceFunding.map((record) => Number(record.knownAtMs)),
      )
    futuresSourceHash = canonicalHash({
      events: futuresMarketStore.eventsAsOf(Number.MAX_SAFE_INTEGER),
      candles: futuresMarketStore.candlesAsOf(Number.MAX_SAFE_INTEGER),
      gaps: futuresMarketStore.gapsAsOf(Number.MAX_SAFE_INTEGER),
      ...(sourceFunding.length === 0 ? {} : { funding: sourceFunding }),
    })
    if (
      futuresMarketStore.eventCount() > 100_000 ||
      futuresMarketStore.candleRevisions().length > 100_000
    ) {
      futuresMarketStore.close()
      throw new Error('Replay source exceeds the configured evidence bound.')
    }
  }
  const futuresRuntime =
    config.futuresMode === undefined
      ? undefined
      : config.futuresMode === 'mock'
        ? new FuturesSessionRuntime({
            dbPath: config.futuresDbPath,
            mode: config.futuresMode,
          })
        : new FuturesSessionRuntime({
            dbPath: config.futuresDbPath,
            mode: config.futuresMode,
            ...(futuresMarketStore ? { replaySource: futuresMarketStore } : {}),
            ...(sourceInitialHash
              ? { replaySourceFileHash: sourceInitialHash }
              : {}),
            ...(futuresReplayCutoffMs === null
              ? {}
              : { replayCutoffMs: futuresReplayCutoffMs }),
            ...(futuresSourceMetadataHash
              ? { replaySourceMetadataHash: futuresSourceMetadataHash }
              : {}),
            ...(futuresSourceQualityHash
              ? { replaySourceQualityHash: futuresSourceQualityHash }
              : {}),
          })
  let futuresCollector: KrakenFuturesMarketCollector | undefined
  let futuresStatus: MarketStatus | 'unavailable' =
    config.futuresMode === 'paper_live' ? 'connecting' : 'stopped'
  let futuresStatusReason: string | undefined
  let futuresLastReceivedAt: number | null = null
  let futuresInstrumentMetadataHash: string | null = null
  let futuresMarketTail = Promise.resolve()
  let futuresCandleTimer: ReturnType<typeof setInterval> | undefined
  let futuresFundingTimer: ReturnType<typeof setInterval> | undefined
  let futuresFundingClient:
    ReturnType<typeof createHistoricalFundingClient> | undefined
  let futuresFundingPoll: Promise<void> | undefined
  let futuresFundingKnownAt: number | null = null
  let pendingFuturesUiUpdate: Record<string, unknown> | undefined
  let futuresUiTimer: ReturnType<typeof setTimeout> | undefined
  const flushFuturesUiUpdate = (): void => {
    if (!pendingFuturesUiUpdate || !futuresRuntime) return
    const update = pendingFuturesUiUpdate
    pendingFuturesUiUpdate = undefined
    futuresRuntime.store.appendTerminalEvents(futuresRuntime.runId, [
      { type: 'market.updated', data: update },
    ])
  }
  const queueFuturesUiUpdate = (update: Record<string, unknown>): void => {
    pendingFuturesUiUpdate = { ...pendingFuturesUiUpdate, ...update }
    if (futuresUiTimer !== undefined) return
    futuresUiTimer = setTimeout(() => {
      futuresUiTimer = undefined
      flushFuturesUiUpdate()
    }, 100)
  }
  if (config.futuresMode === 'paper_live' && futuresRuntime !== undefined) {
    futuresMarketStore = new FuturesMarketStore(config.futuresMarketDbPath)
    futuresMarketStore.saveQualityPolicy(
      PAPER_MARKET_QUALITY_POLICY,
      (options.overrides?.futuresClock ?? Date.now)(),
    )
  }
  if (futuresRuntime !== undefined) {
    registerTerminalStream(app, {
      store: futuresRuntime.store,
      runner: futuresRuntime.runner,
      commandFactory: futuresRuntime.commandFactory,
      allowedOrigins: [
        config.corsOrigin,
        'http://localhost',
        'http://127.0.0.1',
        'http://[::1]',
      ],
      newRunFactory: futuresRuntime.newRunFactory,
      commandExecutor: futuresRuntime.commandExecutor,
      onNewRunCreated: futuresRuntime.activateRun,
    })
    app.get('/api/terminal/bootstrap', () => ({
      schema_version: 1,
      mode: config.futuresMode,
      source:
        config.futuresMode === 'mock'
          ? 'versioned-mock-fixture.v1'
          : config.futuresMode === 'paper_live'
            ? 'kraken-public-live-stream.v1'
            : 'frozen-kraken-futures-market.v1',
      active_run_id: futuresRuntime.runId,
      ...(config.futuresMode === 'replay'
        ? {
            instrument_id: 'kraken-futures:PF_XBTUSD',
            product_id: FUTURES_PRODUCT,
            quote_currency: 'USD',
            source_manifest: {
              schema_version: 'futures-replay-source-manifest.v1',
              source_hash: futuresSourceHash,
              source_file_hash: sourceInitialHash,
              instrument_metadata_hash: futuresSourceMetadataHash,
              quality_policy_hash: futuresSourceQualityHash,
              replay_cutoff_ms: futuresReplayCutoffMs,
              received_cursor: futuresMarketStore?.eventCount() ?? 0,
            },
            market: {
              status: (
                futuresMarketStore?.candlesAsOf(futuresReplayCutoffMs ?? 0) ??
                []
              ).some(
                (candle) =>
                  typeof candle === 'object' &&
                  candle !== null &&
                  'interval_ms' in candle &&
                  Number(candle.interval_ms) === 60_000,
              )
                ? 'ready'
                : 'insufficient_history',
              reason: (
                futuresMarketStore?.candlesAsOf(futuresReplayCutoffMs ?? 0) ??
                []
              ).some(
                (candle) =>
                  typeof candle === 'object' &&
                  candle !== null &&
                  'interval_ms' in candle &&
                  Number(candle.interval_ms) === 60_000,
              )
                ? null
                : 'No closed source candles were known by the frozen replay cutoff.',
              last_received_at: null,
              book_status: 'recorded',
              fidelity: 'persisted_public_futures_evidence',
              funding: 'unknown_unless_explicitly_proven',
              candles: (
                futuresMarketStore?.candlesAsOf(futuresReplayCutoffMs ?? 0) ??
                []
              )
                .filter(
                  (candle) =>
                    typeof candle === 'object' &&
                    candle !== null &&
                    'interval_ms' in candle &&
                    Number(candle.interval_ms) === 60_000,
                )
                .slice(-500),
            },
            operations: 'simulated',
          }
        : {}),
      ...(config.futuresMode === 'paper_live'
        ? {
            instrument_id: 'kraken-futures:PF_XBTUSD',
            product_id: FUTURES_PRODUCT,
            quote_currency: 'USD',
            metadata_hash: futuresInstrumentMetadataHash,
            market: {
              status: futuresStatus,
              reason: futuresStatusReason ?? null,
              last_received_at: futuresLastReceivedAt,
              latest_quote: (() => {
                const event = futuresMarketStore?.latestTickerAsOf(
                  Number.MAX_SAFE_INTEGER,
                )
                return event
                  ? {
                      last: event.last ?? null,
                      mark: event.mark ?? null,
                      event_time: event.eventTime,
                      received_at: event.receivedAt,
                      persisted_at: event.persistedAt,
                      epoch: event.epoch,
                      sequence: event.seq,
                      received_sequence: event.receivedSequence,
                    }
                  : null
              })(),
              book_status: futuresCollector?.book.valid
                ? 'valid'
                : 'unavailable',
              book_quality:
                futuresCollector?.book.sequenceIntegrity ??
                'invalid_or_unproven',
              book_quality_policy: PAPER_MARKET_QUALITY_POLICY.version,
              source_guarantee: 'undocumented',
              funding: fundingAvailableAt(
                futuresMarketStore,
                options.overrides?.futuresClock?.() ?? Date.now(),
              )
                ? 'known_current_interval'
                : 'unknown',
              funding_known_at: futuresFundingKnownAt,
            },
            engine: {
              status:
                futuresLastReceivedAt === null ? 'warming' : 'blocked_funding',
              funding:
                futuresFundingKnownAt === null ? 'unresolved' : 'observed',
            },
          }
        : {}),
    }))
    app.get('/api/terminal/export', async (_request, reply) => {
      if (config.futuresMode !== 'replay' || !futuresRuntime)
        return reply.code(404).send({
          error: { code: 'replay_export_unavailable' },
        })
      try {
        if (fileSha256(config.futuresReplaySourceDbPath!) !== sourceInitialHash)
          throw new Error('Replay source database bytes changed after startup.')
        const exported = await futuresRuntime.exportReplayRun()
        if (!exported.verified)
          return reply.code(409).send({
            error: { code: 'replay_export_verification_failed' },
          })
        const body = JSON.stringify(exported)
        if (Buffer.byteLength(body, 'utf8') > 10_000_000)
          return reply.code(413).send({
            error: { code: 'replay_export_exceeds_size_limit' },
          })
        return reply
          .header('content-type', 'application/json; charset=utf-8')
          .header(
            'content-disposition',
            'attachment; filename="futures-replay-export.json"',
          )
          .send(body)
      } catch (error) {
        return reply.code(409).send({
          error: {
            code: 'replay_export_failed',
            message:
              error instanceof Error ? error.message : 'Replay export failed.',
          },
        })
      }
    })
    app.addHook('onReady', async () => {
      await futuresRuntime.start()
      if (config.futuresMode === 'replay' && futuresMarketStore) {
        if (fileSha256(config.futuresReplaySourceDbPath!) !== sourceInitialHash)
          throw new Error(
            'Replay source database bytes changed during startup.',
          )
        return
      }
      if (config.futuresMode !== 'paper_live' || !futuresMarketStore) return
      const clock = options.overrides?.futuresClock ?? Date.now
      try {
        const catalog =
          options.overrides?.futuresPublicCatalog !== undefined
            ? await options.overrides.futuresPublicCatalog()
            : await fetchFuturesPublicCatalog()
        const spec = validateInstrumentCatalog(catalog, {
          source: 'live',
          retrievedAt: clock(),
        })
        futuresMarketStore.saveInstrument(spec, catalog)
        futuresInstrumentMetadataHash = spec.metadataHash
        if (spec.entryEligibility !== 'eligible') {
          futuresStatus = 'unavailable'
          futuresStatusReason = `catalog_${spec.entryEligibility}`
          return
        }
        const candleBuilder = new FuturesCandleBuilder(
          futuresMarketStore,
          undefined,
          (candle) => {
            if (candle.interval_ms === 60_000) queueFuturesUiUpdate({ candle })
          },
        )
        futuresCandleTimer = setInterval(
          () => candleBuilder.advanceClock(clock()),
          1_000,
        )
        futuresFundingClient = createHistoricalFundingClient({
          fetch: options.overrides?.futuresFundingFetch,
        })
        const pollFunding = async (): Promise<void> => {
          const receivedAt = clock()
          try {
            const response = await futuresFundingClient!.fetch(receivedAt)
            futuresMarketStore!.appendFundingResponse(response)
            futuresFundingKnownAt = fundingAvailableAt(
              futuresMarketStore,
              receivedAt,
            )
              ? receivedAt
              : null
          } catch (error) {
            futuresFundingKnownAt = null
            if (!(error instanceof Error && error.name === 'AbortError'))
              console.warn(
                'Public Kraken historical funding unavailable.',
                error,
              )
          }
        }
        futuresFundingPoll = pollFunding()
        futuresFundingTimer = setInterval(() => {
          futuresFundingPoll = pollFunding()
        }, 300_000)
        futuresCollector = new KrakenFuturesMarketCollector({
          clock,
          random: Math.random,
          makeSocket:
            options.overrides?.futuresSocketFactory ??
            ((url) => new WebSocket(url) as unknown as FuturesSocket),
          setTimeout,
          clearTimeout,
          staleAfterMs: config.marketStaleAfterMs,
          reconnectMinMs: config.marketReconnectMinMs,
          reconnectMaxMs: config.marketReconnectMaxMs,
          persist: (event) => {
            const inserted = futuresMarketStore!.append(event)
            if (inserted === 'inserted') {
              futuresLastReceivedAt = event.receivedAt
              if (event.type === 'trade')
                candleBuilder.addTrade(event, event.receivedAt)
              const normalized = Object.fromEntries(
                Object.entries(event).filter(
                  ([key]) => key !== 'raw' && key !== 'rawJson',
                ),
              )
              queueFuturesUiUpdate({
                feed: event.type,
                product_id: event.productId,
                event_time: event.eventTime,
                received_at: event.receivedAt,
                last_received_at: futuresLastReceivedAt,
                market_status: futuresStatus,
                book_quality: futuresCollector?.book
                  ? {
                      schema_version: 'futures-market-quality-attestation.v1',
                      policy_version: futuresCollector.book.qualityPolicy,
                      source_guarantee: futuresCollector.book.sourceGuarantee,
                      book_valid: futuresCollector.book.valid,
                      book_sequence_integrity:
                        futuresCollector.book.sequenceIntegrity,
                      executable_eligible:
                        futuresCollector.book.executableEligible,
                      epoch: futuresCollector.book.epoch,
                      sequence: futuresCollector.book.sequence,
                    }
                  : null,
                normalized,
              })
              futuresMarketTail = futuresMarketTail
                .then(() =>
                  futuresRuntime.processMarketEvidence(
                    futuresMarketStore!,
                    event.receivedAt,
                  ),
                )
                .catch((error: unknown) => {
                  console.error(
                    'futures runtime evidence processing failed',
                    error,
                  )
                  futuresStatus = 'unavailable'
                  futuresStatusReason =
                    error instanceof Error ? error.message : 'runtime_error'
                })
            }
            return inserted
          },
          persistGap: (gap) => {
            futuresMarketStore!.appendGap(gap)
            futuresStatus = 'degraded'
            futuresStatusReason = gap.reason
            queueFuturesUiUpdate({
              feed_status: 'degraded',
              reason: gap.reason,
              gap,
              received_at: gap.detectedAt,
            })
          },
          onState: (state, reason) => {
            futuresStatus = state
            futuresStatusReason = reason
            queueFuturesUiUpdate({
              feed_status: state,
              market_status: state,
              reason: reason ?? null,
              received_at: futuresLastReceivedAt,
              last_received_at: futuresLastReceivedAt,
              book_quality: futuresCollector?.book
                ? {
                    schema_version: 'futures-market-quality-attestation.v1',
                    policy_version: futuresCollector.book.qualityPolicy,
                    source_guarantee: futuresCollector.book.sourceGuarantee,
                    book_valid: futuresCollector.book.valid,
                    book_sequence_integrity:
                      futuresCollector.book.sequenceIntegrity,
                    executable_eligible:
                      futuresCollector.book.executableEligible,
                    epoch: futuresCollector.book.epoch,
                    sequence: futuresCollector.book.sequence,
                  }
                : null,
            })
          },
        })
        futuresCollector.start()
      } catch (error) {
        futuresStatus = 'unavailable'
        futuresStatusReason =
          error instanceof Error ? error.message : 'catalog_unavailable'
      }
    })
    app.addHook('onClose', async () => {
      futuresCollector?.stop()
      if (futuresCandleTimer !== undefined) clearInterval(futuresCandleTimer)
      futuresCandleTimer = undefined
      if (futuresFundingTimer !== undefined) clearInterval(futuresFundingTimer)
      futuresFundingTimer = undefined
      futuresFundingClient?.close()
      futuresFundingClient = undefined
      await futuresFundingPoll
      futuresFundingPoll = undefined
      if (futuresUiTimer !== undefined) clearTimeout(futuresUiTimer)
      futuresUiTimer = undefined
      flushFuturesUiUpdate()
      await futuresMarketTail
      futuresMarketStore?.close()
      await futuresRuntime.close()
    })
  }

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
  app.get(
    '/api/paper-trading/status',
    () =>
      paperForward?.status(true) ?? {
        enabled: false,
        running: false,
        stream_state: 'disabled',
        last_received_event_time: null,
        last_received_at: null,
        last_processed_event_time: null,
        candles_ready: false,
        account: {
          balance_eur: 10_000,
          btc_balance: 0,
          total_equity_eur: 10_000,
        },
        active_positions: [],
        execution_summary: {
          total_signals: 0,
          gate_rejections: 0,
          executed_trades: 0,
          closed_pnl_eur: 0,
        },
      },
  )
  app.get('/api/paper-trading/orders', (request, reply) => {
    const rawLimit = (request.query as { limit?: unknown } | undefined)?.limit
    const limit = rawLimit === undefined ? 500 : Number(rawLimit)
    if (!Number.isSafeInteger(limit) || limit < 1)
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'limit must be a positive integer.',
        },
      })
    return {
      orders:
        marketStore
          ?.listRecentPaperOrders(Math.min(limit, 1000))
          .map(
            ({
              id,
              strategyId,
              signalTimestamp,
              action,
              gatePassed,
              executionTimestamp,
              amountEur,
            }) => ({
              id,
              strategyId,
              signalTimestamp,
              action,
              gatePassed,
              executionTimestamp,
              amountEur,
            }),
          ) ?? [],
    }
  })
  app.get('/api/paper-trading/decisions', (request, reply) => {
    const query = request.query as {
      limit?: unknown
      before?: unknown
      before_id?: unknown
      strategy_id?: unknown
    }
    const limit = query.limit === undefined ? 100 : Number(query.limit)
    const before = query.before === undefined ? undefined : Number(query.before)
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) ||
      (before !== undefined && typeof query.before_id !== 'string') ||
      (before === undefined && query.before_id !== undefined) ||
      (query.strategy_id !== undefined &&
        (typeof query.strategy_id !== 'string' ||
          query.strategy_id.length === 0))
    )
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'Decision query parameters are invalid.',
        },
      })
    const pageLimit = Math.min(limit, 500)
    const page =
      marketStore?.listPaperDecisions({
        limit: pageLimit + 1,
        before,
        beforeId: query.before_id as string | undefined,
        strategyId: query.strategy_id as string | undefined,
      }) ?? []
    const hasMore = page.length > pageLimit
    const decisions = hasMore ? page.slice(0, pageLimit) : page
    const last = decisions.at(-1)
    return {
      decisions,
      nextCursor:
        hasMore && last !== undefined
          ? { before: last.eventTime, before_id: last.id }
          : null,
    }
  })
  app.get('/api/paper-trading/strategies-summary', () => {
    return getStrategiesAnalyticsSummary({
      paperOrderSignalAggregates: () =>
        marketStore?.paperOrderSignalAggregates() ?? [],
      listPaperOrders: () => marketStore?.listPaperOrders() ?? [],
    })
  })
  app.get('/api/paper-trading/positions', (request, reply) => {
    const query = request.query as { status?: unknown; limit?: unknown }
    const status = query.status ?? 'all'
    const limit = query.limit === undefined ? 50 : Number(query.limit)
    if (
      (status !== 'all' && status !== 'open' && status !== 'closed') ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200
    )
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message:
            'status must be all, open, or closed and limit must be 1–200.',
        },
      })
    const candles =
      marketStore?.latestContinuousOhlcCandles(
        1_200,
        Math.floor(Date.now() / 60_000) * 60_000,
      ) ?? []
    const complete = resample1mTo15m(
      candles,
      Math.floor(Date.now() / 900_000) * 900,
    )
    const features =
      complete.length === 0 ? null : fastReplayFeaturesAt(complete)
    const price = complete.at(-1)?.close ?? null
    const positions = buildStrategyPositions(
      marketStore?.listPaperOrders() ?? [],
      price,
      features,
      complete.at(-1) === undefined ? null : complete.at(-1)!.timestamp + 900,
      paperForward?.getCurrentRegime('micro-regime-adapter') ?? null,
    )
      .filter(
        (position) =>
          status === 'all' ||
          position.status === (status === 'open' ? 'OPEN' : 'CLOSED'),
      )
      .slice(0, limit)
    return reply.send(positions)
  })

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

  app.get('/api/market/collector/status', () => {
    const status = ohlcCollector?.getStatus()
    const metrics =
      status ??
      (marketStore?.ohlcHistoryMetrics() === undefined
        ? {
            candleCount: 0,
            minTimestamp: null,
            maxTimestamp: null,
            coverageHours: 0,
            gapCount: 0,
            lastSuccessfulSync: 0,
          }
        : (() => {
            const history = marketStore.ohlcHistoryMetrics()
            const state = marketStore.getOhlcCollectorState()
            return {
              candleCount: history.candleCount,
              minTimestamp:
                history.minTimestamp === null
                  ? null
                  : new Date(history.minTimestamp * 1000).toISOString(),
              maxTimestamp:
                history.maxTimestamp === null
                  ? null
                  : new Date(history.maxTimestamp * 1000).toISOString(),
              coverageHours: history.coverageHours,
              gapCount: history.gapCount,
              lastSuccessfulSync: state.lastSuccessfulSync,
            }
          })())
    return {
      enabled: config.krakenRestOhlcWorkerEnabled,
      running: status?.running ?? false,
      total_candles: metrics.candleCount,
      oldest_candle_iso: metrics.minTimestamp,
      newest_candle_iso: metrics.maxTimestamp,
      coverage_hours: metrics.coverageHours,
      gaps_detected: metrics.gapCount,
      last_sync_timestamp: metrics.lastSuccessfulSync,
    }
  })

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

  app.post('/api/market/sync-ohlc', async (request, reply) => {
    const body = (request.body ?? {}) as { hours?: unknown }
    const hours = body.hours === undefined ? KRAKEN_OHLC_MAX_HOURS : body.hours
    if (
      typeof hours !== 'number' ||
      !Number.isFinite(hours) ||
      hours <= 0 ||
      hours > KRAKEN_OHLC_MAX_HOURS
    )
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'hours must be greater than 0 and at most 12.',
        },
      })
    if (marketStore === undefined)
      return reply.code(503).send({
        error: {
          code: 'market_store_unavailable',
          message: 'Persisted OHLC storage is unavailable.',
        },
      })
    try {
      const collected = await collectKrakenOhlc({
        baseUrl: config.krakenRestUrl,
        hours,
        fetch: async (url) =>
          marketFetch(url, { headers: { Accept: 'application/json' } }),
      })
      const inserted = marketStore.upsertOhlcCandles(collected.candles)
      const first = collected.candles[0]
      const last = collected.candles.at(-1)
      return reply.send({
        inserted,
        gaps_detected: collected.gapsDetected,
        requested_hours: hours,
        maximum_candles: KRAKEN_OHLC_MAX_CANDLES,
        coverage: {
          candle_count: collected.candles.length,
          first_candle_time:
            first === undefined ? null : first.timestamp * 1000,
          last_candle_time: last === undefined ? null : last.timestamp * 1000,
        },
      })
    } catch (error) {
      return reply.code(502).send({
        error: {
          code: 'upstream_error',
          message:
            error instanceof Error
              ? error.message
              : 'Kraken OHLC synchronization failed.',
        },
      })
    }
  })

  app.get('/api/market/ohlc', (request, reply) => {
    const query = request.query as { start_time?: unknown; end_time?: unknown }
    const start =
      typeof query.start_time === 'string'
        ? Number(query.start_time)
        : query.start_time
    const end =
      typeof query.end_time === 'string'
        ? Number(query.end_time)
        : query.end_time
    if (
      typeof start !== 'number' ||
      typeof end !== 'number' ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start
    )
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message:
            'start_time and end_time must be ordered epoch milliseconds.',
        },
      })
    if (marketStore === undefined)
      return reply.code(503).send({
        error: {
          code: 'market_store_unavailable',
          message: 'Persisted OHLC storage is unavailable.',
        },
      })
    return reply.send({
      candles: marketStore
        .listOhlcCandles(start, end)
        .map((candle) => ({ ...candle, timestamp: candle.timestamp * 1000 })),
    })
  })

  app.get('/api/strategies', (_request, reply) =>
    reply.send({
      strategies: getActiveCandidates().map((candidate) => ({
        id: candidate.candidateId,
        status: candidate.status,
        name: candidate.candidateId,
      })),
    }),
  )

  app.post('/api/replay/fast-run', (request, reply) => {
    const body = (request.body ?? {}) as {
      strategy_id?: unknown
      start_time?: unknown
      end_time?: unknown
      ticket_eur?: unknown
    }
    const strategyId =
      body.strategy_id === 'donchian-volume-breakout'
        ? 'micro-donchian-breakout'
        : body.strategy_id
    if (
      typeof strategyId !== 'string' ||
      !(FAST_REPLAY_STRATEGIES as readonly string[]).includes(strategyId)
    )
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message:
            'strategy_id must name one of the four supported micro candidates.',
        },
      })
    const start = body.start_time === undefined ? 0 : body.start_time
    const end =
      body.end_time === undefined ? Number.MAX_SAFE_INTEGER : body.end_time
    // For new cash-all-in.v1 runs, ticket_eur is initial capital inclusive of entry commission.
    // Historical stored runs retain their original sizing meaning, which may be unknown.
    const ticket = body.ticket_eur === undefined ? 30 : body.ticket_eur
    if (
      typeof start !== 'number' ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      typeof end !== 'number' ||
      !Number.isSafeInteger(end) ||
      end < start ||
      typeof ticket !== 'number' ||
      !Number.isFinite(ticket) ||
      ticket <= 0
    )
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'The Fast Replay time window or ticket_eur is invalid.',
        },
      })
    if (marketStore === undefined)
      return reply.code(503).send({
        error: {
          code: 'market_store_unavailable',
          message: 'Persisted OHLC storage is unavailable.',
        },
      })
    const requestedCandles = marketStore.listOhlcCandles(start, end)
    if (requestedCandles.length < 51)
      return reply.code(422).send({
        error: {
          code: 'insufficient_ohlc',
          message: 'At least 51 stored closed 1-minute candles are required.',
        },
      })
    const candles = requestedCandles
    try {
      const bounds = {
        start_time: candles[0]!.timestamp * 1000,
        end_time: candles.at(-1)!.timestamp * 1000,
      }
      const frozenCandles = candles.map((candle) => ({
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      }))
      const datasetHash = fastReplayHash({
        schema: 'fast-replay-candles.v1',
        columns: ['timestamp', 'open', 'high', 'low', 'close', 'volume'],
        candles: frozenCandles.map((candle) => [
          candle.timestamp,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
        ]),
      })
      const result = runFastReplay({ strategyId, candles, ticketEur: ticket })
      const id = `fast-${randomUUID()}`
      const artifact = {
        schema: 'fast-replay-artifact.v1',
        runId: id,
        datasetHash,
        source: 'kraken_rest_ohlc',
        engineOwner: 'typescript',
        timestampUnit: 'unix-seconds',
        candleIntervalSeconds: 60,
        candleTimestampSemantics: 'bucket-start',
        cutoffEpochMs: bounds.end_time,
        strategyId: result.strategyId,
        window: bounds,
        feeScenario: result.feeScenario,
        sizingModel: result.sizingModel,
        initialCashEur: result.initialCashEur,
        candles: frozenCandles,
      }
      const contentHash = fastReplayHash({
        id,
        strategyId: result.strategyId,
        bounds,
        result,
        datasetHash,
        artifact,
      })
      const trades = result.trades.map((trade) => ({
        ...trade,
        timestamp: trade.timestamp * 1000,
      }))
      const record = {
        ...result,
        trades,
        nativeTradeTimestampUnit: 'unix-milliseconds',
        nativeTradeTimestampMeaning: 'simulated-next-15m-candle-open',
        id,
        strategy_id: result.strategyId,
        candles_evaluated: result.candlesEvaluated,
        sample_count: result.sampleCount,
        trades_count: result.tradesCount,
        raw_signals_count: result.rawSignalsCount,
        gate_rejections_count: result.gateRejectionsCount,
        win_rate_pct: result.winRatePct,
        profit_factor: result.profitFactor,
        net_pnl_eur: result.netPnlEur,
        brier_score_multiclass: result.brierScoreMulticlass,
        baseline_uniform_brier: result.baselineUniformBrier,
        baseline_no_change_brier: result.baselineNoChangeBrier,
        execution_time_ms: result.executionTimeMs,
        datasetHash,
        contentHash,
        window: bounds,
        artifact,
      }
      marketStore.saveFastReplayRun(
        id,
        {
          strategy_id: strategyId,
          start_time: bounds.start_time,
          end_time: bounds.end_time,
          ticket_eur: ticket,
        },
        record,
        datasetHash,
        contentHash,
      )
      return reply.send(record)
    } catch (error) {
      return reply.code(422).send({
        error: {
          code: 'fast_replay_invalid_dataset',
          message:
            error instanceof Error
              ? error.message
              : 'Fast Replay could not process this dataset.',
        },
      })
    }
  })

  app.post('/api/replay/python-ledger-run', async (request, reply) => {
    const body = (request.body ?? {}) as {
      strategy_id?: unknown
      start_time?: unknown
      end_time?: unknown
      ticket_eur?: unknown
    }
    const strategyId =
      body.strategy_id === 'donchian-volume-breakout'
        ? 'micro-donchian-breakout'
        : body.strategy_id
    if (
      typeof strategyId !== 'string' ||
      !(FAST_REPLAY_STRATEGIES as readonly string[]).includes(strategyId)
    )
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message:
            'strategy_id must name one of the four supported micro candidates.',
        },
      })
    const start = body.start_time === undefined ? 0 : body.start_time
    const end =
      body.end_time === undefined ? Number.MAX_SAFE_INTEGER : body.end_time
    const ticket = body.ticket_eur === undefined ? 30 : body.ticket_eur
    if (
      typeof start !== 'number' ||
      !Number.isSafeInteger(start) ||
      start < 0 ||
      typeof end !== 'number' ||
      !Number.isSafeInteger(end) ||
      end < start ||
      typeof ticket !== 'number' ||
      !Number.isFinite(ticket) ||
      ticket <= 0
    )
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'The Python ledger time window or ticket_eur is invalid.',
        },
      })
    if (marketStore === undefined)
      return reply.code(503).send({
        error: {
          code: 'market_store_unavailable',
          message: 'Persisted OHLC storage is unavailable.',
        },
      })
    const candles = marketStore.listOhlcCandles(start, end)
    if (candles.length < 51)
      return reply.code(422).send({
        error: {
          code: 'insufficient_ohlc',
          message: 'At least 51 stored closed 1-minute candles are required.',
        },
      })

    const started = performance.now()
    try {
      const bounds = {
        start_time: candles[0]!.timestamp * 1000,
        end_time: candles.at(-1)!.timestamp * 1000,
      }
      const frozenCandles = candles.map((candle) => ({
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume,
      }))
      const datasetHash = fastReplayHash({
        schema: 'fast-replay-candles.v1',
        columns: ['timestamp', 'open', 'high', 'low', 'close', 'volume'],
        candles: frozenCandles.map((candle) => [
          candle.timestamp,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
        ]),
      })
      const { typescriptResult, pythonLedger } = await runPythonLedgerBridge({
        strategyId,
        candles,
        startingCash: ticket,
      })
      if (pythonLedger.ledger === null)
        return reply.code(422).send({
          error: {
            code: 'python_ledger_unavailable',
            message: `The Python replay returned ${pythonLedger.status} without a ledger.`,
          },
        })

      const id = `python-ledger-${randomUUID()}`
      const artifact = {
        schema: 'fast-replay-artifact.v1',
        runId: id,
        datasetHash,
        source: 'kraken_rest_ohlc',
        engineOwner: 'typescript',
        timestampUnit: 'unix-seconds',
        candleIntervalSeconds: 60,
        candleTimestampSemantics: 'bucket-start',
        cutoffEpochMs: bounds.end_time,
        strategyId: typescriptResult.strategyId,
        window: bounds,
        feeScenario: typescriptResult.feeScenario,
        sizingModel: 'python-long-flat-ledger.v1',
        initialCashEur: ticket,
        candles: frozenCandles,
      }
      const trades = pythonLedger.executionAudit.fills.flatMap((audit) => {
        const fill = pythonLedger.ledger!.fills[audit.fillIndex]
        if (
          fill === undefined ||
          audit.timingStatus !== 'modeled_next_open' ||
          !isSafeInteger(audit.executionAtMs) ||
          (fill.side !== 'buy' && fill.side !== 'sell') ||
          audit.fillSide !== fill.side ||
          !isFiniteNumber(fill.price) ||
          !isFiniteNumber(fill.qty) ||
          !isFiniteNumber(fill.commission)
        )
          return []
        return [
          {
            side: fill.side,
            timestamp: audit.executionAtMs,
            price: fill.price,
            quantity: fill.qty,
            feeEur: fill.commission,
          },
        ]
      })
      const ledgerMetrics = pythonLedger.ledger.metrics
      const record = {
        id,
        strategyId: typescriptResult.strategyId,
        strategyOwner: 'typescript-native',
        ledgerOwner: 'python-ledger',
        sizingModel: 'python-long-flat-ledger.v1',
        initialCashEur: ticket,
        finalEquityEur: ledgerMetrics.finalEquity,
        trades,
        candlesEvaluated: pythonLedger.inputWindow.barCount,
        sampleCount: 0,
        tradesCount: ledgerMetrics.tradeCount,
        rawSignalsCount: typescriptResult.rawSignalsCount,
        gateRejectionsCount: typescriptResult.gateRejectionsCount,
        winRatePct:
          ledgerMetrics.winRate === null ? null : ledgerMetrics.winRate * 100,
        profitFactor: ledgerMetrics.profitFactor,
        netPnlEur: ledgerMetrics.finalEquity - ticket,
        brierScoreMulticlass: null,
        baselineUniformBrier: 0.6667,
        baselineNoChangeBrier: null,
        executionTimeMs: performance.now() - started,
        feeScenario: typescriptResult.feeScenario,
        costCaveat: SIMULATED_COSTS_CAVEAT,
        comparator: {
          status: 'not_comparable',
          reason:
            'Python ledger consumes TypeScript-native strategy targets; this is not native Python strategy parity.',
        },
        pythonLedger,
        datasetHash,
        contentHash: '',
        window: bounds,
        artifact,
      }
      const contentHash = fastReplayHash({
        id,
        strategyId: typescriptResult.strategyId,
        bounds,
        datasetHash,
        pythonLedger,
        artifact,
      })
      const completeRecord = { ...record, contentHash }
      marketStore.saveFastReplayRun(
        id,
        {
          strategy_id: strategyId,
          start_time: bounds.start_time,
          end_time: bounds.end_time,
          ticket_eur: ticket,
          ledger_owner: 'python-ledger',
        },
        completeRecord,
        datasetHash,
        contentHash,
      )
      return reply.send(completeRecord)
    } catch (error) {
      if (error instanceof PythonLedgerUnavailableError)
        return reply.code(503).send({
          error: { code: 'python_runtime_unavailable', message: error.message },
        })
      if (error instanceof PythonLedgerTimeoutError)
        return reply.code(504).send({
          error: { code: 'python_runtime_timeout', message: error.message },
        })
      if (error instanceof PythonLedgerExecutionError)
        return reply.code(502).send({
          error: { code: 'python_replay_failed', message: error.message },
        })
      return reply.code(422).send({
        error: {
          code: 'python_ledger_invalid_dataset',
          message:
            error instanceof Error
              ? error.message
              : 'Python ledger could not process this dataset.',
        },
      })
    }
  })

  app.get('/api/replay/fast-run/history', (request, reply) => {
    const query = request.query as { limit?: unknown }
    const limit = query.limit === undefined ? 50 : Number(query.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'limit must be an integer from 1 to 200.',
        },
      })
    if (marketStore === undefined)
      return reply.code(503).send({
        error: {
          code: 'market_store_unavailable',
          message: 'Fast Replay history is unavailable.',
        },
      })
    const runs = marketStore.listFastReplayRuns(limit).flatMap((stored) => {
      if (!isRecord(stored) || !isRecord(stored.result)) return []
      const feeScenario = isCurrentFeeScenario(stored.result.feeScenario)
        ? KRAKEN_PRO_SPOT_TIER1_TAKER_FEE_SCENARIO
        : null
      const flat = {
        ...stored.result,
        artifactStatus:
          stored.artifactStatus === 'stored' ? 'stored' : 'unavailable',
        feeScenario,
        costCaveat:
          feeScenario === null
            ? 'Fee provenance is unknown for this historical run; recorded results are unchanged.'
            : SIMULATED_COSTS_CAVEAT,
        id: stored.id,
        request: stored.request,
        datasetHash: stored.datasetHash,
        contentHash: stored.contentHash,
        createdAt: stored.createdAt,
      }
      return isFastReplayHistoryRecord(flat) ? [flat] : []
    })
    return reply.send({ runs })
  })

  app.get('/api/replay/fast-run/history/:runId/artifact', (request, reply) => {
    if (marketStore === undefined)
      return reply.code(503).send({
        error: {
          code: 'market_store_unavailable',
          message: 'Fast Replay history is unavailable.',
        },
      })
    const { runId } = request.params as { runId: string }
    const stored = marketStore.getFastReplayRun(runId)
    if (!isRecord(stored) || !isRecord(stored.result))
      return reply.code(404).send({ artifactStatus: 'unavailable' })
    const artifact = stored.result.artifact
    if (!isRecord(artifact))
      return reply.code(404).send({ artifactStatus: 'unavailable' })
    if (
      artifact.schema !== 'fast-replay-artifact.v1' ||
      artifact.runId !== runId ||
      artifact.datasetHash !== stored.datasetHash ||
      !Array.isArray(artifact.candles) ||
      fastReplayHash({
        schema: 'fast-replay-candles.v1',
        columns: ['timestamp', 'open', 'high', 'low', 'close', 'volume'],
        candles: artifact.candles.map((value) =>
          isRecord(value)
            ? [
                value.timestamp,
                value.open,
                value.high,
                value.low,
                value.close,
                value.volume,
              ]
            : null,
        ),
      }) !== artifact.datasetHash
    )
      return reply.code(409).send({ artifactStatus: 'unverifiable' })
    return reply.send({ artifactStatus: 'verified', artifact })
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
    if (!config.krakenWsCollectorEnabled) {
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
    const body = request.body as { stage?: unknown; seed?: unknown } | undefined
    let sample: { stage: 'smoke' | 'confirm'; seed: number } | undefined
    if (body?.stage !== undefined || body?.seed !== undefined) {
      if (
        (body.stage !== 'smoke' && body.stage !== 'confirm') ||
        !Number.isSafeInteger(body.seed) ||
        (body.seed as number) < 0
      )
        return reply.code(400).send({
          error: {
            code: 'invalid_request',
            message:
              'Sample refresh requires stage smoke or confirm and a non-negative integer seed.',
          },
        })
      sample = { stage: body.stage, seed: body.seed as number }
    }
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
        ((requested) => refreshSimulations(config, requested))
      )(sample)
      return reply.send({ status: 'updated' })
    } catch (error) {
      const detail = error instanceof Error ? error.message : ''
      const insufficientWindow =
        /fewer than two hours of trades|latest contiguous Kraken window/i.test(
          detail,
        )
      return reply.code(422).send({
        error: {
          code: 'simulations_unavailable',
          message: insufficientWindow
            ? 'La ventana continua más reciente todavía no reúne 2 horas y 120 operaciones consecutivas. Los huecos reinician el tramo; esperá a que se acumulen datos continuos antes de actualizar.'
            : 'No se pudieron actualizar las simulaciones. Revisá el estado del servidor e intentá nuevamente.',
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

  app.get('/api/intelligence/simulations/history', (_request, reply) =>
    reply.send({
      reports: listSimulationReportHistory(config.simulationsReportPath),
    }),
  )
  app.get<{ Params: { id: string } }>(
    '/api/intelligence/simulations/history/:id',
    (request, reply) => {
      const raw = readSimulationReportHistoryDetail(
        config.simulationsReportPath,
        request.params.id,
      )
      if (raw === undefined)
        return reply.code(404).send({
          error: {
            code: 'simulation_report_missing',
            message: 'The requested simulation report was not found.',
          },
        })
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
    },
  )

  app.addHook('onReady', async () => {
    if (paperForward !== undefined) {
      paperForward.setStreamState(
        ohlcCollector === undefined ? 'disabled' : 'waiting_for_ohlc',
      )
      paperForward.setRunning(ohlcCollector !== undefined)
    }
    if (config.krakenWsCollectorEnabled) {
      ensureShadowRunExists()
      await marketCollector?.start('BTC-EUR')
      startForecastLoop()
    }
    if (config.krakenRestOhlcWorkerEnabled) ohlcCollector?.start()
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
    await ohlcCollector?.stop()
    paperForward?.setRunning(false)
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
