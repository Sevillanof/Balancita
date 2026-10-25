// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import TerminalDecisions from './TerminalDecisions.tsx'
import SelectedDecision from './SelectedDecision.tsx'

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
})
