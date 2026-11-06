import { describe, expect, it, vi } from 'vitest'
import {
  EstrategiasApiError,
  connectEstrategiasApi,
  httpEstrategiasApi,
} from './estrategias-api.ts'

const reply = (status: number, body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }))

describe('Terminal laboratory client', () => {
  it('lists with GET /estrategias', async () => {
    const fetcher = reply(200, { estrategias: [] })
    await httpEstrategiasApi('/x', fetcher).listar()
    expect(fetcher).toHaveBeenCalledWith(
      '/x/estrategias',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('creates and compares with POST and a JSON body; the comparison body only has the window', async () => {
    const fetcher = reply(200, { id: 'a' })
    const api = httpEstrategiasApi('/x', fetcher)
    await api.crear({
      nombre: 'A',
      descripcion: 'b',
      cambios: { analista: { modo: 'suave' } },
    })
    await api.comparar('mi-id', { desde: '2026-02-01', hasta: '2026-04-19' })
    const [crear, comparar] = fetcher.mock.calls as unknown as Array<
      [string, RequestInit]
    >
    expect(crear[0]).toBe('/x/estrategias')
    expect(crear[1].method).toBe('POST')
    expect(JSON.parse(String(crear[1].body))).toEqual({
      nombre: 'A',
      descripcion: 'b',
      cambios: { analista: { modo: 'suave' } },
    })
    expect(comparar[0]).toBe('/x/estrategias/mi-id/comparar')
    expect(JSON.parse(String(comparar[1].body))).toEqual({
      desde: '2026-02-01',
      hasta: '2026-04-19',
    })
  })

  it('follows a job by its id', async () => {
    const fetcher = reply(200, { job_id: 'j1' })
    await httpEstrategiasApi('/x', fetcher).trabajo('mi-id', 'j1')
    expect(fetcher).toHaveBeenCalledWith(
      '/x/estrategias/mi-id/comparar/j1',
      expect.anything(),
    )
  })

  it('turns the server refusal into an error with its detail and code', async () => {
    const api = httpEstrategiasApi(
      '/x',
      reply(409, { error: 'estrategia_existe', detail: 'Ya existe.' }),
    )
    await expect(
      api.crear({ nombre: 'A', descripcion: 'b', cambios: {} }),
    ).rejects.toMatchObject({
      message: 'Ya existe.',
      status: 409,
      code: 'estrategia_existe',
    })
  })

  it('latest comparison: 404 means none yet, other failures surface', async () => {
    expect(
      await httpEstrategiasApi(
        '/x',
        reply(404, { error: 'sin_comparacion', detail: 'x' }),
      ).ultimo('a'),
    ).toBeNull()
    await expect(
      httpEstrategiasApi('/x', reply(500, {})).ultimo('a'),
    ).rejects.toBeInstanceOf(EstrategiasApiError)
  })

  it('connects through the registry health probe', async () => {
    await expect(
      connectEstrategiasApi(reply(200, { status: 'ok' })),
    ).resolves.toBeDefined()
    await expect(connectEstrategiasApi(reply(503, {}))).rejects.toThrow(
      'HTTP 503',
    )
  })
})
