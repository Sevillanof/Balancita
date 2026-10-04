import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Fastify from 'fastify'
import WebSocket from 'ws'
import { afterEach, describe, expect, it } from 'vitest'
import { FuturesCommandRunner } from '../paper-futures/futures-command-runner.ts'
import type { FuturesWorkerRequest } from '../paper-futures/futures-worker.ts'
import { canonicalHash } from '../paper-futures/futures-canonical.ts'
import { FuturesStore } from '../paper-futures/futures-store.ts'
import {
  registerTerminalStream,
  type TerminalWorkerRequestFactory,
} from './terminal-stream.ts'

const directories: string[] = []
const clients: WebSocket[] = []
const servers: Array<{
  app: Awaited<ReturnType<typeof Fastify>>
  runner: FuturesCommandRunner
  store: FuturesStore
}> = []

type TerminalTestMessage = {
  readonly type: string
  readonly run_id?: string
  readonly seq?: unknown
  readonly event_id?: unknown
  readonly stream_id?: string
  readonly data: Record<string, unknown>
}

afterEach(async () => {
  for (const client of clients.splice(0))
    if (client.readyState !== WebSocket.CLOSED) client.close()
  for (const server of servers.splice(0)) {
    await server.app.close()
    await server.runner.close()
    server.store.close()
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

describe('ordered paper terminal WebSocket transport', () => {
  it('uses the durable Python runtime for paper start/close and replays the committed ordered stream after restart', async () => {
    const fixture = runtimeFixture()
    const runId = 'terminal-ws-runtime-run'
    let pair = await startServer(runId, fixture)
    const first = connect(pair.url)
    const second = connect(pair.url)
    await Promise.all([first.open, second.open])
    first.socket.send(
      JSON.stringify({ schema_version: 1, type: 'subscribe', run_id: runId }),
    )
    second.socket.send(
      JSON.stringify({ schema_version: 1, type: 'subscribe', run_id: runId }),
    )
    const [firstSnapshot, secondSnapshot] = await Promise.all([
      first.next((message) => message.type === 'snapshot'),
      second.next((message) => message.type === 'snapshot'),
    ])
    expect(firstSnapshot.seq).toBe(0)
    expect(secondSnapshot).toMatchObject({
      stream_id: firstSnapshot.stream_id,
      seq: 0,
    })

    first.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-open-001',
        run_id: runId,
        expected_state_version: 0,
        action: 'paper.start',
      }),
    )
    const accepted = await first.next(
      (message) => message.type === 'command.ack',
    )
    expect(accepted.data).toMatchObject({
      command_id: 'terminal-open-001',
      status: 'accepted',
    })
    const openMessages = await collectCommandEvents(first, 'terminal-open-001')
    const duplicateOpenMessages = await collectCommandEvents(
      second,
      'terminal-open-001',
    )
    expect(openMessages.map((message) => message.type)).toEqual([
      'analysis.completed',
      'order.updated',
      'fill.created',
      'position.updated',
      'account.updated',
      'command.result',
    ])
    expect(duplicateOpenMessages.map((message) => message.event_id)).toEqual(
      openMessages.map((message) => message.event_id),
    )
    expect(pair.store.getRunProjection(runId)?.state_version).toBe(1)
    expect(
      (
        pair.store.getRunProjection(runId)?.checkpoint as Record<
          string,
          unknown
        >
      ).schema_version,
    ).toBeDefined()

    const openWatermark = pair.store.listTerminalEvents(runId, {
      afterSeq: 0,
      limit: 100,
    }).lastSeq
    second.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-open-001',
        run_id: runId,
        expected_state_version: 0,
        action: 'paper.start',
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(
      pair.store.listTerminalEvents(runId, { afterSeq: 0, limit: 100 }).lastSeq,
    ).toBe(openWatermark)
    second.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-open-001',
        run_id: runId,
        expected_state_version: 0,
        action: 'paper.close',
      }),
    )
    const conflict = await second.next(
      (message) =>
        message.type === 'protocol.error' &&
        message.data.code === 'command_id_conflict',
    )
    expect(conflict.data.code).toBe('command_id_conflict')

    first.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-close-001',
        run_id: runId,
        expected_state_version: 1,
        action: 'paper.close',
      }),
    )
    await first.next(
      (message) =>
        message.type === 'command.ack' &&
        message.data.command_id === 'terminal-close-001',
    )
    const closeMessages = await collectCommandEvents(
      first,
      'terminal-close-001',
    )
    expect(
      closeMessages.some((message) => message.type === 'fill.created'),
    ).toBe(true)
    expect(
      (
        pair.store.getRunProjection(runId)?.checkpoint as Record<
          string,
          unknown
        >
      ).ledger_position,
    ).toBeNull()

    const history = connect(pair.url)
    await history.open
    history.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'history.request',
        run_id: runId,
        before_seq: Number.MAX_SAFE_INTEGER,
        limit: 100,
      }),
    )
    const page = await history.next(
      (message) => message.type === 'history.page',
    )
    const pageEvents = page.data.events as Record<string, unknown>[]
    expect(pageEvents.map((event) => event.event_id)).toEqual(
      pair.store
        .listTerminalEvents(runId, {
          beforeSeq: Number.MAX_SAFE_INTEGER,
          limit: 100,
        })
        .events.map((event) => event.event_id),
    )

    const lastSeq = Number(closeMessages.at(-1)?.seq)
    const allIds = pageEvents.map((event) => event.event_id)
    const oldPair = pair
    for (const client of [first.socket, second.socket, history.socket])
      client.close()
    await oldPair.app.close()
    await oldPair.runner.close()
    oldPair.store.close()
    servers.splice(servers.indexOf(oldPair), 1)
    pair = await startServer(runId, fixture, oldPair.databasePath)

    const resumed = connect(pair.url)
    await resumed.open
    resumed.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'resume',
        run_id: runId,
        last_seq: 0,
      }),
    )
    const replayed = await collectUntilSeq(resumed, lastSeq)
    expect(replayed.map((message) => message.event_id)).toEqual(allIds)
    expect(new Set(replayed.map((message) => message.event_id)).size).toBe(
      allIds.length,
    )
    expect(pair.store.getRunProjection(runId)?.state_version).toBe(2)
  }, 30_000)

  it('rejects missing/untrusted Origin, malformed/private/client-price commands and invalid cursors without executing work', async () => {
    const fixture = runtimeFixture()
    const runId = 'terminal-ws-origin-run'
    const pair = await startServer(runId, fixture, undefined, 3)

    const rejected = new WebSocket(pair.url, { origin: 'https://evil.example' })
    clients.push(rejected)
    await expect(
      new Promise<void>((resolve, reject) => {
        rejected.once('open', () =>
          reject(new Error('untrusted Origin upgraded')),
        )
        rejected.once('unexpected-response', (_request, response) => {
          expect(response.statusCode).toBe(403)
          resolve()
        })
        rejected.once('error', reject)
      }),
    ).resolves.toBeUndefined()

    const noOrigin = new WebSocket(pair.url)
    clients.push(noOrigin)
    await expect(
      new Promise<void>((resolve, reject) => {
        noOrigin.once('open', () =>
          reject(new Error('missing Origin upgraded')),
        )
        noOrigin.once('unexpected-response', (_request, response) => {
          expect(response.statusCode).toBe(403)
          resolve()
        })
        noOrigin.once('error', reject)
      }),
    ).resolves.toBeUndefined()

    const client = connect(pair.url)
    await client.open
    client.socket.send('{not json')
    const malformed = await client.next(
      (message) => message.type === 'protocol.error',
    )
    expect(malformed.data.code).toBe('invalid_message')
    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'private-command-1',
        run_id: runId,
        expected_state_version: 0,
        action: 'private.order',
        price_usd: 1,
      }),
    )
    const invalid = await client.next(
      (message) =>
        message.type === 'protocol.error' &&
        message.data.code === 'unsupported_command',
    )
    expect(invalid.data.code).toBe('unsupported_command')
    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'resume',
        run_id: runId,
        last_seq: 999,
      }),
    )
    const cursor = await client.next(
      (message) => message.type === 'resync.required',
    )
    expect(cursor.data.reason).toBe('future_cursor')
    await client.next((message) => message.type === 'snapshot')
    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'unsupported-pause-command',
        run_id: runId,
        expected_state_version: 0,
        action: 'paper.pause',
      }),
    )
    const unsupported = await client.next(
      (message) =>
        message.type === 'protocol.error' &&
        message.data.code === 'unsupported_command',
    )
    expect(unsupported.data.code).toBe('unsupported_command')
    expect(pair.store.getRunProjection(runId)?.state_version).toBe(0)
    expect(
      pair.store.listTerminalEvents(runId, { afterSeq: 0, limit: 20 }).events,
    ).toHaveLength(0)
  }, 30_000)

  it('bounds replay history and resolves analysis detail without changing immutable work records', async () => {
    const fixture = runtimeFixture()
    const runId = 'terminal-ws-history-run'
    const pair = await startServer(runId, fixture, undefined, 2)
    const client = connect(pair.url)
    await client.open
    client.socket.send(
      JSON.stringify({ schema_version: 1, type: 'subscribe', run_id: runId }),
    )
    await client.next((message) => message.type === 'snapshot')
    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-open-history',
        run_id: runId,
        expected_state_version: 0,
        action: 'paper.start',
      }),
    )
    await client.next((message) => message.type === 'command.ack')
    await collectCommandEvents(client, 'terminal-open-history')

    const expired = connect(pair.url)
    await expired.open
    expired.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'resume',
        run_id: runId,
        last_seq: 0,
      }),
    )
    const reset = await expired.next(
      (message) => message.type === 'resync.required',
    )
    expect(reset.data.reason).toBe('cursor_expired')
    await expired.next((message) => message.type === 'snapshot')

    const detail = connect(pair.url)
    await detail.open
    detail.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'analysis.detail.request',
        run_id: runId,
        analysis_id: 'terminal-open-history',
      }),
    )
    const response = await detail.next(
      (message) => message.type === 'analysis.detail',
    )
    expect(response.data.analysis_id).toBe('terminal-open-history')
    expect(response.data.analysis).toBeDefined()
    expect(pair.store.getRunProjection(runId)?.state_version).toBe(1)
  }, 30_000)

  it('commits command acknowledgements and paper results before publishing them', async () => {
    const fixture = runtimeFixture()
    const runId = 'terminal-ws-failure-run'
    const pair = await startServer(runId, fixture)
    expect(() =>
      pair.store.acceptCommand(
        'terminal-rejected-before-commit',
        { request_id: 'terminal-rejected-before-commit' },
        'before-commit',
        null,
        {
          command_id: 'terminal-rejected-before-commit',
          action: 'paper.start',
          stream_run_id: runId,
          expected_state_version: 0,
        },
      ),
    ).toThrow(/pre-commit/)
    expect(
      pair.store.listTerminalEvents(runId, { afterSeq: 0, limit: 20 }).events,
    ).toHaveLength(0)

    const client = connect(pair.url)
    await client.open
    client.socket.send(
      JSON.stringify({ schema_version: 1, type: 'subscribe', run_id: runId }),
    )
    await client.next((message) => message.type === 'snapshot')
    pair.store.failNextResultCommit = true
    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-result-failure',
        run_id: runId,
        expected_state_version: 0,
        action: 'paper.start',
      }),
    )
    await client.next(
      (message) =>
        message.type === 'command.ack' &&
        message.data.command_id === 'terminal-result-failure',
    )
    await client.next(
      (message) =>
        message.type === 'command.result' &&
        message.data.command_id === 'terminal-result-failure',
    )
    const events = pair.store.listTerminalEvents(runId, {
      afterSeq: 0,
      limit: 100,
    }).events
    expect(events.map((event) => event.type)).toEqual([
      'command.ack',
      'command.result',
    ])
    expect(events[1]?.data.result).toMatchObject({
      result: { status: 'failed' },
    })
    expect(pair.store.getRunProjection(runId)?.state_version).toBe(0)
  }, 30_000)

  it('applies durable pause and resume controls through the risk runtime', async () => {
    const fixture = runtimeFixture()
    fixture.config.version = 'futures-runtime-risk.v1'
    fixture.config.daily_loss_fraction = '0.01'
    const runId = 'terminal-ws-pause-resume-run'
    const pair = await startServer(runId, fixture)
    const client = connect(pair.url)
    await client.open
    client.socket.send(
      JSON.stringify({ schema_version: 1, type: 'subscribe', run_id: runId }),
    )
    await client.next((message) => message.type === 'snapshot')

    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-pause-001',
        run_id: runId,
        expected_state_version: 0,
        action: 'paper.pause',
      }),
    )
    await client.next(
      (message) =>
        message.type === 'command.result' &&
        message.data.command_id === 'terminal-pause-001',
    )
    expect(
      (
        pair.store.getRunProjection(runId)?.checkpoint as Record<
          string,
          unknown
        >
      ).risk_checkpoint,
    ).toMatchObject({ user_paused: true })
    expect(pair.store.getRunProjection(runId)?.state_version).toBe(1)

    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-resume-001',
        run_id: runId,
        expected_state_version: 1,
        action: 'paper.resume',
      }),
    )
    await client.next(
      (message) =>
        message.type === 'command.result' &&
        message.data.command_id === 'terminal-resume-001',
    )
    const projection = pair.store.getRunProjection(runId)
    expect(projection?.state_version).toBe(2)
    expect(
      (projection?.checkpoint as Record<string, unknown>).risk_checkpoint,
    ).toMatchObject({ user_paused: false })
  }, 30_000)

  it('delivers a committed event exactly once when it lands between snapshot capture and delivery', async () => {
    const fixture = runtimeFixture()
    const runId = 'terminal-ws-snapshot-race-run'
    const clientRef: { current?: ReturnType<typeof connect> } = {}
    let commandEvents: TerminalTestMessage[] = []
    const pair = await startServer(runId, fixture, undefined, 10_000, 256, {
      afterSnapshot: async () => {
        clientRef.current!.socket.send(
          JSON.stringify({
            schema_version: 1,
            type: 'paper.command',
            command_id: 'terminal-snapshot-race-command',
            run_id: runId,
            expected_state_version: 0,
            action: 'paper.start',
          }),
        )
        await clientRef.current!.next(
          (message) => message.type === 'command.ack',
        )
        commandEvents = await collectCommandEvents(
          clientRef.current!,
          'terminal-snapshot-race-command',
        )
      },
    })
    const client = connect(pair.url)
    clientRef.current = client
    await client.open
    client.socket.send(
      JSON.stringify({ schema_version: 1, type: 'subscribe', run_id: runId }),
    )
    const snapshot = await client.next((message) => message.type === 'snapshot')
    expect(snapshot.seq).toBe(0)
    const delivered = client.messages.filter(
      (message) => message.data.command_id === 'terminal-snapshot-race-command',
    )
    expect(commandEvents.length).toBeGreaterThan(0)
    expect(
      delivered
        .filter((message) => message.type !== 'command.ack')
        .map((message) => message.seq),
    ).toEqual(commandEvents.map((message) => message.seq))
    expect(
      delivered.filter((message) => message.type === 'command.ack'),
    ).toHaveLength(1)
    expect(new Set(delivered.map((message) => message.event_id)).size).toBe(
      delivered.length,
    )
    expect(delivered.map((message) => message.seq)).toEqual(
      delivered.map((_, index) => index + 1),
    )
  }, 30_000)

  it('replaces the subscribed run prefix with a separately scoped snapshot', async () => {
    const fixture = runtimeFixture()
    const runId = 'terminal-ws-run-switch-source'
    const nextRunId = 'terminal-ws-run-switch-target'
    const pair = await startServer(runId, fixture)
    pair.store.createRun({
      runId: nextRunId,
      config: {
        ledger_version: 'linear-usd-ledger.v1',
        decimal_precision: 50,
        leverage: '1',
      },
      seed: { cash_usd: '10000' },
      instrument: { instrument_id: 'kraken-futures:PF_XBTUSD' },
      costs: {
        version: 'kraken-futures-eea-btcusd-base.v1',
        maker: '0.0002',
        taker: '0.0005',
      },
      runtime: {
        schema_version: 'futures-runtime-binding.v1',
        runtime_config: fixture.config,
        instrument_spec: fixture.instrument,
      },
    })
    const client = connect(pair.url)
    await client.open
    client.socket.send(
      JSON.stringify({ schema_version: 1, type: 'subscribe', run_id: runId }),
    )
    await client.next((message) => message.type === 'snapshot')
    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-run-switch-open',
        run_id: runId,
        expected_state_version: 0,
        action: 'paper.start',
      }),
    )
    await collectCommandEvents(client, 'terminal-run-switch-open')
    const sourceEvents = pair.store.listTerminalEvents(runId, {
      afterSeq: 0,
      limit: 100,
    }).events
    expect(sourceEvents.length).toBeGreaterThan(0)
    const priorCount = client.messages.length

    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'subscribe',
        run_id: nextRunId,
      }),
    )
    const snapshot = await client.next(
      (message) =>
        message.type === 'snapshot' &&
        message.run_id === nextRunId &&
        message.data.watermark === 0,
    )
    expect(snapshot.run_id).toBe(nextRunId)
    expect(snapshot.stream_id).not.toBe(sourceEvents[0]?.stream_id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(
      client.messages
        .slice(priorCount)
        .every((message) => message.run_id === nextRunId),
    ).toBe(true)
    expect(pair.store.getRunProjection(runId)?.state_version).toBe(1)
    expect(pair.store.getRunProjection(nextRunId)?.state_version).toBe(0)
  }, 30_000)

  it('creates one isolated child run for paper.new_run and returns the same child on exact retry', async () => {
    const fixture = runtimeFixture()
    fixture.config.version = 'futures-runtime-risk.v1'
    fixture.config.daily_loss_fraction = '0.01'
    const parentRunId = 'terminal-ws-new-run-parent'
    const commandId = 'terminal-ws-new-run-command'
    const pair = await startServer(
      parentRunId,
      fixture,
      undefined,
      10_000,
      256,
      {
        newRunFactory: (command, childRunId) => ({
          request_id: command.command_id,
          work_id: command.command_id,
          run_id: childRunId,
          expected_state_version: 0,
          payload: {
            operation: 'futures_runtime.v3',
            runtime_config: fixture.config,
            instrument: fixture.instrument,
            market_snapshot: fixture.openMarket,
          },
        }),
      },
    )
    const client = connect(pair.url)
    await client.open
    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'subscribe',
        run_id: parentRunId,
      }),
    )
    await client.next(
      (message) =>
        message.type === 'snapshot' && message.run_id === parentRunId,
    )

    const sendNewRun = () =>
      client.socket.send(
        JSON.stringify({
          schema_version: 1,
          type: 'paper.command',
          command_id: commandId,
          run_id: parentRunId,
          expected_state_version: 0,
          action: 'paper.new_run',
        }),
      )
    sendNewRun()
    const firstAck = await client.next(
      (message) =>
        message.type === 'command.ack' && message.data.command_id === commandId,
    )
    const firstResult = await client.next(
      (message) =>
        message.type === 'command.result' &&
        message.data.command_id === commandId,
    )
    const childRunId = firstResult.data.child_run_id
    expect(typeof childRunId).toBe('string')
    const childSnapshot = await client.next(
      (message) => message.type === 'snapshot' && message.run_id === childRunId,
    )
    expect(childSnapshot.data.watermark).toBeGreaterThan(0)
    expect(pair.store.getRunMetadata(String(childRunId))).toMatchObject({
      parent_run_id: parentRunId,
      revision_id: expect.any(String),
    })
    expect(pair.store.verifyRun(parentRunId)).toBe(true)
    expect(pair.store.verifyRun(String(childRunId))).toBe(true)
    expect(pair.store.getRunProjection(String(childRunId))?.state_version).toBe(
      1,
    )

    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'subscribe',
        run_id: parentRunId,
      }),
    )
    await client.next(
      (message) =>
        message.type === 'snapshot' && message.run_id === parentRunId,
    )
    sendNewRun()
    const retriedAck = await client.next(
      (message) =>
        message.type === 'command.ack' && message.data.command_id === commandId,
    )
    const retriedResult = await client.next(
      (message) =>
        message.type === 'command.result' &&
        message.data.command_id === commandId,
    )
    expect(retriedAck.event_id).toBe(firstAck.event_id)
    expect(retriedResult.event_id).toBe(firstResult.event_id)
    expect(retriedResult.data.child_run_id).toBe(childRunId)
    expect(pair.store.getRunProjection(String(childRunId))?.state_version).toBe(
      1,
    )

    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: commandId,
        run_id: parentRunId,
        expected_state_version: 0,
        action: 'paper.pause',
      }),
    )
    await client.next(
      (message) =>
        message.type === 'protocol.error' &&
        message.data.code === 'command_id_conflict',
    )
  }, 30_000)

  it('projects versioned USD/BTC financial snapshots with known-zero and incomplete funding explicitly distinct', async () => {
    const fixture = runtimeFixture()
    const zeroFunding = {
      type: 'funding_observation',
      received_at_ms: 21_600_000,
      known_at_ms: 21_600_000,
      observation: {
        source: 'fixture',
        provider: 'kraken',
        product: 'PF_XBTUSD',
        field: 'funding_rate',
        raw_rate: '0',
        unit: 'usd_per_btc_per_hour',
        effective_start_ms: 21_600_000,
        effective_end_ms: 25_200_000,
        known_at_ms: 21_600_000,
        received_seq: 1,
        observation_id: 'terminal-known-zero-funding',
        sha256: '0'.repeat(64),
        semantic_version: 'kraken-funding-normalization.v1',
        predicted: false,
      },
    }
    ;(fixture.openMarket.events as Record<string, unknown>[]).push(zeroFunding)
    ;(fixture.closeMarket.events as Record<string, unknown>[]).push(zeroFunding)
    const knownRunId = 'terminal-ws-known-zero-snapshot'
    const known = await startServer(knownRunId, fixture)
    const knownClient = connect(known.url)
    await knownClient.open
    knownClient.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'subscribe',
        run_id: knownRunId,
      }),
    )
    await knownClient.next((message) => message.type === 'snapshot')
    knownClient.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-known-zero-open',
        run_id: knownRunId,
        expected_state_version: 0,
        action: 'paper.start',
      }),
    )
    await collectCommandEvents(knownClient, 'terminal-known-zero-open')
    knownClient.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-known-zero-close',
        run_id: knownRunId,
        expected_state_version: 1,
        action: 'paper.close',
      }),
    )
    await collectCommandEvents(knownClient, 'terminal-known-zero-close')
    knownClient.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'subscribe',
        run_id: knownRunId,
      }),
    )
    const knownSnapshot = await knownClient.next(
      (message) =>
        message.type === 'snapshot' &&
        message.run_id === knownRunId &&
        typeof message.data.watermark === 'number' &&
        message.data.watermark > 0,
    )
    expect(knownSnapshot.data.state).toMatchObject({
      schema_version: 'paper-futures-terminal-state.v1',
      currency: 'USD',
      quantity_unit: 'BTC',
      account: {
        funding_complete: true,
        funding_paid_usd: '0',
        net_usd: expect.any(String),
      },
    })
    expect((knownSnapshot.data.state as Record<string, unknown>).fills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fill_id: expect.any(String) }),
      ]),
    )

    const unknownFixture = runtimeFixture()
    const unknownRunId = 'terminal-ws-unknown-funding-snapshot'
    const unknown = await startServer(unknownRunId, unknownFixture)
    const unknownClient = connect(unknown.url)
    await unknownClient.open
    unknownClient.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'subscribe',
        run_id: unknownRunId,
      }),
    )
    await unknownClient.next((message) => message.type === 'snapshot')
    unknownClient.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-unknown-funding-open',
        run_id: unknownRunId,
        expected_state_version: 0,
        action: 'paper.start',
      }),
    )
    await collectCommandEvents(unknownClient, 'terminal-unknown-funding-open')
    unknownClient.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-unknown-funding-close',
        run_id: unknownRunId,
        expected_state_version: 1,
        action: 'paper.close',
      }),
    )
    await collectCommandEvents(unknownClient, 'terminal-unknown-funding-close')
    unknownClient.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'subscribe',
        run_id: unknownRunId,
      }),
    )
    const unknownSnapshot = await unknownClient.next(
      (message) =>
        message.type === 'snapshot' &&
        message.run_id === unknownRunId &&
        typeof message.data.watermark === 'number' &&
        message.data.watermark > 0,
    )
    expect(unknownSnapshot.data.state).toMatchObject({
      schema_version: 'paper-futures-terminal-state.v1',
      currency: 'USD',
      quantity_unit: 'BTC',
      account: { funding_complete: false, net_usd: null },
    })
    expect(
      (unknownSnapshot.data.state as Record<string, unknown>).analyses,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ analysis_id: expect.any(String) }),
      ]),
    )
  }, 30_000)

  it('resynchronizes a backpressured subscriber without dropping its committed ledger effects', async () => {
    const fixture = runtimeFixture()
    const runId = 'terminal-ws-backpressure-run'
    const pair = await startServer(runId, fixture, undefined, 10_000, 1)
    const client = connect(pair.url)
    await client.open
    client.socket.send(
      JSON.stringify({ schema_version: 1, type: 'subscribe', run_id: runId }),
    )
    await client.next((message) => message.type === 'snapshot')
    client.socket.send(
      JSON.stringify({
        schema_version: 1,
        type: 'paper.command',
        command_id: 'terminal-backpressure-work',
        run_id: runId,
        expected_state_version: 0,
        action: 'paper.start',
      }),
    )
    const closeCode = new Promise<number>((resolve) =>
      client.socket.once('close', (code) => resolve(code)),
    )
    expect(await closeCode).toBe(1013)
    expect(
      pair.store
        .listTerminalEvents(runId, { afterSeq: 0, limit: 100 })
        .events.some((event) => event.type === 'fill.created'),
    ).toBe(true)
    expect(pair.store.getRunProjection(runId)?.state_version).toBe(1)
  }, 30_000)
})

