import { describe, expect, it } from 'vitest'
import {
  estadoVariante,
  segundosCorriendo,
  segundosTardados,
} from './estrategias-estado.ts'
import {
  EJEMPLO,
  INFORME,
  VIEJA,
  trabajo,
  trabajoListo,
} from '../testing/estrategias-fixture.ts'

const conNeto = (neto: number | null) =>
  trabajoListo({
    informe: {
      ...INFORME,
      diferencia: { ...INFORME.diferencia, neto_usd: neto },
    },
  })

describe('status of a variant', () => {
  it.each([
    [undefined, 'Cargando…', 'neutral'],
    [null, 'Sin probar', 'neutral'],
    [trabajo(), 'Probando…', 'info'],
    [trabajo({ estado: 'error', error: 'x' }), 'Falló', 'warn'],
    [conNeto(-44.07), 'Peor que la oficial', 'short'],
    [conNeto(12.5), 'Mejor que la oficial', 'long'],
    [conNeto(0), 'Igual que la oficial', 'neutral'],
  ] as const)('%#: %s', (job, texto, tono) => {
    expect(estadoVariante(EJEMPLO, job)).toMatchObject({ texto, tono })
  })

  it('a variant the server cannot use is not tried whatever its last job says', () => {
    expect(estadoVariante(VIEJA, conNeto(5))).toMatchObject({
      texto: 'No se puede probar',
      tono: 'warn',
    })
  })

  it('measures seconds, and refuses clocks that disagree by more than an hour', () => {
    const job = trabajo({ iniciado_ms: 10_000 })
    expect(segundosCorriendo(job, 22_000)).toBe(12)
    expect(segundosCorriendo(job, 5_000)).toBeNull()
    expect(segundosCorriendo(job, 10_000 + 3_600_000)).toBeNull()
    expect(segundosTardados(trabajoListo())).toBe(22)
    expect(segundosTardados(trabajo())).toBeNull()
  })
})
