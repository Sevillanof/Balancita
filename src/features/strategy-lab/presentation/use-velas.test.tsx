import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  ConsultaVelas,
  RespuestaVelas,
} from '../infrastructure/estrategias-api.ts'
import { fakeApi, velasFalsas } from '../testing/estrategias-fixture.ts'
import { useVelas } from './use-velas.ts'

const H = 3_600_000
const VENTANA = {
  desdeMs: Date.UTC(2026, 1, 3),
  hastaMs: Date.UTC(2026, 3, 19),
}

describe('useVelas', () => {
  it('asks for the last ten days of the tested window first, in ascending order', async () => {
    const api = fakeApi()
    const { result } = renderHook(() => useVelas(api, VENTANA, '1h'))
    expect(result.current.cargando).toBe(true)
    await waitFor(() => expect(result.current.cargando).toBe(false))
    expect(api.velas).toHaveBeenCalledWith({
      producto: 'PF_ETHUSD',
      intervalo: '1h',
      desdeMs: VENTANA.desdeMs,
      hastaMs: VENTANA.hastaMs,
      antesMs: VENTANA.hastaMs,
      limite: 240,
    })
    const { velas } = result.current
    expect(velas).toHaveLength(240)
    expect(velas.at(-1)!.t).toBe(VENTANA.hastaMs - H)
    expect(velas.map((v) => v.t)).toEqual([...velas.map((v) => v.t)].sort())
    expect(result.current.hayMas).toBe(true)
  })

  it('scrolling back asks for the page before the oldest candle held and merges it without gaps or repeats', async () => {
    const api = fakeApi()
    const { result } = renderHook(() => useVelas(api, VENTANA, '1h'))
    await waitFor(() => expect(result.current.cargando).toBe(false))
    const primera = result.current.velas[0]!.t
    act(() => result.current.cargarAnteriores())
    await waitFor(() => expect(api.velas).toHaveBeenCalledTimes(2))
    expect(api.velas).toHaveBeenLastCalledWith(
      expect.objectContaining({ antesMs: primera, limite: 500 }),
    )
    await waitFor(() => expect(result.current.velas).toHaveLength(740))
    const tiempos = result.current.velas.map((v) => v.t)
    expect(new Set(tiempos).size).toBe(740)
    expect(tiempos.every((t, i) => i === 0 || t - tiempos[i - 1]! === H)).toBe(
      true,
    )
  })

  it('does not ask twice at once and stops when the window start is reached', async () => {
    const api = fakeApi()
    const corta = {
      desdeMs: VENTANA.hastaMs - 12 * 24 * H,
      hastaMs: VENTANA.hastaMs,
    }
    const { result } = renderHook(() => useVelas(api, corta, '1h'))
    await waitFor(() => expect(result.current.cargando).toBe(false))
    act(() => {
      result.current.cargarAnteriores()
      result.current.cargarAnteriores()
    })
    await waitFor(() => expect(result.current.hayMas).toBe(false))
    expect(api.velas).toHaveBeenCalledTimes(2)
    expect(result.current.velas[0]!.t).toBe(corta.desdeMs)
    act(() => result.current.cargarAnteriores())
    expect(api.velas).toHaveBeenCalledTimes(2)
  })

  it('never keeps a candle outside the tested window even if the server sends one', async () => {
    const api = fakeApi(
      [],
      {},
      {
        velas: vi.fn(
          async (consulta: ConsultaVelas): Promise<RespuestaVelas> => {
            const real = velasFalsas(consulta)
            const vela = real.velas[0]!
            return {
              ...real,
              velas: [
                { ...vela, t: VENTANA.desdeMs - H },
                ...real.velas,
                { ...vela, t: VENTANA.hastaMs },
                { ...vela, t: VENTANA.hastaMs + 5 * H },
              ],
            }
          },
        ),
      },
    )
    const { result } = renderHook(() => useVelas(api, VENTANA, '1h'))
    await waitFor(() => expect(result.current.cargando).toBe(false))
    expect(result.current.velas).toHaveLength(240)
    expect(
      result.current.velas.every(
        (v) => v.t >= VENTANA.desdeMs && v.t < VENTANA.hastaMs,
      ),
    ).toBe(true)
  })

  it('starts over on another interval and drops the answer of the old one', async () => {
    let soltar: (() => void) | null = null
    const api = fakeApi(
      [],
      {},
      {
        velas: vi.fn(async (consulta: ConsultaVelas) => {
          if (consulta.intervalo === '1h')
            await new Promise<void>((listo) => (soltar = listo))
          return velasFalsas(consulta)
        }),
      },
    )
    const { result, rerender } = renderHook(
      ({ intervalo }) => useVelas(api, VENTANA, intervalo),
      { initialProps: { intervalo: '1h' as const } },
    )
    rerender({ intervalo: '4h' as unknown as '1h' })
    await waitFor(() => expect(result.current.velas).toHaveLength(60))
    expect(api.velas).toHaveBeenLastCalledWith(
      expect.objectContaining({ intervalo: '4h', limite: 60 }),
    )
    await act(async () => soltar?.())
    expect(result.current.velas).toHaveLength(60)
    expect(result.current.velas.at(-1)!.t).toBe(VENTANA.hastaMs - 4 * H)
  })

  it('reports a failure and keeps what it had', async () => {
    const api = fakeApi(
      [],
      {},
      {
        velas: vi.fn(async () => {
          throw new Error('No hay velas guardadas de PF_ETHUSD.')
        }),
      },
    )
    const { result } = renderHook(() => useVelas(api, VENTANA, '1d'))
    await waitFor(() =>
      expect(result.current.error).toBe('No hay velas guardadas de PF_ETHUSD.'),
    )
    expect(result.current).toMatchObject({
      cargando: false,
      velas: [],
      hayMas: false,
    })
  })
})
