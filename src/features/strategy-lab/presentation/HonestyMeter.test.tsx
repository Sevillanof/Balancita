import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { HonestyMeter as Meter } from '../infrastructure/quick-api.ts'
import HonestyMeter from './HonestyMeter.tsx'

const meter = (over: Partial<Meter> = {}): Meter => ({
  semaforo: 'rojo',
  motivo:
    'Con 1.751 intentos, la probabilidad de que no sea suerte es de 31 %.',
  intentos: 1751,
  fuera_del_ajuste_pct: 100,
  practica_usada: true,
  incluye_practica: true,
  practica: { desde: '2025-10-16', hasta: '2026-04-19' },
  holdout_intacto: true,
  holdout_desde: '2026-04-19',
  prob_no_es_suerte: 0.31,
  medicion: 'honesta',
  ...over,
})

describe('HonestyMeter', () => {
  it('shows the light, the reason in one line and the four numbers behind it', () => {
    render(<HonestyMeter meter={meter()} />)
    const box = screen.getByTestId('honestidad')
    expect(box).toHaveAttribute('data-semaforo', 'rojo')
    expect(box).toHaveTextContent('Rojo')
    expect(box).toHaveTextContent('1.751 intentos')
    expect(box).toHaveTextContent('1.751 (cada prueba nueva suma)')
    expect(box).toHaveTextContent('100 %')
    expect(box).toHaveTextContent('ya usado para elegir reglas')
    expect(box).toHaveTextContent('este resultado lo incluye')
    expect(box).toHaveTextContent('intacto')
    expect(box).toHaveTextContent('31 % de probabilidad de que no sea suerte')
  })
  it('says when the result comes from a previous test and when the holdout was touched', () => {
    render(
      <HonestyMeter
        meter={meter({ semaforo: 'amarillo', holdout_intacto: false })}
        stale
      />,
    )
    expect(screen.getByTestId('honestidad')).toHaveTextContent(
      '(resultado anterior)',
    )
    expect(screen.getByTestId('honestidad')).toHaveTextContent('TOCADO')
  })
  it('explains the paper-formula measurement and a green light', () => {
    render(
      <HonestyMeter
        meter={meter({
          semaforo: 'verde',
          medicion: 'vigente',
          fuera_del_ajuste_pct: 62.5,
          practica_usada: false,
          incluye_practica: false,
          prob_no_es_suerte: null,
        })}
      />,
    )
    const box = screen.getByTestId('honestidad')
    expect(box).toHaveAttribute('data-semaforo', 'verde')
    expect(box).toHaveTextContent('62,5 %')
    expect(box).toHaveTextContent(
      'lo anterior a sep-2025 estaba dentro del ajuste',
    )
    expect(box).toHaveTextContent('sin operaciones suficientes')
  })
  it('shows a note for a result made before the meter, and nothing without a result', () => {
    const { rerender } = render(<HonestyMeter meter={null} missing />)
    expect(screen.getByTestId('honestidad-sin-medidor')).toBeInTheDocument()
    rerender(<HonestyMeter meter={null} />)
    expect(screen.queryByTestId('honestidad')).toBeNull()
    expect(screen.queryByTestId('honestidad-sin-medidor')).toBeNull()
  })
})
