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
    expect(config.maxRequestsPerMinute).toBe(15)
    expect(config.maxRequestsPerDay).toBe(500)
    expect(config.cacheMaxEntries).toBe(100)
    expect(config.maxCandles).toBe(500)
    expect(config.corsOrigin).toBe('http://localhost:5173')
    expect(config.apiKey).toBe('')
  })

  it('parses numeric environment values and passes the key through', () => {
    const config = serverConfigFrom({
      GEMINI_API_KEY: 'secret-value',
      GEMINI_MODEL: 'gemini-3.8-flash',
      PORT: '9000',
      GEMINI_MAX_OUTPUT_TOKENS: '2048',
      GEMINI_TIMEOUT_MS: '3000',
      GEMINI_MAX_REQUESTS_PER_MINUTE: '20',
      GEMINI_MAX_REQUESTS_PER_DAY: '1000',
      GEMINI_CACHE_MAX_ENTRIES: '10',
      GEMINI_MAX_CANDLES: '120',
      GEMINI_SERVER_CORS_ORIGIN: 'http://localhost:4000',
    })
    expect(config.apiKey).toBe('secret-value')
    expect(config.model).toBe('gemini-3.8-flash')
    expect(config.port).toBe(9000)
    expect(config.maxOutputTokens).toBe(2048)
    expect(config.timeoutMs).toBe(3000)
    expect(config.maxRequestsPerMinute).toBe(20)
    expect(config.maxRequestsPerDay).toBe(1000)
    expect(config.cacheMaxEntries).toBe(10)
    expect(config.maxCandles).toBe(120)
    expect(config.corsOrigin).toBe('http://localhost:4000')
  })

  it('rejects non-numeric or out-of-range numeric values', () => {
    for (const env of [
      { PORT: 'not-a-port' },
      { GEMINI_MAX_OUTPUT_TOKENS: '0' },
      { GEMINI_TIMEOUT_MS: '-1' },
      { GEMINI_MAX_REQUESTS_PER_MINUTE: '0' },
      { GEMINI_MAX_REQUESTS_PER_DAY: 'abc' },
      { GEMINI_CACHE_MAX_ENTRIES: '-5' },
      { GEMINI_MAX_CANDLES: '1.5' },
    ]) {
      expect(() => serverConfigFrom(env)).toThrow(ServerConfigError)
    }
  })
})
