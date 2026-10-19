import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ActivationDialog, DeleteDialog, PurgeNotice } from './LifecycleDialogs.tsx'
import { VersionsTab } from './StrategyLabPanels.tsx'
import type { DeletePreview } from '../infrastructure/strategy-api.ts'
import type { StrategyDetail } from '../infrastructure/strategy-api.ts'

const preview: DeletePreview = {
  id: 'c29-momentum-perp-v1',
  name: 'C29 Momentum',
  state: 'draft',
  versions: [{ version: 1, state: 'draft' }],
  active_ms: 0,
  created_at: 1_790_000_000_000,
  forward_trades: 0,
  forward_net_usd: 0,
  gate_runs: 3,
  exam: { taken: true, verdict: 'NO PASA', date: '2026-10-10' },
  ledger_kept: true,
  warnings: [],
  blocked: false,
}

describe('ActivationDialog', () => {
  it('warns when the version did not pass and lets the user go on anyway', async () => {
    const onConfirm = vi.fn()
    render(
      <ActivationDialog name="C29" passed={false} busy={false} onConfirm={onConfirm} onClose={() => undefined} />,
    )
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Esta versión no pasó la prueba. ¿Activarla igual en el paper real?',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Activar igual' }))
    expect(onConfirm).toHaveBeenCalled()
  })
  it('does not warn when the version passed', () => {
    render(
      <ActivationDialog name="C29" passed busy={false} onConfirm={() => undefined} onClose={() => undefined} />,
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button', { name: 'Activar' })).toBeEnabled()
  })
})

describe('DeleteDialog', () => {
  it('shows what goes away and needs the typed name', async () => {
    const onConfirm = vi.fn()
    render(<DeleteDialog preview={preview} busy={false} onConfirm={onConfirm} onClose={() => undefined} />)
    expect(screen.getByText('nunca estuvo activa')).toBeInTheDocument()
    expect(screen.getByText('rendido el 2026-10-10: NO PASA')).toBeInTheDocument()
    expect(screen.getByText(/operaciones de paper ya registradas se conservan/)).toBeInTheDocument()
    const button = screen.getByRole('button', { name: 'Borrar definitivamente' })
    expect(button).toBeDisabled()
    await userEvent.type(screen.getByLabelText('Escribí el nombre para confirmar'), 'C29 Momentum')
    await userEvent.click(button)
    expect(onConfirm).toHaveBeenCalledWith('C29 Momentum')
  })
  it('cannot be confirmed while Qwen still needs the strategy', async () => {
    render(<DeleteDialog preview={{ ...preview, blocked: true }} busy={false} onConfirm={() => undefined} onClose={() => undefined} />)
    await userEvent.type(screen.getByLabelText('Escribí el nombre para confirmar'), 'C29 Momentum')
    expect(screen.getByRole('button', { name: 'Borrar definitivamente' })).toBeDisabled()
  })
})

describe('PurgeNotice', () => {
  it('says borrando while a process is pending and listo afterwards', () => {
    const { rerender } = render(
      <PurgeNotice name="C29" status={{ purge_id: 'x', state: 'running', consumers: { forward: 'pending' } }} />,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Borrando C29… Falta: medición en paper.')
    rerender(<PurgeNotice name="C29" status={{ purge_id: 'x', state: 'done', consumers: { forward: 'done' } }} />)
    expect(screen.getByRole('status')).toHaveTextContent('Listo: C29 se borró por completo.')
  })
})

describe('VersionsTab', () => {
  const detail = (id: string) =>
    ({ id, name: id, version: 1, state: 'draft', versions: [{ version: 1, state: 'draft', parent: null }] }) as unknown as StrategyDetail
  it('hides Borrar for Qwen and Kronos', () => {
    for (const id of ['kronos-small-1h-h4-v1', 'c31-qwen-exit-perp-v1']) {
      const { unmount } = render(
        <VersionsTab detail={detail(id)} busy={false} onState={() => undefined} onRequestActivate={() => undefined} onRequestDelete={() => undefined} />,
      )
      expect(screen.queryByRole('button', { name: 'Borrar' })).toBeNull()
      unmount()
    }
    render(
      <VersionsTab detail={detail('c29-x')} busy={false} onState={() => undefined} onRequestActivate={() => undefined} onRequestDelete={() => undefined} />,
    )
    expect(screen.getByRole('button', { name: 'Borrar' })).toBeInTheDocument()
  })
})
