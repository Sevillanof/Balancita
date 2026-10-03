import { createHash, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { Socket } from 'node:net'
import type { FastifyInstance } from 'fastify'
import WebSocket, { WebSocketServer } from 'ws'
import type { FuturesCommandRunner } from '../paper-futures/futures-command-runner.ts'
import type { FuturesWorkerRequest } from '../paper-futures/futures-worker.ts'
import {
  FuturesStore,
  type TerminalCommandMetadata,
  type TerminalStoredEvent,
} from '../paper-futures/futures-store.ts'

const STREAM_PATH = '/api/terminal/stream'
const MAX_MESSAGE_BYTES = 64 * 1024
const MAX_HISTORY_PAGE = 500
const MAX_QUEUED_EVENTS = 256
const MAX_BUFFERED_BYTES = 1_048_576
const MAX_CONNECTIONS = 64
const DEFAULT_HEARTBEAT_MS = 15_000
const INSTRUMENT_ID = 'kraken-futures:PF_XBTUSD'

export type PaperCommandAction =
  | 'paper.start'
  | 'paper.pause'
  | 'paper.resume'
  | 'paper.close'
  | 'paper.new_run'

export interface TerminalPaperCommand {
  readonly command_id: string
  readonly run_id: string
  readonly expected_state_version: number
  readonly action: PaperCommandAction
}

export type TerminalWorkerRequestFactory = (
  command: TerminalPaperCommand,
) => FuturesWorkerRequest

export type TerminalCommandExecutor = (
  request: FuturesWorkerRequest,
  metadata: TerminalCommandMetadata,
) => {
  readonly acknowledgement: Record<string, unknown>
  readonly result: Promise<Record<string, unknown>>
}

export interface TerminalStreamOptions {
  readonly store: FuturesStore
  readonly runner: FuturesCommandRunner
  readonly commandFactory: TerminalWorkerRequestFactory
  readonly allowedOrigins?: readonly string[]
  readonly historyRetention?: number
  readonly maxQueuedEvents?: number
  readonly heartbeatMs?: number
  readonly clock?: () => number
  readonly afterSnapshot?: (runId: string, watermark: number) => Promise<void>
  readonly newRunFactory?: (
    command: TerminalPaperCommand,
    childRunId: string,
  ) => FuturesWorkerRequest
  readonly commandExecutor?: TerminalCommandExecutor
  readonly onNewRunCreated?: (runId: string) => void
}

interface StreamEnvelope {
  readonly schema_version: 1
  readonly event_id: string
  readonly stream_id: string
  readonly run_id: string
  readonly seq: number
  readonly type: string
  readonly instrument_id: string
  readonly event_time: number
  readonly published_at: number
  readonly data: Record<string, unknown>
}

interface ClientSession {
  readonly socket: WebSocket
  runId?: string
  streamId?: string
  lastSentSeq: number
  lastQueuedSeq: number
  queue: TerminalStoredEvent[]
  sending: boolean
  replaying: boolean
  closed: boolean
  readonly idleWaiters: Array<() => void>
}

interface ParsedRequest {
  readonly schema_version: 1
  readonly type:
    | 'subscribe'
    | 'resume'
    | 'history.request'
    | 'analysis.detail.request'
    | 'paper.command'
  readonly run_id: string
  readonly last_seq?: number
  readonly before_seq?: number
  readonly limit?: number
  readonly analysis_id?: string
  readonly record_hash?: string
  readonly command_id?: string
  readonly expected_state_version?: number
  readonly action?: PaperCommandAction
}

export function registerTerminalStream(
  app: FastifyInstance,
  options: TerminalStreamOptions,
): void {
  const { store, runner } = options
  const allowedOrigins = new Set(
    options.allowedOrigins ?? [
      'http://localhost',
      'http://127.0.0.1',
      'http://[::1]',
    ],
  )
  const clock = options.clock ?? Date.now
  const maxQueuedEvents = options.maxQueuedEvents ?? MAX_QUEUED_EVENTS
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
  const historyRetention = options.historyRetention ?? 10_000
  if (
    !Number.isSafeInteger(maxQueuedEvents) ||
    maxQueuedEvents < 1 ||
    !Number.isSafeInteger(heartbeatMs) ||
    heartbeatMs < 100 ||
    !Number.isSafeInteger(historyRetention) ||
    historyRetention < 1
  )
    throw new Error('Terminal stream limits are invalid.')
  store.setTerminalEventRetention(historyRetention)

  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: true,
    perMessageDeflate: false,
    maxPayload: MAX_MESSAGE_BYTES,
  })
  const sessions = new Set<ClientSession>()
  const commandJobs = new Map<
    string,
    { readonly signature: string; readonly result: Promise<unknown> }
  >()
  let closing = false

  const publish = (event: TerminalStoredEvent): void => {
    for (const session of sessions)
      if (session.runId === event.run_id) enqueue(session, event)
  }
  const unsubscribe = store.subscribeTerminalEvents(publish)

  app.get(STREAM_PATH, async (_request, reply) =>
    reply.code(426).send({ error: { code: 'websocket_required' } }),
  )

  const onUpgrade = (
    request: IncomingMessage,
    socket: Socket,
    head: Buffer,
  ): void => {
    let pathname: string
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request')
    }
    if (pathname !== STREAM_PATH) return
    if (closing) return rejectUpgrade(socket, 503, 'Service Unavailable')
    if (wss.clients.size >= MAX_CONNECTIONS)
      return rejectUpgrade(socket, 429, 'Too Many Requests')
    if (!isLoopback(socket.remoteAddress))
      return rejectUpgrade(socket, 403, 'Forbidden')
    const origin = request.headers.origin
    if (typeof origin !== 'string' || !allowedOrigins.has(origin))
      return rejectUpgrade(socket, 403, 'Forbidden')
    socket.on('error', () => undefined)
    wss.handleUpgrade(request, socket, head, (websocket) => {
      wss.emit('connection', websocket, request)
    })
  }

  app.server.on('upgrade', onUpgrade)
  wss.on('connection', (socket) => {
    const session: ClientSession = {
      socket,
      lastSentSeq: 0,
      lastQueuedSeq: 0,
      queue: [],
      sending: false,
      replaying: false,
      closed: false,
      idleWaiters: [],
    }
    sessions.add(session)
    socket.on('message', (raw) => {
      const rawBuffer = Array.isArray(raw)
        ? Buffer.concat(raw)
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw)
          : Buffer.from(raw as Buffer)
      if (rawBuffer.byteLength > MAX_MESSAGE_BYTES) {
        sendProtocolError(session, 'message_too_large')
        return socket.close(1009, 'Message too large')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(rawBuffer.toString('utf8')) as unknown
      } catch {
        sendProtocolError(session, 'invalid_message')
        return
      }
      const message = parseRequest(parsed)
      if (!message) {
        sendProtocolError(
          session,
          isRecord(parsed) && parsed.type === 'paper.command'
            ? 'unsupported_command'
            : 'invalid_message',
        )
        return
      }
      void handleRequest(session, message)
    })
    socket.on('error', () => {
      session.closed = true
      sessions.delete(session)
      releaseIdleWaiters(session)
    })
    socket.on('close', () => {
      session.closed = true
      sessions.delete(session)
      session.queue = []
      releaseIdleWaiters(session)
    })
  })

  const heartbeat = setInterval(() => {
    for (const session of sessions) {
      if (session.socket.readyState !== WebSocket.OPEN) continue
      if (session.socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        closeForResync(session, 'backpressure')
        continue
      }
      if (session.runId === undefined || session.streamId === undefined) {
        session.socket.ping()
        continue
      }
      if (session.sending || session.queue.length > 0) {
        session.socket.ping()
        continue
      }
      const latest = store.listTerminalEvents(session.runId, {
        afterSeq: 0,
        limit: 1,
      }).lastSeq
      const sentAt = clock()
      const envelope: StreamEnvelope = {
        schema_version: 1,
        event_id: randomUUID(),
        stream_id: session.streamId,
        run_id: session.runId,
        seq: latest,
        type: 'heartbeat',
        instrument_id: INSTRUMENT_ID,
        event_time: sentAt,
        published_at: sentAt,
        data: { at: sentAt },
      }
      sendEphemeral(session, envelope)
      session.socket.ping()
    }
  }, heartbeatMs)
  heartbeat.unref()

  app.addHook('onClose', async () => {
    closing = true
    clearInterval(heartbeat)
    unsubscribe()
    app.server.removeListener('upgrade', onUpgrade)
    for (const session of sessions) {
      session.closed = true
      session.socket.terminate()
      releaseIdleWaiters(session)
    }
    sessions.clear()
    await new Promise<void>((resolve) => {
      wss.close(() => resolve())
    })
  })

  async function handleRequest(
    session: ClientSession,
    request: ParsedRequest,
  ): Promise<void> {
    try {
      if (request.type === 'subscribe') {
        await subscribe(session, request.run_id)
        return
      }
      if (request.type === 'resume') {
        await resume(session, request.run_id, request.last_seq!)
        return
      }
      if (request.type === 'history.request') {
        sendHistory(session, request)
        return
      }
      if (request.type === 'analysis.detail.request') {
        sendAnalysisDetail(session, request)
        return
      }
      if (request.type === 'paper.command') {
        await dispatchCommand(session, request)
        return
      }
    } catch (error) {
      sendControl(
        session,
        'protocol.error',
        session.runId ?? 'unbound',
        session.streamId ?? 'unbound',
        {
          code: 'request_failed',
          diagnostic: error instanceof Error ? error.message : String(error),
        },
      )
    }
  }

  async function subscribe(
    session: ClientSession,
    runId: string,
  ): Promise<void> {
    const snapshot = store.getTerminalSnapshot(runId)
    session.runId = runId
    session.streamId = snapshot.stream_id
    session.lastSentSeq = snapshot.watermark
    session.lastQueuedSeq = snapshot.watermark
    session.queue = []
    session.replaying = true
    await options.afterSnapshot?.(runId, snapshot.watermark)
    const now = clock()
    const envelope: StreamEnvelope = {
      schema_version: 1,
      event_id: randomUUID(),
      stream_id: snapshot.stream_id,
      run_id: runId,
      seq: snapshot.watermark,
      type: 'snapshot',
      instrument_id: snapshot.instrument_id,
      event_time: now,
      published_at: now,
      data: {
        watermark: snapshot.watermark,
        state: snapshot.state,
      },
    }
    sendEphemeral(session, envelope, (error) => {
      if (error || session.closed) return
      void replayForward(session)
    })
  }

  async function resume(
    session: ClientSession,
    runId: string,
    lastSeq: number,
  ): Promise<void> {
    const page = store.listTerminalEvents(runId, {
      afterSeq: lastSeq,
      limit: 1,
    })
    if (lastSeq > page.lastSeq) {
      sendResync(session, runId, page.streamId, lastSeq, 'future_cursor')
      await subscribe(session, runId)
      return
    }
    if (page.expired) {
      sendResync(session, runId, page.streamId, lastSeq, 'cursor_expired')
      await subscribe(session, runId)
      return
    }
    if (
      session.runId !== undefined &&
      (session.runId !== runId || session.streamId !== page.streamId)
    ) {
      sendResync(session, runId, page.streamId, lastSeq, 'run_changed')
      await subscribe(session, runId)
      return
    }
    session.runId = runId
    session.streamId = page.streamId
    session.lastSentSeq = lastSeq
    session.lastQueuedSeq = lastSeq
    session.queue = []
    session.replaying = true
    await replayForward(session)
  }

  async function replayForward(session: ClientSession): Promise<void> {
    if (session.closed || session.runId === undefined) return
    session.replaying = true
    try {
      for (;;) {
        const page = store.listTerminalEvents(session.runId, {
          afterSeq: session.lastQueuedSeq,
          limit: MAX_HISTORY_PAGE,
        })
        if (page.expired) {
          sendResync(
            session,
            session.runId,
            page.streamId,
            session.lastSentSeq,
            'cursor_expired',
          )
          await subscribe(session, session.runId)
          return
        }
        for (const event of page.events) enqueue(session, event)
        session.replaying = false
        pump(session)
        await waitUntilIdle(session)
        if (session.closed) return
        session.replaying = true
        if (session.lastSentSeq >= page.lastSeq) {
          const latest = store.listTerminalEvents(session.runId, {
            afterSeq: session.lastSentSeq,
            limit: 1,
          })
          if (latest.events.length === 0) break
        }
      }
    } finally {
      session.replaying = false
      pump(session)
    }
  }

  function enqueue(session: ClientSession, event: TerminalStoredEvent): void {
    if (session.closed || session.runId !== event.run_id) return
    if (event.seq <= session.lastQueuedSeq) return
    if (event.seq !== session.lastQueuedSeq + 1) {
      closeForResync(session, 'sequence_gap')
      return
    }
    if (
      session.queue.length >= maxQueuedEvents ||
      session.socket.bufferedAmount > MAX_BUFFERED_BYTES
    ) {
      closeForResync(session, 'backpressure')
      return
    }
    session.queue.push(event)
    session.lastQueuedSeq = event.seq
    pump(session)
  }

  function pump(session: ClientSession): void {
    if (
      session.closed ||
      session.sending ||
      session.socket.readyState !== WebSocket.OPEN
    )
      return
    const event = session.queue.shift()
    if (!event) {
      releaseIdleWaiters(session)
      return
    }
    session.sending = true
    session.socket.send(JSON.stringify(event), { compress: false }, (error) => {
      session.sending = false
      if (error) {
        session.socket.terminate()
        return
      }
      session.lastSentSeq = event.seq
      pump(session)
    })
  }

  function waitUntilIdle(session: ClientSession): Promise<void> {
    if (session.closed || (!session.sending && session.queue.length === 0))
      return Promise.resolve()
    return new Promise((resolve) => session.idleWaiters.push(resolve))
  }

  function releaseIdleWaiters(session: ClientSession): void {
    if (session.sending || session.queue.length > 0) return
    for (const resolve of session.idleWaiters.splice(0)) resolve()
  }

  function sendEphemeral(
    session: ClientSession,
    envelope: StreamEnvelope,
    callback?: (error?: Error) => void,
  ): void {
    if (session.closed || session.socket.readyState !== WebSocket.OPEN) return
    session.socket.send(JSON.stringify(envelope), { compress: false }, callback)
  }

  function sendControl(
    session: ClientSession,
    type: string,
    runId: string,
    streamId: string,
    data: Record<string, unknown>,
  ): void {
    const now = clock()
    sendEphemeral(session, {
      schema_version: 1,
      event_id: randomUUID(),
      stream_id: streamId,
      run_id: runId,
      seq: session.lastSentSeq,
      type,
      instrument_id: INSTRUMENT_ID,
      event_time: now,
      published_at: now,
      data,
    })
  }

  function sendProtocolError(session: ClientSession, code: string): void {
    sendControl(
      session,
      'protocol.error',
      session.runId ?? 'unbound',
      session.streamId ?? 'unbound',
      { code },
    )
  }

  function sendResync(
    session: ClientSession,
    runId: string,
    streamId: string,
    lastSeq: number,
    reason: string,
  ): void {
    sendControl(session, 'resync.required', runId, streamId, {
      reason,
      last_seq: lastSeq,
    })
  }

  function closeForResync(session: ClientSession, reason: string): void {
    if (session.closed) return
    sendResync(
      session,
      session.runId ?? 'unbound',
      session.streamId ?? 'unbound',
      session.lastSentSeq,
      reason,
    )
    session.closed = true
    session.socket.close(1013, `resync:${reason}`)
    sessions.delete(session)
    releaseIdleWaiters(session)
  }

  function sendHistory(session: ClientSession, request: ParsedRequest): void {
    const page = store.listTerminalEvents(request.run_id, {
      beforeSeq: request.before_seq ?? Number.MAX_SAFE_INTEGER,
      limit: request.limit ?? 100,
    })
    sendControl(session, 'history.page', request.run_id, page.streamId, {
      events: page.events,
      before_seq: request.before_seq ?? Number.MAX_SAFE_INTEGER,
      next_before_seq: page.nextBeforeSeq,
    })
  }

  function sendAnalysisDetail(
    session: ClientSession,
    request: ParsedRequest,
  ): void {
    const detail = store.getTerminalAnalysisDetail(
      request.run_id,
      request.analysis_id!,
    )
    if (detail === undefined) {
      sendControl(
        session,
        'protocol.error',
        request.run_id,
        session.streamId ?? 'unbound',
        {
          code: 'analysis_not_found',
        },
      )
      return
    }
    if (
      request.record_hash !== undefined &&
      detail.record_hash !== request.record_hash
    ) {
      sendControl(
        session,
        'protocol.error',
        request.run_id,
        session.streamId ?? 'unbound',
        {
          code: 'analysis_hash_mismatch',
        },
      )
      return
    }
    sendControl(
      session,
      'analysis.detail',
      request.run_id,
      session.streamId ?? 'unbound',
      detail,
    )
  }

  async function dispatchCommand(
    session: ClientSession,
    request: ParsedRequest,
  ): Promise<void> {
    if (session.runId !== request.run_id || session.streamId === undefined) {
      sendProtocolError(session, 'subscribe_before_command')
      return
    }
    const accepted = store.getAcceptedCommand(request.command_id!)
    const acceptedRequest = isRecord(accepted) ? accepted : undefined
    const metadata = acceptedRequest?.terminalCommand
    if (metadata !== undefined) {
      if (
        !isRecord(metadata) ||
        metadata.command_id !== request.command_id ||
        metadata.stream_run_id !== request.run_id ||
        metadata.action !== request.action ||
        metadata.expected_state_version !== request.expected_state_version
      ) {
        sendProtocolError(session, 'command_id_conflict')
        return
      }
      const page = store.listTerminalEvents(request.run_id, {
        afterSeq: 0,
        limit: MAX_HISTORY_PAGE,
      })
      if (page.expired) {
        sendResync(
          session,
          request.run_id,
          page.streamId,
          session.lastSentSeq,
          'cursor_expired',
        )
        await subscribe(session, request.run_id)
        return
      }
      for (const event of page.events)
        if (event.data.command_id === request.command_id)
          sendEphemeral(session, event)
      return
    }
    if (
      request.action !== 'paper.start' &&
      request.action !== 'paper.close' &&
      request.action !== 'paper.pause' &&
      request.action !== 'paper.resume' &&
      request.action !== 'paper.new_run'
    ) {
      sendProtocolError(session, 'unsupported_command')
      return
    }
    const projection = store.getRunProjection(request.run_id)
    if (!projection) {
      sendProtocolError(session, 'run_not_found')
      return
    }
    if (projection.state_version !== request.expected_state_version) {
      sendProtocolError(session, 'stale_state_version')
      return
    }
    const command: TerminalPaperCommand = {
      command_id: request.command_id!,
      run_id: request.run_id,
      expected_state_version: request.expected_state_version!,
      action: request.action!,
    }
    const signature = JSON.stringify(command)
    const previous = commandJobs.get(command.command_id)
    if (previous) {
      if (previous.signature !== signature)
        sendProtocolError(session, 'command_id_conflict')
      else void previous.result.catch(() => undefined)
      return
    }
    const result = runCommand(command, session)
    commandJobs.set(command.command_id, { signature, result })
    try {
      await result
    } finally {
      commandJobs.delete(command.command_id)
    }
  }

  async function runCommand(
    command: TerminalPaperCommand,
    session: ClientSession,
  ): Promise<unknown> {
    let request: FuturesWorkerRequest
    try {
      const childRunId =
        command.action === 'paper.new_run'
          ? deterministicChildRunId(command.command_id)
          : undefined
      request =
        childRunId && options.newRunFactory
          ? options.newRunFactory(command, childRunId)
          : options.commandFactory(command)
      if (childRunId && request.run_id === childRunId) {
        const parent = store.getRunDefinition(command.run_id)
        store.createChildRun({
          runId: childRunId,
          parentRunId: command.run_id,
          revisionId: createHash('sha256')
            .update(`${command.run_id}:${command.command_id}`)
            .digest('hex'),
          ...parent,
        })
        options.onNewRunCreated?.(childRunId)
      } else if (command.action === 'paper.new_run')
        throw new Error('new_run_factory_required')
      if (
        request.work_id !== command.command_id ||
        request.expected_state_version !==
          (command.action === 'paper.new_run'
            ? 0
            : command.expected_state_version) ||
        request.payload.operation === undefined ||
        ![
          'futures_runtime.v1',
          'futures_runtime.v2',
          'futures_runtime.v3',
        ].includes(request.payload.operation) ||
        (command.action !== 'paper.new_run' &&
          request.run_id !== command.run_id) ||
        (['paper.close', 'paper.pause', 'paper.resume'].includes(
          command.action,
        ) &&
          (!('control' in request.payload) ||
            request.payload.control?.type !== command.action ||
            request.payload.control.command_id !== command.command_id))
      )
        throw new Error('command_factory_invalid_request')
    } catch {
      throw new Error('command_factory_invalid_request')
    }
    const terminalCommand: TerminalCommandMetadata = {
      command_id: command.command_id,
      action: command.action,
      stream_run_id: command.run_id,
      expected_state_version: command.expected_state_version,
      ...(command.action === 'paper.new_run'
        ? { child_run_id: request.run_id }
        : {}),
    }
    const accepted =
      options.commandExecutor?.(request, terminalCommand) ??
      runner.accept(request, terminalCommand)
    if (
      accepted.acknowledgement.command_id !== command.command_id ||
      accepted.acknowledgement.status !== 'accepted'
    )
      throw new Error('durable_command_ack_invalid')
    if (command.action === 'paper.new_run') {
      const childRunId = request.run_id
      try {
        const result = await accepted.result
        await waitUntilIdle(session)
        await subscribe(session, childRunId)
        return result
      } catch {
        const failed = store.persistCommandResult(command.command_id, {
          status: 'failed',
          command_id: command.command_id,
          error_code: 'execution_failed',
          child_run_id: childRunId,
        })
        return failed
      }
    }
    try {
      return await accepted.result
    } catch {
      const persisted = store.persistCommandResult(command.command_id, {
        status: 'failed',
        command_id: command.command_id,
        error_code: 'execution_failed',
      })
      return persisted
    }
  }
}

