// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import TerminalDecisions from './TerminalDecisions.tsx'
import SelectedDecision from './SelectedDecision.tsx'
import { decisionView } from './terminal-decision-view.ts'

afterEach(cleanup)

describe('Qwen waits in the decisions list', () => {
  it('lists each wait with its time, reason and probabilities, never collapsed', () => {
    const wait = (id: string, time: string, reason: string) => ({
      id,
      action: 'WAIT',
      strategy: 'Qwen',
      reason,
      time,
      detail: 'Largo 46 % · Corto 20 % · Esperar 34 %',
      explained: true,
    })
    render(
      <TerminalDecisions
        rows={[
          wait('b', '10:15', 'Esperó porque vio más probable esperar (62 %).'),
          wait(
            'a',
            '10:00',
            'Quiso entrar LARGO con 46 %, no llegó al 50 % mínimo.',
          ),
        ]}
        selectedId="b"
        onSelect={() => {}}
      />,
    )
    expect(screen.queryByText(/WAIT ×/)).toBeNull()
    expect(screen.getByText('10:00')).toBeTruthy()
    expect(screen.getByText(/no llegó al 50 % mínimo/)).toBeTruthy()
    expect(screen.getByText(/vio más probable esperar \(62 %\)/)).toBeTruthy()
    expect(screen.getAllByText(/Largo 46 %/)).toHaveLength(2)
  })

  it('shows the probabilities of the selected decision', () => {
    render(
      <SelectedDecision
        analysis={{
          action: 'WAIT',
          selected_strategy_id: 'qwen',
          qwen_probabilities: 'Largo 46 % · Esperar 54 %',
        }}
        id="qwen:PF_XBTUSD:0"
        time="10:00"
        reason="Esperó porque no vio ventaja clara."
      />,
    )
    expect(screen.getByTestId('qwen-probabilities').textContent).toContain(
      'Largo 46 %',
    )
  })

  it('paints formula rows as badge and chips, folding quiet runs into one line', () => {
    const quiet = (id: string, time: string) => ({
      id,
      action: 'WAIT',
      strategy: 'Qwen',
      reason: 'x',
      time,
      view: decisionView({
        formula_action: 'MANTENER',
        formula: { maestro: 2, portero_si: true },
        model_action: 'MANTENER',
        opinion_agrees: 1,
      }),
    })
    const entry = {
      id: 'e',
      action: 'LONG',
      strategy: 'Qwen',
      reason: 'x',
      time: '10:30',
      explained: true,
      view: decisionView({
        action: 'LONG',
        formula_action: 'LARGO',
        formula: { maestro: 2, portero_si: true },
        model_action: 'CORTO',
        p_action: 0.55,
        opinion_agrees: 0,
      }),
    }
    render(
      <TerminalDecisions
        rows={[entry, quiet('b', '10:15'), quiet('a', '10:00')]}
        selectedId="e"
        onSelect={() => {}}
      />,
    )
    expect(screen.getByText('Entra largo')).toBeTruthy()
    expect(screen.getByText(/Portero/)).toBeTruthy()
    expect(screen.getByText(/Qwen ▼ corto 55 % ≠/)).toBeTruthy()
    expect(screen.getByText(/Mantiene ×2/)).toBeTruthy()
  })
})
