import { describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { serverConfigFrom } from './config.ts'

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
