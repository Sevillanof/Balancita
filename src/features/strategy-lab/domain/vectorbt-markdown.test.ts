import { describe, expect, it } from 'vitest'
import { explorationMarkdown } from './vectorbt-markdown.ts'
import {
  exampleReport,
  exploration,
  variantsReport,
} from '../testing/vectorbt-fixture.ts'

/* DATOS DE EJEMPLO: inventados solo para estas pruebas. */
describe('explorationMarkdown', () => {
  it('arma el diagnóstico con totales, qué funciona, qué falla y tablas', () => {
    const md = explorationMarkdown(exploration(), 4)
    expect(md).toContain('# Reporte de VectorBT: X2 Ejemplo')
    expect(md).toContain('## Qué funciona')
    expect(md).toContain('- Los cierres por objetivo ganan +70 pb en promedio.')
    expect(md).toContain('## Qué falla')
    expect(md).toContain('| Producto | Operaciones |')
    expect(md).toContain('PF_XBTUSD')
    expect(md).toContain('| Salida | Operaciones |')
    expect(md).toContain('Objetivo')
    expect(md).not.toMatch(/NaN|undefined|null/)
  })

  it('incluye el ranking, el contador de intentos y los valores con error', () => {
    const md = explorationMarkdown(
      exploration({ mode: 'variants', report: variantsReport() }),
      7,
    )
    expect(md).toContain('## Ranking de variantes')
    expect(md).toContain('Llevás 7 intentos')
    expect(md).toContain('(la actual)')
    expect(md).toContain('No se pudo probar: valor no admitido')
    expect(md).not.toMatch(/NaN|undefined|null/)
  })

  it('explica cuando VectorBT no puede reproducir la estrategia', () => {
    const md = explorationMarkdown(
      exploration({
        report: exampleReport({
          status: 'unsupported',
          diagnostic: null,
          unsupported: { reason: 'usa señales que no reproduce' },
        }),
      }),
      null,
    )
    expect(md).toContain('usa señales que no reproduce')
    expect(md).not.toContain('## Totales')
  })

  it('devuelve vacío si todavía no hay reporte', () => {
    expect(explorationMarkdown(exploration({ report: null }), null)).toBe('')
  })
})
