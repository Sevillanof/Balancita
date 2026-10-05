import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { startLocalFuturesTerminal } from './futures-local-terminal.js'

describe('isolated local futures terminal', () => {
  let closeCurrent: (() => Promise<void>) | undefined
  let outputParent: string | undefined

  afterEach(async () => {
    await closeCurrent?.()
    closeCurrent = undefined
    if (outputParent) rmSync(outputParent, { recursive: true, force: true })
    outputParent = undefined
  })

  it('streams actual worker receipts, market candles, account transitions and completion', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'local-futures-terminal-test-'))
    outputParent = parent
    const terminal = await startLocalFuturesTerminal({
      port: 0,
      outputDirectory: resolve(parent, 'owned-output'),
      pacingMs: 0,
    })
    closeCurrent = terminal.close
    const response = await fetch(`${terminal.apiUrl}/api/terminal/bootstrap`)
    const responseBody = await response.text()
    expect(response.status, responseBody).toBe(200)
    const bootstrap = JSON.parse(responseBody) as Record<string, unknown>
    expect(bootstrap).toMatchObject({
      mode: 'mock',
      source: 'local-protection.v1',
      active_run_id: terminal.runId,
      engine: { scenario_status: 'Escenario iniciado' },
    })

    const events: Record<string, unknown>[] = []
    const completed = new Promise<void>((resolveComplete, rejectComplete) => {
      const timeout = setTimeout(
        () =>
          rejectComplete(
            new Error('Timed out waiting for scenario completion'),
          ),
        15_000,
      )
      const socket = new WebSocket(
        `ws://127.0.0.1:${new URL(terminal.apiUrl).port}/api/terminal/stream`,
        { origin: 'http://127.0.0.1:5174' },
      )
      socket.on('open', () =>
        socket.send(
          JSON.stringify({
            schema_version: 1,
            type: 'subscribe',
            run_id: terminal.runId,
          }),
        ),
      )
      socket.on('message', (raw) => {
        const event = JSON.parse(String(raw)) as Record<string, unknown>
        events.push(event)
        if (event.type === 'snapshot')
          socket.send(
            JSON.stringify({
              schema_version: 1,
              type: 'paper.command',
              run_id: terminal.runId,
              command_id: 'read-only-attempt',
              expected_state_version: 0,
              action: 'paper.start',
            }),
          )
        if (event.type === 'protocol.error')
          expect(record(event.data).code).toBe('request_failed')
        if (
          event.type === 'engine.status' &&
          record(event.data).message === 'Escenario finalizado'
        ) {
          clearTimeout(timeout)
          socket.close()
          resolveComplete()
        }
      })
      socket.on('error', (error) => {
        clearTimeout(timeout)
        rejectComplete(error)
      })
    })
    await completed

    expect(events[0]?.type).toBe('snapshot')
    expect(
      events.some(
        (event) =>
          event.type === 'protocol.error' &&
          record(event.data).code === 'request_failed',
      ),
    ).toBe(true)
    const sequenceNumbers = events
      .map((event) => Number(event.seq))
      .filter(Number.isSafeInteger)
    expect(sequenceNumbers).toEqual(
      [...sequenceNumbers].sort((left, right) => left - right),
    )
    expect(events.some((event) => event.type === 'market.updated')).toBe(true)
    expect(events.some((event) => event.type === 'analysis.completed')).toBe(
      true,
    )
    const decisions = events.filter(
      (event) => event.type === 'analysis.completed',
    )
    expect(decisions).toHaveLength(5)
    const decisionWorkIds = decisions.map((event) =>
      String(record(event.data).work_id),
    )
    expect(new Set(decisionWorkIds).size).toBe(5)
    for (const decision of decisions) {
      const data = record(decision.data)
      const analysis = record(data.analysis)
      expect(data.analysis_id).toBe(data.work_id)
      expect(analysis.analysis_id).toBe(data.work_id)
      expect(analysis.runtime_version).toBe('futures-runtime-risk.v1')
    }
    expect(events.some((event) => event.type === 'order.updated')).toBe(true)
    const partialFill = events.find(
      (event) =>
        event.type === 'fill.created' &&
        record(record(event.data).fill).quantity_btc === '0.005',
    )
    expect(partialFill).toBeTruthy()
    expect(
      events.some(
        (event) =>
          event.type === 'position.updated' &&
          record(record(event.data).position).quantity_btc === '0',
      ),
    ).toBe(true)
    const finalAccountEvent = [...events]
      .reverse()
      .find((event) => event.type === 'account.updated')
    const finalAccount = record(record(finalAccountEvent).data).account
    expect(finalAccount).toMatchObject({
      equity_usd: '9999.21014',
      fees_usd: '0.49986',
      realized_gross_usd: '-0.29',
      funding_paid: '0',
      net_complete: '-0.78986',
    })
    const completedBootstrap = (await (
      await fetch(`${terminal.apiUrl}/api/terminal/bootstrap`)
    ).json()) as Record<string, unknown>
    expect(record(completedBootstrap.engine).scenario_status).toBe(
      'Escenario finalizado',
    )
    expect(
      (record(completedBootstrap.terminal_market).candles as unknown[]).length,
    ).toBeGreaterThan(0)
    expect(
      record(
        (record(completedBootstrap.terminal_market).candles as unknown[]).at(
          -1,
        ),
      ).close,
    ).toBe('100000')

    const resumed = await new Promise<Record<string, unknown>>(
      (resolveSnapshot, rejectSnapshot) => {
        const socket = new WebSocket(
          `ws://127.0.0.1:${new URL(terminal.apiUrl).port}/api/terminal/stream`,
          { origin: 'http://127.0.0.1:5174' },
        )
        const timeout = setTimeout(
          () =>
            rejectSnapshot(
              new Error('Timed out waiting for reconnect snapshot'),
            ),
          2_000,
        )
        socket.on('open', () =>
          socket.send(
            JSON.stringify({
              schema_version: 1,
              type: 'subscribe',
              run_id: terminal.runId,
            }),
          ),
        )
        socket.on('message', (raw) => {
          const event = JSON.parse(String(raw)) as Record<string, unknown>
          if (event.type !== 'snapshot') return
          clearTimeout(timeout)
          socket.close()
          resolveSnapshot(event)
        })
        socket.on('error', rejectSnapshot)
      },
    )
    const resumedData = record(resumed.data)
    const resumedState = record(resumedData.state)
    expect(record(resumedState.account)).toMatchObject({
      equity_usd: '9999.21014',
      net_usd: '-0.78986',
    })
    expect(resumedState.position).toBeNull()
    expect(resumedState.analyses).toHaveLength(5)
    const protectiveClose = (
      resumedState.orders as Record<string, unknown>[]
    ).find((order) => order.side === 'sell' && order.quantity_btc === '0.005')
    expect(protectiveClose).toMatchObject({
      state: 'filled',
      status: 'filled',
      filled_quantity_btc: '0.005',
      remaining_quantity_btc: '0',
    })
    expect(
      events.some((event) => {
        if (event.type !== 'order.updated') return false
        const order = record(record(event.data).order)
        return (
          order.side === 'sell' &&
          order.quantity_btc === '0.005' &&
          order.status === 'filled' &&
          order.filled_quantity_btc === '0.005' &&
          order.remaining_quantity_btc === '0'
        )
      }),
    ).toBe(true)
    expect(resumedData.watermark).toBe(Math.max(...sequenceNumbers))
  })

  it('refuses a reused output directory without modifying it', async () => {
    const parent = mkdtempSync(
      join(tmpdir(), 'local-futures-terminal-refusal-'),
    )
    const output = join(parent, 'existing')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(output)
    await expect(
      startLocalFuturesTerminal({ port: 0, outputDirectory: output }),
    ).rejects.toThrow('Refusing existing terminal output path')
    rmSync(parent, { recursive: true, force: true })
  })
})

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
