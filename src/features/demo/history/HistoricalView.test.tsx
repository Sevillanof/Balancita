import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import HistoricalView from './HistoricalView.tsx'
import type { HistoricalProvider, HistoricalRequest } from './types.ts'

describe('HistoricalView', () => {
  it('starts empty and submits an immutable parameter snapshot to its provider', async () => {
    const run = vi.fn().mockResolvedValue({
      parameters: {
        asset: 'BTC/EUR',
        from: '2026-08-01',
        to: '2026-09-30',
        interval: '15m',
        strategy: 'Ruptura + volumen',
        capital: 10000,
      },
      trades: [],
      equity: [{ date: '2026-08-01', value: 10000 }],
      finalCapital: 10000,
      drawdown: 0,
      winRate: 0,
    })
    const provider: HistoricalProvider = { run }
    render(<HistoricalView provider={provider} />)
    expect(screen.getByText('Sin resultados todavía')).toBeTruthy()
    fireEvent.click(
      screen.getByRole('button', { name: /ejecutar simulación/i }),
    )
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1))
    fireEvent.change(screen.getByLabelText('Capital inicial (EUR)'), {
      target: { value: '1234' },
    })
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      capital: 10000,
      asset: 'BTC/EUR',
    })
    expect(
      await screen.findByText(/Capital inicial: 10\.000,00 EUR/),
    ).toBeTruthy()
  })

  it('rejects reversed date ranges without calling the provider', () => {
    const run = vi.fn()
    render(<HistoricalView provider={{ run }} />)
    fireEvent.change(screen.getByLabelText('Desde'), {
      target: { value: '2026-10-01' },
    })
    fireEvent.click(
      screen.getByRole('button', { name: /ejecutar simulación/i }),
    )
    expect(screen.getByRole('alert').textContent).toMatch(/anterior o igual/i)
    expect(run).not.toHaveBeenCalled()
  })

  it('shows provider failures and restores the submit control', async () => {
    const run = vi.fn().mockRejectedValue(new Error('offline'))
    render(<HistoricalView provider={{ run }} />)
    fireEvent.click(
      screen.getByRole('button', { name: /ejecutar simulación/i }),
    )
    expect(await screen.findByRole('alert')).toBeTruthy()
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /ejecutar simulación/i }),
      ).toBeTruthy(),
    )
  })

  it('exposes loading state for an asynchronous provider and aborts on unmount', async () => {
    let signal: AbortSignal | undefined
    const run = vi.fn(
      (_request: Readonly<HistoricalRequest>, requestSignal: AbortSignal) => {
        signal = requestSignal
        return new Promise<never>(() => {})
      },
    )
    const { unmount } = render(<HistoricalView provider={{ run }} />)
    fireEvent.click(
      screen.getByRole('button', { name: /ejecutar simulación/i }),
    )
    expect(await screen.findByRole('status')).toHaveAttribute(
      'aria-busy',
      'true',
    )
    unmount()
    expect(signal?.aborted).toBe(true)
  })
})