function runtimeFixture(): {
  config: Record<string, unknown>
  instrument: Record<string, unknown>
  openMarket: Record<string, unknown>
  closeMarket: Record<string, unknown>
} {
  const root = resolve(import.meta.dirname, '../../../../')
  const result = spawnSync(
    'python3',
    [
      '-c',
      String.raw`
import json
from futures_runtime_fixtures import CONFIG, INSTRUMENT, warmed_market
print(json.dumps({
  'config': CONFIG,
  'instrument': INSTRUMENT,
  'openMarket': warmed_market(21600000, breakout='long'),
  'closeMarket': warmed_market(21660000, base_price='100500'),
}))
`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        PYTHONPATH: `${root}/python:${root}/python/tests`,
      },
      encoding: 'utf8',
    },
  )
  if (result.status !== 0) throw new Error(result.stderr)
  return JSON.parse(result.stdout) as ReturnType<typeof runtimeFixture>
}

class FailureInjectingFuturesStore extends FuturesStore {
  failNextResultCommit = false

  override applyResult(
    value: unknown,
    injectFailureAt?: 'before-commit',
  ): Record<string, unknown> {
    if (this.failNextResultCommit) {
      this.failNextResultCommit = false
      return super.applyResult(value, 'before-commit')
    }
    return super.applyResult(value, injectFailureAt)
  }
}

