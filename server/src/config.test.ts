import { describe, expect, it } from 'vitest'
import { ServerConfigError, serverConfigFrom } from './config.ts'

describe('serverConfigFrom', () => {
  it('applies the free-tier defaults when nothing is provided', () => {
    const config = serverConfigFrom({})
    expect(config.model).toBe('gemini-3.5-flash-lite')
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(8787)
    expect(config.timeoutMs).toBe(15_000)
    expect(config.maxOutputTokens).toBe(1024)
    expect(config.maxRequestsPerMinute).toBe(10)
    expect(config.maxRequestsPerDay).toBe(300)
    expect(config.cacheMaxEntries).toBe(100)
    expect(config.cacheTtlMs).toBe(300_000)
    expect(config.maxCandles).toBe(500)
    expect(config.corsOrigin).toBe('http://localhost:5173')
    expect(config.apiKey).toBe('')
    expect(config.marketCollectorEnabled).toBe(false)
    expect(config.forecastLoopEnabled).toBe(false)
    expect(config.forecastLoopIntervalMs).toBe(60_000)
    expect(config.newsPollingEnabled).toBe(false)
    expect(config.newsPollIntervalMs).toBe(300_000)
    expect(config.newsStaleAfterMs).toBe(900_000)
    expect(config.newsUserAgent).toBe('Balancita/1.0')
    expect(config.marketDbPath).toBe('./data/market.sqlite')
    expect(config.krakenWsUrl).toBe('wss://ws.kraken.com/v2')
    expect(config.krakenRestUrl).toBe('https://api.kraken.com/0')
    expect(config.marketStaleAfterMs).toBe(15_000)
    expect(config.marketReconnectMinMs).toBe(1_000)
    expect(config.marketReconnectMaxMs).toBe(30_000)
    expect(config.intelligenceStreamMaxClients).toBe(20)
    expect(config.intelligenceStreamKeepAliveMs).toBe(15_000)
    expect(config.intelligenceStreamWindowSize).toBe(200)
    expect(config.shadowRunId).toBe('shadow:BTC-EUR')
  })

  it('parses numeric environment values without requiring a key in tests', () => {
    const config = serverConfigFrom({
      GEMINI_MODEL: 'gemini-3.8-flash',
      PORT: '9000',
      GEMINI_MAX_OUTPUT_TOKENS: '2048',
      GEMINI_TIMEOUT_MS: '3000',
      GEMINI_MAX_REQUESTS_PER_MINUTE: '20',
      GEMINI_MAX_REQUESTS_PER_DAY: '1000',
      GEMINI_CACHE_MAX_ENTRIES: '10',
      GEMINI_CACHE_TTL_MS: '60000',
      GEMINI_MAX_CANDLES: '120',
      GEMINI_SERVER_CORS_ORIGIN: 'http://localhost:4000',
      MARKET_COLLECTOR_ENABLED: 'true',
      FORECAST_LOOP_ENABLED: 'true',
      FORECAST_LOOP_INTERVAL_MS: '15000',
      NEWS_POLLING_ENABLED: 'true',
      NEWS_POLL_INTERVAL_MS: '45000',
      NEWS_STALE_AFTER_MS: '180000',
      NEWS_USER_AGENT: 'Balancita/test',
      MARKET_DB_PATH: '/tmp/balancita-market.sqlite',
      KRAKEN_WS_URL: 'wss://kraken.example.invalid/v2',
      KRAKEN_REST_URL: 'https://kraken.example.invalid/0',
      MARKET_STALE_AFTER_MS: '5000',
      MARKET_RECONNECT_MIN_MS: '250',
      MARKET_RECONNECT_MAX_MS: '10000',
      INTELLIGENCE_SSE_MAX_CLIENTS: '4',
      INTELLIGENCE_SSE_KEEPALIVE_MS: '2000',
      INTELLIGENCE_SSE_WINDOW_SIZE: '50',
      SHADOW_RUN_ID: 'shadow:BTC-EUR:kraken-1',
    })
    expect(config.apiKey).toBe('')
    expect(config.model).toBe('gemini-3.8-flash')
    expect(config.port).toBe(9000)
    expect(config.maxOutputTokens).toBe(2048)
    expect(config.timeoutMs).toBe(3000)
    expect(config.maxRequestsPerMinute).toBe(20)
    expect(config.maxRequestsPerDay).toBe(1000)
    expect(config.cacheMaxEntries).toBe(10)
    expect(config.cacheTtlMs).toBe(60000)
    expect(config.maxCandles).toBe(120)
    expect(config.corsOrigin).toBe('http://localhost:4000')
    expect(config.marketCollectorEnabled).toBe(true)
    expect(config.forecastLoopEnabled).toBe(true)
    expect(config.forecastLoopIntervalMs).toBe(15_000)
    expect(config.newsPollingEnabled).toBe(true)
    expect(config.newsPollIntervalMs).toBe(45_000)
    expect(config.newsStaleAfterMs).toBe(180_000)
    expect(config.newsUserAgent).toBe('Balancita/test')
    expect(config.marketDbPath).toBe('/tmp/balancita-market.sqlite')
    expect(config.krakenWsUrl).toBe('wss://kraken.example.invalid/v2')
    expect(config.krakenRestUrl).toBe('https://kraken.example.invalid/0')
    expect(config.marketStaleAfterMs).toBe(5000)
    expect(config.marketReconnectMinMs).toBe(250)
    expect(config.marketReconnectMaxMs).toBe(10_000)
    expect(config.intelligenceStreamMaxClients).toBe(4)
    expect(config.intelligenceStreamKeepAliveMs).toBe(2_000)
    expect(config.intelligenceStreamWindowSize).toBe(50)
    expect(config.shadowRunId).toBe('shadow:BTC-EUR:kraken-1')
  })

  it('rejects non-numeric or out-of-range numeric values', () => {
    for (const env of [
      { PORT: 'not-a-port' },
      { GEMINI_MAX_OUTPUT_TOKENS: '0' },
      { GEMINI_TIMEOUT_MS: '-1' },
      { GEMINI_MAX_REQUESTS_PER_MINUTE: '0' },
      { GEMINI_MAX_REQUESTS_PER_DAY: 'abc' },
      { GEMINI_CACHE_MAX_ENTRIES: '-5' },
      { GEMINI_CACHE_TTL_MS: '0' },
      { GEMINI_MAX_CANDLES: '1.5' },
      { MARKET_COLLECTOR_ENABLED: 'maybe' },
      { FORECAST_LOOP_ENABLED: 'maybe' },
      { FORECAST_LOOP_INTERVAL_MS: '0' },
      { NEWS_POLL_INTERVAL_MS: '0' },
      { NEWS_STALE_AFTER_MS: '-1' },
      { NEWS_POLLING_ENABLED: 'maybe' },
      { MARKET_STALE_AFTER_MS: '0' },
      { MARKET_RECONNECT_MIN_MS: '0' },
      { MARKET_RECONNECT_MAX_MS: '-1' },
      { MARKET_RECONNECT_MIN_MS: '5000', MARKET_RECONNECT_MAX_MS: '1000' },
      { INTELLIGENCE_SSE_MAX_CLIENTS: '0' },
      { INTELLIGENCE_SSE_KEEPALIVE_MS: '-1' },
      { INTELLIGENCE_SSE_WINDOW_SIZE: '1.5' },
    ]) {
      expect(() => serverConfigFrom(env)).toThrow(ServerConfigError)
    }
  })
})
