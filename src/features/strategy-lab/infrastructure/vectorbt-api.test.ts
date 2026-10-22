import { afterEach, describe, expect, it, vi } from 'vitest'
import { VectorbtError, vectorbtApi } from './vectorbt-api.ts'
import { comparison, vbtState } from '../testing/vectorbt-fixture.ts'

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

afterEach(() => vi.unstubAllGlobals())

describe('vectorbtApi', () => {
  it('reads the state of a strategy', async () => {
    const fetcher = vi.fn(async () => reply(200, vbtState()))
    vi.stubGlobal('fetch', fetcher)
    const state = await vectorbtApi.status('c27-breakout-perp-v1')
    expect(state.available).toBe(true)
    expect(fetcher).toHaveBeenCalledWith(
      '/api-strategies/strategies/c27-breakout-perp-v1/vectorbt',
    )
  })

  it('launches a diagnostic and a variants exploration with the real body', async () => {
    const fetcher = vi.fn(async () =>
      reply(200, { exploration_id: 'e1', pid: 7 }),
    )
    vi.stubGlobal('fetch', fetcher)
    await vectorbtApi.launch('x2', { mode: 'diagnostic' })
    await vectorbtApi.launch('x2', {
      mode: 'variants',
      vary: 'stop_atr',
      values: ['1', '2'],
    })
    const [url, init] = fetcher.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ]
    expect(url).toBe('/api-strategies/strategies/x2/vectorbt')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      mode: 'variants',
      vary: 'stop_atr',
      values: ['1', '2'],
    })
    const first = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(first[1].body as string)).toEqual({ mode: 'diagnostic' })
  })

  it('cancels, confirms and compares through the exploration routes', async () => {
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      void init
      if (url.includes('/compare')) return reply(200, comparison())
      if (url.endsWith('/confirm'))
        return reply(200, {
          strategy_id: 'x2-v2',
          version: 1,
          title: 'T',
          state: 'draft',
          already: false,
        })
      return reply(200, { exploration_id: 'e1', cancel_requested: true })
    })
    vi.stubGlobal('fetch', fetcher)
    await vectorbtApi.cancel('x2', 'e 1')
    expect(fetcher.mock.calls[0]![0]).toBe(
      '/api-strategies/strategies/x2/vectorbt/e%201/cancel',
    )
    const made = await vectorbtApi.confirm('x2', 'e1', '2.5')
    expect(made.strategy_id).toBe('x2-v2')
    const confirmInit = fetcher.mock.calls[1]![1] as unknown as RequestInit
    expect(JSON.parse(confirmInit.body as string)).toEqual({ value: '2.5' })
    await vectorbtApi.compare('x2', 'e1', '2.5', 12)
    expect(fetcher.mock.calls[2]![0]).toBe(
      '/api-strategies/strategies/x2/vectorbt/e1/compare?value=2.5&run_id=12',
    )
    await vectorbtApi.compare('x2', 'e1', '2')
    expect(fetcher.mock.calls[3]![0]).toBe(
      '/api-strategies/strategies/x2/vectorbt/e1/compare?value=2',
    )
  })

  it('turns the server errors into a VectorbtError with the Spanish detail and code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply(409, {
          error: 'busy',
          detail: 'Ya hay una exploración en curso.',
        }),
      ),
    )
    const error = await vectorbtApi
      .launch('x2', { mode: 'diagnostic' })
      .catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(VectorbtError)
    expect(error).toMatchObject({
      code: 'busy',
      status: 409,
      message: 'Ya hay una exploración en curso.',
    })
  })

  it('has a plain message when the body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 502 })),
    )
    await expect(vectorbtApi.status('x2')).rejects.toThrow(
      'El registro respondió 502.',
    )
  })
})