function deterministicChildRunId(commandId: string): string {
  const hex = createHash('sha256')
    .update(`paper.new_run:${commandId}`)
    .digest('hex')
    .slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function parseRequest(value: unknown): ParsedRequest | undefined {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    typeof value.type !== 'string'
  )
    return undefined
  const runId = value.run_id
  if (typeof runId !== 'string' || runId.length < 1 || runId.length > 128)
    return undefined
  const baseKeys = ['schema_version', 'type', 'run_id']
  if (value.type === 'subscribe')
    return hasExactKeys(value, baseKeys)
      ? { schema_version: 1, type: 'subscribe', run_id: runId }
      : undefined
  if (value.type === 'resume')
    return hasExactKeys(value, [...baseKeys, 'last_seq']) &&
      typeof value.last_seq === 'number' &&
      Number.isSafeInteger(value.last_seq) &&
      value.last_seq >= 0
      ? {
          schema_version: 1,
          type: 'resume',
          run_id: runId,
          last_seq: value.last_seq,
        }
      : undefined
  if (value.type === 'history.request')
    return hasExactKeys(value, [...baseKeys, 'before_seq', 'limit']) &&
      (value.before_seq === undefined ||
        (typeof value.before_seq === 'number' &&
          Number.isSafeInteger(value.before_seq) &&
          value.before_seq > 0)) &&
      (value.limit === undefined ||
        (typeof value.limit === 'number' &&
          Number.isSafeInteger(value.limit) &&
          value.limit >= 1 &&
          value.limit <= 500))
      ? {
          schema_version: 1,
          type: 'history.request',
          run_id: runId,
          ...(value.before_seq === undefined
            ? {}
            : { before_seq: value.before_seq }),
          ...(value.limit === undefined ? {} : { limit: value.limit }),
        }
      : undefined
  if (value.type === 'analysis.detail.request')
    return hasExactKeys(value, [...baseKeys, 'analysis_id', 'record_hash']) &&
      typeof value.analysis_id === 'string' &&
      value.analysis_id.length > 0 &&
      (value.record_hash === undefined ||
        (typeof value.record_hash === 'string' &&
          /^[a-f0-9]{64}$/.test(value.record_hash)))
      ? {
          schema_version: 1,
          type: 'analysis.detail.request',
          run_id: runId,
          analysis_id: value.analysis_id,
          ...(value.record_hash === undefined
            ? {}
            : { record_hash: value.record_hash }),
        }
      : undefined
  if (value.type === 'paper.command') {
    const actions: readonly PaperCommandAction[] = [
      'paper.start',
      'paper.pause',
      'paper.resume',
      'paper.close',
      'paper.new_run',
    ]
    return hasExactKeys(value, [
      ...baseKeys,
      'command_id',
      'expected_state_version',
      'action',
    ]) &&
      typeof value.command_id === 'string' &&
      value.command_id.length > 0 &&
      value.command_id.length <= 128 &&
      typeof value.expected_state_version === 'number' &&
      Number.isSafeInteger(value.expected_state_version) &&
      value.expected_state_version >= 0 &&
      actions.includes(value.action as PaperCommandAction)
      ? {
          schema_version: 1,
          type: 'paper.command',
          run_id: runId,
          command_id: value.command_id,
          expected_state_version: value.expected_state_version,
          action: value.action as PaperCommandAction,
        }
      : undefined
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  allowed: string[],
): boolean {
  return (
    Object.keys(value).every((key) => allowed.includes(key)) &&
    allowed.slice(0, 3).every((key) => key in value)
  )
}

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase().replace(/^::ffff:/, '')
  if (normalized === '::1' || normalized === 'localhost') return true
  return isIP(normalized) === 4 && normalized.startsWith('127.')
}

function rejectUpgrade(socket: Socket, status: number, reason: string): void {
  if (socket.destroyed) return
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
  socket.destroy()
}
