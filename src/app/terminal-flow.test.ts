import { describe, expect, it } from 'vitest'
import { flowStatus, STALE_QUOTE_MS } from './terminal-flow.ts'

const running = { capture: { status: 'running' }, live: { status: 'running' } }

describe('flowStatus', () => {
  it('is conectado when the stream is open, all processes run and the quote is fresh', () => {
    expect(
      flowStatus({ connected: true, processes: running, quoteAgeMs: 2_000 }),
    ).toMatchObject({ level: 'ok', label: 'FLUJO CONECTADO', reasons: [] })
  })

  it('is desconectado without the WebSocket, whatever else says', () => {
    expect(
      flowStatus({ connected: false, processes: running, quoteAgeMs: 0 }),
    ).toMatchObject({ level: 'bad', label: 'FLUJO DESCONECTADO' })
  })

  it('has problemas when a process is down or restarting', () => {
    const status = flowStatus({
      connected: true,
      processes: {
        ...running,
        q: { status: 'restarting' },
        news: { status: 'down' },
      },
      quoteAgeMs: 1_000,
    })
    expect(status.label).toBe('FLUJO CON PROBLEMAS')
    expect(status.reasons).toEqual([
      'Proceso q: reiniciando',
      'Proceso news: caído',
    ])
  })

  it('has problemas with a stale or missing quote or without health', () => {
    expect(
      flowStatus({
        connected: true,
        processes: running,
        quoteAgeMs: STALE_QUOTE_MS + 1,
      }).level,
    ).toBe('warn')
    expect(
      flowStatus({ connected: true, processes: running, quoteAgeMs: null })
        .level,
    ).toBe('warn')
    expect(
      flowStatus({ connected: true, processes: null, quoteAgeMs: 0 }).level,
    ).toBe('warn')
  })
})
