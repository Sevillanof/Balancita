// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import LifecycleSteps from './LifecycleSteps.tsx'
import { rowSteps } from './row-steps.ts'
import { lifecycleView } from '../../../app/terminal-lifecycle.ts'
import type { QwenTrade } from '../../../app/useQwenTrades.ts'

const HOUR = 3_600_000
// 1 nov 2026, 14:00 UTC = 15:00 in Madrid (CET, UTC+1 since 25 oct).
const NOW = Date.UTC(2026, 10, 1, 14, 0)

const look = (
  at: number,
  action: string,
  formula: Record<string, unknown>,
) => ({
  analysis_id: `qwen:PF_ETHUSD:${at}`,
  decision_time_ms: at,
  formula_action: action,
  formula,
})

const open = (over: Partial<QwenTrade> = {}): QwenTrade =>
  ({
    product: 'PF_ETHUSD',
    tradeNo: 2,
    open: true,
    side: 'SHORT',
    entryMs: NOW - 5 * HOUR,
    ...over,
  }) as QwenTrade

/** A look that also carries the rebound expert, so every exit step exists. */
const formula = {
  maestro: -2,
  puntaje: -0.4,
  rebote: { activo: true, caida_pct: 1, umbral_pct: 5, nivel: 0 },
}

const exitView = () =>
  lifecycleView({
    analyses: [look(NOW, 'MANTENER', formula)],
    openTrade: open(),
    nowMs: NOW,
    trades: [open()],
  })!

afterEach(cleanup)

describe('the SALIR row: only the steps that decide', () => {
  it('holds the maestro turning, the 24 h check, the 36 h cap and the auditor', () => {
    const view = exitView()
    // The full view still carries every step (the other screens read them).
    expect(view.steps.map((step) => step.id)).toContain('news12')
    expect(rowSteps(view).map((step) => step.id)).toEqual([
      'flip',
      'exhaust24',
      'cap',
      'auditor',
    ])
    render(<LifecycleSteps view={view} />)
    const group = screen.getByRole('group', {
      name: 'Pasos para salir de la operación',
    })
    const names = within(group)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label') ?? '')
    expect(names).toHaveLength(4)
    for (const gone of [
      'Noticia 12 h',
      'Salida maker',
      'Experto rebotes',
      'Emergencia',
    ])
      expect(names.some((name) => name.startsWith(gone))).toBe(false)
  })

  it('dims the steps that are not active now and leaves the active ones bright', () => {
    render(<LifecycleSteps view={exitView()} />)
    const button = (name: RegExp) => screen.getByRole('button', { name })
    // 5 h open: the 24 h check does not rule yet.
    expect(button(/^24 h sin fuerza/)).toHaveClass('opacity-50')
    expect(button(/^24 h sin fuerza/)).toHaveAttribute('data-tone', 'na')
    expect(button(/^Maestro gira/)).not.toHaveClass('opacity-50')
    expect(button(/^Tope 36 h/)).not.toHaveClass('opacity-50')
  })

  it('explains what and why in a tooltip on hover or focus, not in a native title', () => {
    render(<LifecycleSteps view={exitView()} />)
    const step = screen.getByRole('button', { name: /^24 h sin fuerza/ })
    expect(step).not.toHaveAttribute('title')
    fireEvent.mouseEnter(step)
    const tip = screen.getByRole('tooltip')
    expect(tip).toHaveTextContent('24 h sin fuerza')
    expect(tip).toHaveTextContent('Rige en 19,0 h')
    expect(tip).toHaveTextContent(
      'Pasadas 24 h, cierra si el maestro dejó de estar a favor.',
    )
    fireEvent.mouseLeave(step)
    expect(screen.queryByRole('tooltip')).toBeNull()
    fireEvent.focus(step)
    expect(screen.getByRole('tooltip')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

describe('the ENTRAR row and the dropdowns', () => {
  const entryView = () =>
    lifecycleView({
      analyses: [look(NOW, 'ESPERAR', { ...formula, maestro: 0 })],
      openTrade: null,
      nowMs: NOW,
      trades: [],
    })!

  it('keeps every entry step and dims those with nothing to say', () => {
    const view = entryView()
    expect(rowSteps(view)).toHaveLength(view.steps.length)
    render(<LifecycleSteps view={view} />)
    const group = screen.getByRole('group', {
      name: 'Pasos para entrar a una operación',
    })
    const dim = within(group)
      .getAllByRole('button')
      .filter((button) => button.className.includes('opacity-50'))
    expect(dim.length).toBeGreaterThan(0)
    for (const button of dim) expect(button).toHaveAttribute('data-tone', 'na')
  })

  it('replaces the paragraphs of the dropdown with an icon and one short line, the rule going to a tooltip', () => {
    render(<LifecycleSteps view={exitView()} />)
    fireEvent.click(screen.getByRole('button', { name: /^Maestro gira/ }))
    const dialog = screen.getByRole('dialog', {
      name: /Maestro gira: última evaluación/,
    })
    // The rule sentence is no longer a paragraph of the dropdown…
    expect(dialog).not.toHaveTextContent(
      'Cierra cuando el maestro se da vuelta en contra',
    )
    // …but it is on the info icon, with the Madrid hour of the look (14:00 UTC = 15:00 CET).
    expect(dialog).toHaveTextContent('15:00')
    expect(dialog.textContent).not.toMatch(/UTC/)
    fireEvent.mouseEnter(
      within(dialog).getByRole('img', { name: 'Regla del paso' }),
    )
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      'Cierra cuando el maestro se da vuelta en contra',
    )
  })
})