async function startServer(
  runId: string,
  fixture: ReturnType<typeof runtimeFixture>,
  databasePath?: string,
  retention = 10_000,
  maxQueuedEvents = 256,
  hooks?: {
    afterSnapshot?: (runId: string, watermark: number) => Promise<void>
    newRunFactory?: (
      command: {
        command_id: string
        run_id: string
        expected_state_version: number
      },
      childRunId: string,
    ) => {
      request_id: string
      work_id: string
      run_id: string
      expected_state_version: number
      payload: Record<string, unknown>
    }
  },
) {
  const directory = mkdtempSync(join(tmpdir(), 'terminal-stream-'))
  directories.push(directory)
  const dbPath = databasePath ?? join(directory, 'futures.sqlite')
  const store = new FailureInjectingFuturesStore(dbPath)
  store.createRun({
    runId,
    config: {
      ledger_version: 'linear-usd-ledger.v1',
      decimal_precision: 50,
      leverage: '1',
    },
    seed: { cash_usd: '10000' },
    instrument: { instrument_id: 'kraken-futures:PF_XBTUSD' },
    costs: {
      version: 'kraken-futures-eea-btcusd-base.v1',
      maker: '0.0002',
      taker: '0.0005',
    },
    runtime:
      fixture.config.version === 'futures-runtime-risk.v1'
        ? {
            schema_version: 'futures-runtime-binding.v4',
            runtime_config: fixture.config,
            instrument_spec: fixture.instrument,
            strategy_manifest: {
              config_version: 'futures-strategies-config.v1',
              indicator_version: 'futures-closed-indicators.v1',
              strategy_ids: [
                'c25-pullback-perp-v1',
                'c26-reversion-perp-v1',
                'c27-breakout-perp-v1',
                'c28-adapter-perp-v1',
              ],
            },
            strategy_config_hash: canonicalHash({
              config_version: 'futures-strategies-config.v1',
              indicator_version: 'futures-closed-indicators.v1',
              strategy_ids: [
                'c25-pullback-perp-v1',
                'c26-reversion-perp-v1',
                'c27-breakout-perp-v1',
                'c28-adapter-perp-v1',
              ],
            }),
          }
        : {
            schema_version: 'futures-runtime-binding.v1',
            runtime_config: fixture.config,
            instrument_spec: fixture.instrument,
          },
  })
  const runner = new FuturesCommandRunner(store)
  const commandFactory: TerminalWorkerRequestFactory = (command) => {
    const market =
      command.action === 'paper.close'
        ? fixture.closeMarket
        : fixture.openMarket
    const control =
      command.action === 'paper.close' ||
      command.action === 'paper.pause' ||
      command.action === 'paper.resume'
        ? { type: command.action, command_id: command.command_id }
        : undefined
    return {
      request_id: command.command_id,
      work_id: command.command_id,
      run_id: command.run_id,
      expected_state_version: command.expected_state_version,
      payload: {
        operation:
          fixture.config.version === 'futures-runtime-risk.v1'
            ? 'futures_runtime.v3'
            : 'futures_runtime.v1',
        runtime_config: fixture.config,
        instrument: fixture.instrument,
        market_snapshot: market,
        ...(control === undefined ? {} : { control }),
      },
    }
  }
  const app = Fastify({ logger: false })
  const { newRunFactory, ...streamHooks } = hooks ?? {}
  registerTerminalStream(app, {
    store,
    runner,
    commandFactory,
    allowedOrigins: ['http://127.0.0.1'],
    historyRetention: retention,
    maxQueuedEvents,
    heartbeatMs: 60_000,
    ...streamHooks,
    ...(newRunFactory
      ? {
          newRunFactory: (command, childRunId) =>
            newRunFactory(command, childRunId) as FuturesWorkerRequest,
        }
      : {}),
  })
  const address = await app.listen({ port: 0, host: '127.0.0.1' })
  const pair = {
    app,
    runner,
    store,
    databasePath: dbPath,
    url: address.replace('http:', 'ws:') + '/api/terminal/stream',
  }
  servers.push(pair)
  return pair
}

