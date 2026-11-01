// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import TerminalOperationCard from './TerminalOperationCard.tsx'
import type { QwenTrade } from './useQwenTrades.ts'

const trade: QwenTrade = {
  product: 'PF_ETHUSD',
  tradeNo: 2,
  open: true,
  side: 'SHORT',
  entryMs: 1000,
  exitMs: null,
  entryPrice: 2241.6574077,
  exitPrice: null,
  netUsd: 10,
  feesUsd: 1,
  fundingUsd: 0.1,
  fundingComplete: true,
  markMs: 301_000,
  markPrice: 2218,
  closedBy: null,
  holdMin: null,
  notionalUsd: 1000,
  leverage: 1,
  marginUsd: 1000,
}
afterEach(cleanup)

describe('Terminal operation card', () => {
  it('shows frozen book receipts without claiming a real exchange fill', () => {
    render(
      <TerminalOperationCard
        compact
        trade={{
          ...trade,
          execution: {
            model: 'kraken-futures-book.v1',
            entry: {
              receiptId: 'a'.repeat(64),
              costModelHash: 'b'.repeat(64),
              feeKind: 'taker',
              price: 2241.6,
              quantity: 0.45,
              feeUsd: 0.5,
              feeRate: 0.0005,
              sourceUrl:
                'https://futures.kraken.com/derivatives/api/v3/orderbook?symbol=PF_ETHUSD',
              signalMs: 1000,
              decisionMs: 1100,
              requestedMs: 1100,
              receivedMs: 1200,
              serverMs: 1190,
              executedMs: 1300,
            },
            exit: null,
            mark: null,
            fundingReceiptId: null,
            error: null,
            exitPlan: null,
          },
        }}
        source={{ state: 'ok' }}
        nowMs={302_000}
        onFocus={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Datos y costes/ }))
    expect(screen.getByRole('dialog')).toHaveTextContent(
      'Libro público · simulación paper',
    )
    expect(screen.getByRole('dialog')).toHaveTextContent('Recibo de entrada')
    expect(screen.getByRole('dialog')).toHaveTextContent('300 ms')
  })

  it('keeps compact financial details available and closes them with Escape', () => {
    render(
      <TerminalOperationCard
        compact
        trade={{ ...trade, fundingComplete: false }}
        source={{ state: 'ok' }}
        nowMs={302_000}
        onFocus={vi.fn()}
      />,
    )
    expect(screen.getByTestId('operation-net')).toHaveClass('text-warn')
    fireEvent.click(screen.getByRole('button', { name: /Datos y costes/ }))
    expect(
      screen.getByRole('dialog', { name: 'Datos de la operación 2' }),
    ).toHaveTextContent('incompleto, provisional')
    expect(screen.getByRole('dialog')).toHaveTextContent('Apalancamiento')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('never labels a compact cached position confirmed after a source error', () => {
    render(
      <TerminalOperationCard
        compact
        trade={trade}
        source={{ state: 'error' }}
        nowMs={302_000}
        onFocus={vi.fn()}
      />,
    )
    expect(screen.getByText(/Último dato, sin confirmar/)).toBeTruthy()
    expect(screen.getByTestId('operation-net')).toHaveClass('text-ink-2')
  })
  it('does not fabricate a zero-minute duration when a closed record is missing its exit time', () => {
    render(
      <TerminalOperationCard
        trade={{ ...trade, open: false, exitMs: null }}
        source={{ state: 'ok' }}
        nowMs={301000}
        onFocus={vi.fn()}
      />,
    )
    expect(screen.getByText('No registrada')).toBeTruthy()
  })
  it('uses the actual entry and recorded net with independent direction and result colors', () => {
    const focus = vi.fn()
    render(
      <TerminalOperationCard
        trade={trade}
        source={{ state: 'ok' }}
        nowMs={302_000}
        onFocus={focus}
      />,
    )
    expect(screen.getByText(/SHORT/)).toHaveClass('text-short')
    expect(screen.getByTestId('operation-net')).toHaveClass('text-long')
    expect(screen.getByTestId('operation-entry')).toHaveTextContent('2241,66')
    expect(screen.getByText(/Marca UTC/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Centrar operación' }))
    expect(focus).toHaveBeenCalledOnce()
  })

  it('keeps a last-known position distinct from a confirmed open or flat account', () => {
    render(
      <TerminalOperationCard
        trade={trade}
        source={{ state: 'error' }}
        nowMs={302_000}
        onFocus={vi.fn()}
      />,
    )
    expect(screen.getByText(/Sin confirmar/)).toBeTruthy()
    expect(screen.getByTestId('operation-net')).not.toHaveClass('text-long')
    expect(screen.queryByText(/Sin posición abierta/)).toBeNull()
  })

  it('does not label an incomplete funding net definitive', () => {
    render(
      <TerminalOperationCard
        trade={{ ...trade, fundingComplete: false }}
        source={{ state: 'ok' }}
        nowMs={302_000}
        onFocus={vi.fn()}
      />,
    )
    expect(screen.getByText(/Funding incompleto/)).toBeTruthy()
    expect(screen.getByTestId('operation-net')).toHaveClass('text-warn')
  })
})
