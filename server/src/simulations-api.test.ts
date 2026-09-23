import { describe, expect, it } from 'vitest'
import { buildApp } from './app/app.ts'
import { serverConfigFrom } from './platform/config.ts'

const GENERATE_COMMAND = 'pnpm --dir server simulations:run'

describe('GET /api/intelligence/simulations', () => {
  it('serves the latest persisted report without computing anything', async () => {
    const body = JSON.stringify({ version: 'simulations-comparison.v1' })
    const config = serverConfigFrom({})
    let reads = 0
    const app = await buildApp({
      config,
      overrides: {
        simulationsReportReader: () => {
          reads += 1
          return body
        },
      },
    })
    const response = await app.inject({
      method: 'GET',
      url: '/api/intelligence/simulations',
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(JSON.parse(body))
    expect(reads).toBe(1)
    await app.close()
  })

  it('returns an explicit empty state when no report exists', async () => {
    const config = serverConfigFrom({})
    const app = await buildApp({
      config,
      overrides: { simulationsReportReader: () => undefined },
    })
    const response = await app.inject({
      method: 'GET',
      url: '/api/intelligence/simulations',
    })
    expect(response.statusCode).toBe(404)
    const payload = response.json()
    expect(payload.error.code).toBe('simulations_report_missing')
    expect(payload.instrumentId).toBe('BTC-EUR')
    expect(payload.generateCommand).toBe(GENERATE_COMMAND)
    await app.close()
  })

  it('rejects instruments other than BTC-EUR', async () => {
    const config = serverConfigFrom({})
    const app = await buildApp({
      config,
      overrides: { simulationsReportReader: () => undefined },
    })
    const response = await app.inject({
      method: 'GET',
      url: '/api/intelligence/simulations?instrumentId=ETH-EUR',
    })
    expect(response.statusCode).toBe(400)
    await app.close()
  })
})

describe('POST /api/intelligence/simulations/refresh', () => {
  it('runs at most one refresh concurrently and leaves GET read-only', async () => {
    let finish!: () => void
    let calls = 0
    const app = await buildApp({
      config: serverConfigFrom({}),
      overrides: {
        simulationsReportReader: () => JSON.stringify({ reports: [] }),
        simulationsRefresher: async () => {
          calls++
          await new Promise<void>((resolve) => {
            finish = resolve
          })
        },
      },
    })
    const first = app.inject({
      method: 'POST',
      url: '/api/intelligence/simulations/refresh',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/intelligence/simulations/refresh',
    })
    expect(duplicate.statusCode).toBe(409)
    expect(calls).toBe(1)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/intelligence/simulations',
        })
      ).statusCode,
    ).toBe(200)
    finish()
    expect((await first).statusCode).toBe(200)
    await app.close()
  })

  it('rejects a cross-site browser request and preserves the last report on failure', async () => {
    const app = await buildApp({
      config: serverConfigFrom({}),
      overrides: {
        simulationsReportReader: () => JSON.stringify({ reports: [] }),
        simulationsRefresher: async () => {
          throw new Error('unresolved gap')
        },
      },
    })
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/intelligence/simulations/refresh',
      headers: { origin: 'https://evil.example' },
    })
    expect(forbidden.statusCode).toBe(403)
    const failed = await app.inject({
      method: 'POST',
      url: '/api/intelligence/simulations/refresh',
    })
    expect(failed.statusCode).toBe(422)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/intelligence/simulations',
        })
      ).statusCode,
    ).toBe(200)
    await app.close()
  })
})
