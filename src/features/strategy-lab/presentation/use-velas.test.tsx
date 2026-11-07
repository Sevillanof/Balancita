import { renderHook, waitFor } from '@testing-library/react'
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
const MEDIO = Date.UTC(2026, 2, 10)
const RANGO = { desdeMs: MEDIO - 60 * H, hastaMs: MEDIO + 60 * H }

describe('useVelas', () => {
  it('asks once for the stretch around the trade, inside the tested window, in ascending order', async () => {
    const api = fakeApi()
    const { result } = renderHook(() => useVelas(api, VENTANA, '1h', RANGO))
    expect(result.current.cargando).toBe(true)
    await waitFor(() => expect(result.current.cargando).toBe(false))
    expect(api.velas).toHaveBeenCalledTimes(1)
    expect(api.velas).toHaveBeenCalledWith({
      producto: 'PF_ETHUSD',
      intervalo: '1h',
      desdeMs: VENTANA.desdeMs,
      hastaMs: VENTANA.hastaMs,
      antesMs: RANGO.hastaMs,
      limite: 121,
    })
    const { velas } = result.current
    expect(velas).toHaveLength(121)
    expect(velas[0]!.t).toBe(RANGO.desdeMs - H)
    expect(velas.at(-1)!.t).toBe(RANGO.hastaMs - H)
    expect(velas.map((v) => v.t)).toEqual([...velas.map((v) => v.t)].sort())
  })

  it('never reaches past the end of the window: the cursor is cut to it (the reserve starts there)', async () => {
    const api = fakeApi()
    const alFinal = {
      desdeMs: VENTANA.hastaMs - 50 * H,
      hastaMs: VENTANA.hastaMs + 30 * H,
    }
    const { result } = renderHook(() => useVelas(api, VENTANA, '1h', alFinal))
    await waitFor(() => expect(result.current.cargando).toBe(false))
    expect(api.velas).toHaveBeenCalledWith(
      expect.objectContaining({ antesMs: VENTANA.hastaMs, limite: 51 }),
    )
    expect(result.current.velas.at(-1)!.t).toBe(VENTANA.hastaMs - H)
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
    const { result } = renderHook(() => useVelas(api, VENTANA, '1h', RANGO))
    await waitFor(() => expect(result.current.cargando).toBe(false))
    expect(result.current.velas).toHaveLength(121)
    expect(
      result.current.velas.every(
        (v) => v.t >= VENTANA.desdeMs && v.t < VENTANA.hastaMs,
      ),
    ).toBe(true)
  })

  it('starts over on another interval or stretch and drops the answer of the old one', async () => {
    const control = { soltar: null as null | (() => void) }
    const api = fakeApi(
      [],
      {},
      {
        velas: vi.fn(async (consulta: ConsultaVelas) => {
          if (consulta.intervalo === '1h')
            await new Promise<void>((listo) => (control.soltar = listo))
          return velasFalsas(consulta)
        }),
      },
    )
    const { result, rerender } = renderHook(
      ({ intervalo }: { intervalo: '1h' | '4h' }) =>
        useVelas(api, VENTANA, intervalo, RANGO),
      { initialProps: { intervalo: '1h' as '1h' | '4h' } },
    )
    rerender({ intervalo: '4h' })
    expect(result.current).toMatchObject({ cargando: true, velas: [] })
    await waitFor(() => expect(result.current.velas).toHaveLength(31))
    expect(api.velas).toHaveBeenLastCalledWith(
      expect.objectContaining({ intervalo: '4h', limite: 31 }),
    )
    control.soltar?.()
    await new Promise((listo) => setTimeout(listo, 10))
    expect(result.current.velas).toHaveLength(31)
    expect(result.current.velas.at(-1)!.t).toBe(
      Math.floor((RANGO.hastaMs - 1) / (4 * H)) * 4 * H,
    )
  })

  it('asks again for another stretch (another trade)', async () => {
    const api = fakeApi()
    const otro = { desdeMs: MEDIO + 10 * H, hastaMs: MEDIO + 130 * H }
    const { result, rerender } = renderHook(
      ({ rango }) => useVelas(api, VENTANA, '1h', rango),
      { initialProps: { rango: RANGO } },
    )
    await waitFor(() => expect(result.current.cargando).toBe(false))
    rerender({ rango: otro })
    expect(result.current.cargando).toBe(true)
    await waitFor(() => expect(result.current.cargando).toBe(false))
    expect(api.velas).toHaveBeenCalledTimes(2)
    expect(api.velas).toHaveBeenLastCalledWith(
      expect.objectContaining({ antesMs: otro.hastaMs }),
    )
  })

  it('reports a failure with no candles', async () => {
    const api = fakeApi(
      [],
      {},
      {
        velas: vi.fn(async () => {
          throw new Error('No hay velas guardadas de PF_ETHUSD.')
        }),
      },
    )
    const { result } = renderHook(() => useVelas(api, VENTANA, '1d', RANGO))
    await waitFor(() =>
      expect(result.current.error).toBe('No hay velas guardadas de PF_ETHUSD.'),
    )
    expect(result.current).toMatchObject({ cargando: false, velas: [] })
  })

  it('asks for nothing without a stretch', async () => {
    const api = fakeApi()
    const { result } = renderHook(() => useVelas(api, VENTANA, '1h', null))
    expect(result.current).toMatchObject({
      cargando: false,
      velas: [],
      error: null,
    })
    expect(api.velas).not.toHaveBeenCalled()
  })
})
