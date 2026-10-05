import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FuturesStore } from './futures-store.js'
import {
  startLocalFuturesTerminal,
  type LocalTerminalHandle,
} from './futures-local-terminal.js'

describe('isolated local futures terminal', () => {
  let closeCurrent: (() => Promise<void>) | undefined
  let outputParent: string | undefined
  let currentGate: ReturnType<typeof createGate> | undefined

  async function shutdown() {
    for (const close of closers.splice(0)) close()
    currentGate?.releaseAll()
    await closeCurrent?.()
    closeCurrent = undefined
  }

  async function startGated(
    gate: ReturnType<typeof createGate>,
    extra: Partial<Parameters<typeof startLocalFuturesTerminal>[0]> = {},
  ) {
    const parent = mkdtempSync(join(tmpdir(), 'local-futures-terminal-ctl-'))
    outputParent = parent
    const terminal = await startLocalFuturesTerminal({
      port: 0,
      outputDirectory: resolve(parent, 'owned-output'),
      pacingMs: 1,
      wait: () => gate.wait(),
      ...extra,
    })
    closeCurrent = terminal.close
    currentGate = gate
    return terminal
  }

  afterEach(async () => {
    for (const close of closers.splice(0)) close()
    currentGate?.releaseAll()
    currentGate = undefined
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

  it('pauses entries in the MOCK run without stopping market, protection or fills', async () => {
    const gate = createGate([1])
    const terminal = await startGated(gate)
    const client = await openClient(terminal, terminal.runId)
    await gate.reached(1)
    const pauseResult = await client.command(
      terminal.runId,
      'pause-before-entry',
      1,
      'paper.pause',
    )
    expect(record(record(pauseResult.data.result).result).status).toBe(
      'committed',
    )
    gate.release(1)
    await client.completed(terminal.runId)
    expect(
      client.messages.filter((event) => event.type === 'order.updated'),
    ).toHaveLength(0)
    const entryAnalysis = analysisFor(client.messages, '-2-entry-selection')
    expect(record(entryAnalysis).reason_codes).toEqual(['entries_paused'])
    const pauseIndex = client.messages.indexOf(pauseResult)
    expect(
      client.messages
        .slice(pauseIndex)
        .filter((event) => event.type === 'market.updated').length,
    ).toBeGreaterThan(0)
    expect(lastRisk(client.messages, terminal.runId)).toMatchObject({
      user_paused: true,
      entry_paused: true,
    })
    await shutdown()
    const store = new FuturesStore(terminal.databasePath)
    try {
      expect(store.verifyRun(terminal.runId)).toBe(true)
      expect(store.loadPendingCommands()).toHaveLength(0)
    } finally {
      store.close()
    }
  }, 120_000)

  it('keeps protection and the close fill committing when paused after the partial fill', async () => {
    const gate = createGate([3])
    const terminal = await startGated(gate)
    const client = await openClient(terminal, terminal.runId)
    await gate.reached(3)
    await client.command(
      terminal.runId,
      'pause-after-partial',
      3,
      'paper.pause',
    )
    gate.release(3)
    await client.completed(terminal.runId)
    expect(
      client.messages.some(
        (event) =>
          event.type === 'order.updated' &&
          record(record(event.data).order).side === 'sell' &&
          record(record(event.data).order).quantity_btc === '0.005' &&
          record(record(event.data).order).status === 'filled',
      ),
    ).toBe(true)
    const lastPosition = [...client.messages]
      .reverse()
      .find((event) => event.type === 'position.updated')
    expect(record(record(lastPosition?.data).position).quantity_btc).toBe('0')
    expect(lastRisk(client.messages, terminal.runId)).toMatchObject({
      user_paused: true,
    })
    await shutdown()
    const store = new FuturesStore(terminal.databasePath)
    try {
      expect(store.verifyRun(terminal.runId)).toBe(true)
      expect(store.loadPendingCommands()).toHaveLength(0)
    } finally {
      store.close()
    }
  }, 120_000)

  for (const [label, stageIndex] of [
    ['warmup', 0],
    ['entry-selection', 1],
  ] as const)
    it(`applies a pause accepted while the ${label} stage is in flight`, async () => {
      const gate = createGate([])
      let releaseStage: (() => void) | undefined
      const stageHeld = new Promise<void>((resolveHeld) => {
        releaseStage = resolveHeld
      })
      let reachedStage: (() => void) | undefined
      const stageReached = new Promise<void>((resolveReached) => {
        reachedStage = resolveReached
      })
      const logs: string[] = []
      const terminal = await startGated(gate, {
        onLog: (line) => logs.push(line),
        onStageInFlight: async ({ index }) => {
          if (index !== stageIndex) return
          reachedStage?.()
          await stageHeld
        },
      })
      const client = await openClient(terminal, terminal.runId)
      await stageReached
      const pending = client.command(
        terminal.runId,
        `pause-in-flight-${label}`,
        stageIndex,
        'paper.pause',
      )
      await vi.waitFor(
        () =>
          expect(logs.some((line) => line.startsWith('Command deferred'))).toBe(
            true,
          ),
        { timeout: 10_000 },
      )
      releaseStage?.()
      const result = await pending
      expect(record(record(result.data.result).result).status).toBe('committed')
      await client.completed(terminal.runId)
      if (stageIndex === 0) {
        // Pause lands before any entry decision: no entry order may exist.
        expect(
          client.messages.filter((event) => event.type === 'order.updated'),
        ).toHaveLength(0)
        expect(
          record(analysisFor(client.messages, '-2-entry-selection'))
            .reason_codes,
        ).toEqual(['entries_paused'])
      } else {
        // The entry stage was already accepted by the engine when the pause
        // arrived, so its entry stands; the pause applies right after it and
        // protection and the close keep running.
        const lastPosition = [...client.messages]
          .reverse()
          .find((event) => event.type === 'position.updated')
        expect(record(record(lastPosition?.data).position).quantity_btc).toBe(
          '0',
        )
      }
      expect(lastRisk(client.messages, terminal.runId)).toMatchObject({
        user_paused: true,
      })
      await shutdown()
      const store = new FuturesStore(terminal.databasePath)
      try {
        expect(store.verifyRun(terminal.runId)).toBe(true)
        expect(store.loadPendingCommands()).toHaveLength(0)
      } finally {
        store.close()
      }
    }, 120_000)

  it('does not duplicate the reduction intent when paused between stop crossing and close', async () => {
    const gate = createGate([4])
    const terminal = await startGated(gate)
    const client = await openClient(terminal, terminal.runId)
    await gate.reached(4)
    await client.command(terminal.runId, 'pause-at-stop', 4, 'paper.pause')
    gate.release(4)
    await client.completed(terminal.runId)
    const reductionIds = new Set(
      client.messages
        .filter(
          (event) =>
            event.type === 'order.updated' &&
            record(record(event.data).order).order_type === 'reduce_only',
        )
        .map((event) => String(record(record(event.data).order).order_id)),
    )
    expect(reductionIds.size).toBe(1)
    const lastPosition = [...client.messages]
      .reverse()
      .find((event) => event.type === 'position.updated')
    expect(record(record(lastPosition?.data).position).quantity_btc).toBe('0')
    await shutdown()
    const store = new FuturesStore(terminal.databasePath)
    try {
      expect(store.verifyRun(terminal.runId)).toBe(true)
    } finally {
      store.close()
    }
  }, 120_000)

  it('resumes continues without duplicating effects', async () => {
    const gate = createGate([1])
    const terminal = await startGated(gate)
    const client = await openClient(terminal, terminal.runId)
    await gate.reached(1)
    await client.command(terminal.runId, 'pause-one', 1, 'paper.pause')
    const resumed = await client.command(
      terminal.runId,
      'resume-one',
      2,
      'paper.resume',
    )
    const distinctAnalyses = () =>
      new Set(
        client.messages
          .filter((event) => event.type === 'analysis.completed')
          .map((event) => event.event_id),
      ).size
    const analysesAfterResume = distinctAnalyses()
    const retried = await client.command(
      terminal.runId,
      'resume-one',
      2,
      'paper.resume',
    )
    expect(retried.event_id).toBe(resumed.event_id)
    expect(distinctAnalyses()).toBe(analysesAfterResume)
    await client.command(terminal.runId, 'resume-two', 3, 'paper.resume')
    gate.release(1)
    await client.completed(terminal.runId)
    expect(distinctAnalyses()).toBe(8)
    const ids = [
      ...new Set(
        client.messages
          .filter((event) => event.type === 'analysis.completed')
          .map((event) => String(record(event.data).work_id)),
      ),
    ]
    expect(ids).toHaveLength(8)
    const fills = client.messages.filter(
      (event) => event.type === 'fill.created',
    )
    const fillIds = fills.map((event) =>
      String(record(record(event.data).fill).fill_id),
    )
    expect(new Set(fillIds).size).toBe(fillIds.length)
    expect(lastRisk(client.messages, terminal.runId)).toMatchObject({
      user_paused: false,
    })
    const finalAccount = record(
      record(
        [...client.messages]
          .reverse()
          .find((event) => event.type === 'account.updated')?.data,
      ).account,
    )
    expect(finalAccount.equity_usd).toBe('9999.21014')
    await shutdown()
    const store = new FuturesStore(terminal.databasePath)
    try {
      expect(store.verifyRun(terminal.runId)).toBe(true)
    } finally {
      store.close()
    }
  }, 120_000)

  it('new run is isolated and replays the scenario', async () => {
    const gate = createGate([1])
    const terminal = await startGated(gate)
    const client = await openClient(terminal, terminal.runId)
    await gate.reached(1)
    await client.command(terminal.runId, 'parent-pause', 1, 'paper.pause')
    gate.release(1)
    await client.completed(terminal.runId)
    const parentOrders = client.messages.filter(
      (event) =>
        event.type === 'order.updated' && event.run_id === terminal.runId,
    )
    expect(parentOrders).toHaveLength(0)

    const result = await client.command(
      terminal.runId,
      'new-run-one',
      6,
      'paper.new_run',
    )
    const childRunId = String(result.data.child_run_id)
    expect(childRunId).not.toBe(terminal.runId)
    const childSnapshot = await client.next(
      (event) => event.type === 'snapshot' && event.run_id === childRunId,
    )
    const childState = record(record(childSnapshot.data).state)
    expect(record(childState.account).equity_usd).toBe('10000')
    expect(childState.position).toBeNull()
    expect(childState.orders).toEqual([])
    expect(childState.analyses).toHaveLength(1)
    const snapshotIndex = client.messages.indexOf(childSnapshot)
    await client.completed(childRunId)
    expect(
      client.messages
        .slice(snapshotIndex)
        .every((event) => event.run_id === childRunId),
    ).toBe(true)
    const childAnalyses = client.messages.filter(
      (event) =>
        event.type === 'analysis.completed' && event.run_id === childRunId,
    )
    expect(childAnalyses).toHaveLength(5)
    expect(childAnalyses.map((event) => String(event.data.work_id))).toContain(
      `${childRunId}-1-warmup`,
    )
    expect(
      client.messages.some(
        (event) =>
          event.run_id === childRunId &&
          event.type === 'order.updated' &&
          record(record(event.data).order).order_type === 'reduce_only',
      ),
    ).toBe(true)
    const childAccount = record(
      record(
        [...client.messages]
          .reverse()
          .find(
            (event) =>
              event.type === 'account.updated' && event.run_id === childRunId,
          )?.data,
      ).account,
    )
    expect(childAccount).toMatchObject({
      equity_usd: '9999.21014',
      fees_usd: '0.49986',
      realized_gross_usd: '-0.29',
    })
    expect(lastRisk(client.messages, childRunId)).toMatchObject({
      user_paused: false,
    })
    expect(lastRisk(client.messages, terminal.runId)).toMatchObject({
      user_paused: true,
    })

    const retry = await openClient(terminal, terminal.runId)
    const retried = await retry.command(
      terminal.runId,
      'new-run-one',
      6,
      'paper.new_run',
    )
    expect(retried.data.child_run_id).toBe(childRunId)
    await shutdown()
    const store = new FuturesStore(terminal.databasePath)
    try {
      expect(store.verifyRun(terminal.runId)).toBe(true)
      expect(store.verifyRun(childRunId)).toBe(true)
      expect(store.getRunMetadata(childRunId)).toMatchObject({
        parent_run_id: terminal.runId,
      })
      expect(store.getRunProjection(childRunId)?.state_version).toBe(6)
    } finally {
      store.close()
    }
  }, 120_000)

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

type Message = Record<string, unknown> & {
  type: string
  run_id: string
  data: Record<string, unknown>
  event_id: string
}

const closers: Array<() => void> = []

function createGate(held: number[]) {
  let calls = 0
  const reached = new Map<number, () => void>()
  const released = new Map<number, () => void>()
  const reachedPromises = new Map<number, Promise<void>>()
  const releasePromises = new Map<number, Promise<void>>()
  const ensure = (call: number) => {
    if (!reachedPromises.has(call)) {
      reachedPromises.set(
        call,
        new Promise<void>((resolveReached) =>
          reached.set(call, resolveReached),
        ),
      )
      releasePromises.set(
        call,
        new Promise<void>((resolveRelease) =>
          released.set(call, resolveRelease),
        ),
      )
    }
  }
  return {
    async wait(): Promise<void> {
      calls += 1
      ensure(calls)
      reached.get(calls)?.()
      if (held.includes(calls)) await releasePromises.get(calls)
    },
    reached(call: number): Promise<void> {
      ensure(call)
      return reachedPromises.get(call)!
    },
    release(call: number): void {
      ensure(call)
      released.get(call)?.()
    },
    releaseAll(): void {
      for (const call of held) this.release(call)
    },
  }
}

async function openClient(terminal: LocalTerminalHandle, runId: string) {
  const messages: Message[] = []
  const waiters: Array<{
    predicate: (message: Message) => boolean
    resolve: (message: Message) => void
  }> = []
  const socket = new WebSocket(
    `ws://127.0.0.1:${new URL(terminal.apiUrl).port}/api/terminal/stream`,
    { origin: 'http://127.0.0.1:5174' },
  )
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw)) as Message
    messages.push(message)
    for (const waiter of [...waiters])
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1)
        waiter.resolve(message)
      }
  })
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', () => resolveOpen())
    socket.once('error', rejectOpen)
  })
  const next = (predicate: (message: Message) => boolean, fromIndex = 0) => {
    const prior = messages.slice(fromIndex).find(predicate)
    if (prior) return Promise.resolve(prior)
    return new Promise<Message>((resolveNext, rejectNext) => {
      const timer = setTimeout(
        () =>
          rejectNext(
            new Error(
              `Timed out waiting for terminal message; statuses: ${messages
                .filter((message) => message.type === 'engine.status')
                .map((message) => String(record(message.data).message))
                .join(' | ')}`,
            ),
          ),
        30_000,
      )
      waiters.push({
        predicate,
        resolve: (message) => {
          clearTimeout(timer)
          resolveNext(message)
        },
      })
    })
  }
  const subscribe = async (target: string) => {
    socket.send(
      JSON.stringify({ schema_version: 1, type: 'subscribe', run_id: target }),
    )
    await next((m) => m.type === 'snapshot' && m.run_id === target)
  }
  await subscribe(runId)
  closers.push(() => socket.close())
  return {
    messages,
    next,
    async command(
      target: string,
      commandId: string,
      version: number,
      action: string,
    ): Promise<Message> {
      const start = messages.length
      socket.send(
        JSON.stringify({
          schema_version: 1,
          type: 'paper.command',
          run_id: target,
          command_id: commandId,
          expected_state_version: version,
          action,
        }),
      )
      return next(
        (m) =>
          (m.type === 'command.result' && m.data.command_id === commandId) ||
          (m.type === 'protocol.error' && m.data.code !== undefined),
        start,
      ).then((message) => {
        expect(message.type, JSON.stringify(message.data)).toBe(
          'command.result',
        )
        return message
      })
    },
    completed(target: string) {
      return next(
        (m) =>
          m.type === 'engine.status' &&
          m.run_id === target &&
          record(m.data).message === 'Escenario finalizado',
      )
    },
  }
}

function analysisFor(messages: Message[], suffix: string): unknown {
  return record(
    messages.find(
      (event) =>
        event.type === 'analysis.completed' &&
        String(event.data.work_id).endsWith(suffix),
    )?.data,
  ).analysis
}

function lastRisk(messages: Message[], runId: string): unknown {
  return record(
    [...messages]
      .reverse()
      .find(
        (event) =>
          event.type === 'engine.status' &&
          event.run_id === runId &&
          event.data.risk !== undefined,
      )?.data.risk,
  )
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}
