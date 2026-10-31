// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { QuickFormula } from '../infrastructure/quick-api.ts'
import { useFormulaModel } from './formula-model.ts'

afterEach(cleanup)

it('draws authoritative paper fills and USD rather than compounding weighted bp again in the browser', () => {
  const formula: QuickFormula = {
    execution: 'terminal.v2',
    cuenta: 'entera',
    capital_inicial_usd: '1000',
    saldo_final_usd: '1010',
    fotos: 1,
    desde_ms: 0,
    hasta_ms: 7_200_000,
    max_horas: 36,
    nocional_usd: 1000,
    productos: ['PF_ETHUSD'],
    mercado: {
      PF_ETHUSD: [
        [0, 100],
        [7_200_000, 102],
      ],
    },
    formula: {
      n: 1,
      neto_bp: 100,
      ganadoras: 1,
      ic: [null, null],
      total_bp: 100,
      por_vuelta: 0,
      por_tiempo: 0,
      horas: 1,
    },
    curvas: {
      formula: [
        {
          producto: 'PF_ETHUSD',
          lado: 1,
          entrada_ms: 1000,
          salida_ms: 3_601_000,
          neto_bp: 100,
          motivo: 'formula',
          pnl_usd: '10',
          notional_usd: '999.500249875062',
          entrada_px: '100.03',
          salida_px: '101.03',
          funding_usd: '0.04',
          funding_status: 'complete',
        },
      ],
    },
  }
  const { result } = renderHook(() => useFormulaModel(formula, 'fija'))
  expect(result.current?.trades[0]?.pnl_usd).toBe(10)
  expect(result.current?.trades[0]?.entry_price).toBe('100.03')
  expect(result.current?.trades[0]?.notional_usd).toBe('999.500249875062')
  expect(result.current?.trades[0]?.funding_usd).toBe(0.04)
  expect(result.current?.accountUsd).toBe(1000)
})