function connect(url: string) {
  const socket = new WebSocket(url, { origin: 'http://127.0.0.1' })
  clients.push(socket)
  const messages: TerminalTestMessage[] = []
  const pending: Array<{
    predicate: (message: TerminalTestMessage) => boolean
    resolve: (message: TerminalTestMessage) => void
    reject: (error: Error) => void
    timer: NodeJS.Timeout
  }> = []
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as TerminalTestMessage
    messages.push(message)
    for (const item of [...pending]) {
      if (!item.predicate(message)) continue
      pending.splice(pending.indexOf(item), 1)
      clearTimeout(item.timer)
      item.resolve(message)
    }
  })
  return {
    socket,
    open: new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    }),
    next(predicate: (message: TerminalTestMessage) => boolean) {
      const prior = messages.find(predicate)
      if (prior) return Promise.resolve(prior)
      return new Promise<TerminalTestMessage>((resolve, reject) => {
        const item = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            pending.splice(pending.indexOf(item), 1)
            reject(
              new Error(
                `Timed out waiting for terminal message; received ${messages.map((message) => `${message.type}:${JSON.stringify(message.data)}`).join(', ')}`,
              ),
            )
          }, 10_000),
        }
        pending.push(item)
      })
    },
    messages,
  }
}

async function collectCommandEvents(
  client: ReturnType<typeof connect>,
  commandId: string,
): Promise<TerminalTestMessage[]> {
  const final = await client.next(
    (message) =>
      message.type === 'command.result' &&
      message.data.command_id === commandId,
  )
  return client.messages
    .filter(
      (message) =>
        Number(message.seq) > 0 &&
        message.type !== 'command.ack' &&
        (message.data?.command_id === commandId ||
          (message.type === 'analysis.completed' &&
            message.data.work_id === commandId) ||
          (message.type === 'order.updated' &&
            message.data.work_id === commandId) ||
          (message.type === 'fill.created' &&
            message.data.work_id === commandId) ||
          (message.type === 'position.updated' &&
            message.data.work_id === commandId) ||
          (message.type === 'account.updated' &&
            message.data.work_id === commandId)),
    )
    .filter((message) => Number(message.seq) <= Number(final.seq))
}

async function collectUntilSeq(
  client: ReturnType<typeof connect>,
  lastSeq: number,
): Promise<TerminalTestMessage[]> {
  await client.next(
    (message) =>
      Number(message.seq) >= lastSeq && message.type === 'command.result',
  )
  return client.messages.filter(
    (message) =>
      Number(message.seq) > 0 &&
      Number(message.seq) <= lastSeq &&
      message.type !== 'snapshot',
  )
}
