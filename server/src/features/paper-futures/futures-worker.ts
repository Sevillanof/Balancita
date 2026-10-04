import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

const PROTOCOL_VERSION = 1
const MAX_LINE_BYTES = 1_048_576
const MAX_QUEUE = 32
const PYTHON_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../python',
)
const REPOSITORY_DIRECTORY = resolve(PYTHON_DIRECTORY, '..')

export interface FuturesWorkerRequest {
  readonly request_id: string
  readonly run_id: string
  readonly work_id: string
  readonly expected_state_version: number
  readonly checkpoint?: Record<string, unknown> | null
  readonly payload:
    | {
        readonly operation: 'round_trip'
        readonly cash_usd: string
        readonly leverage?: string
        readonly side: 'long' | 'short'
        readonly quantity_btc: string
        readonly entry_price: string
        readonly exit_price: string
        readonly opened_at_ms?: number
        readonly closed_at_ms?: number
      }
    | {
        readonly operation: 'futures_runtime.v1'
        readonly runtime_config: Record<string, unknown>
        readonly instrument: Record<string, unknown>
        readonly market_snapshot: Record<string, unknown>
        readonly control?: Record<string, unknown>
      }
    | {
        readonly operation: 'futures_runtime.v2'
        readonly runtime_config: Record<string, unknown>
        readonly instrument: Record<string, unknown>
        readonly market_snapshot: Record<string, unknown>
        readonly control?: Record<string, unknown>
      }
    | {
        readonly operation: 'futures_runtime.v3'
        readonly runtime_config: Record<string, unknown>
        readonly instrument: Record<string, unknown>
        readonly market_snapshot: Record<string, unknown>
        readonly control?: Record<string, unknown>
      }
}

export interface FuturesWorkerResult {
  readonly type: 'result'
  readonly protocol_version: 1
  readonly request_id: string
  readonly run_id: string
  readonly work_id: string
  readonly expected_state_version: number
  readonly applied_state_version: number
  readonly event_times_ms?:
    | {
        readonly opened_at_ms: number
        readonly closed_at_ms: number
      }
    | undefined
  readonly operation?:
    'futures_runtime.v1' | 'futures_runtime.v2' | 'futures_runtime.v3'
  readonly runtime_event_time_ms?: number
  readonly result: Record<string, unknown>
  readonly events: readonly Record<string, unknown>[]
  readonly runtime_output?: Record<string, unknown>
  readonly runtime_checkpoint?: Record<string, unknown>
  readonly runtime_funding_events?: readonly Record<string, unknown>[]
}

export interface FuturesWorkerCommit {
  readonly status: 'committed' | 'superseded'
  readonly applied_state_version: number
  readonly result_hash: string
}

interface Pending {
  readonly request: FuturesWorkerRequest
  readonly resolve: (result: FuturesWorkerResult) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
  readonly enqueuedAt: number
  readonly wireLine: string
  result?: FuturesWorkerResult
  commit?: FuturesWorkerCommit
}

/** A bounded, single-flight JSONL process manager. Persistence remains Node-owned. */
export class FuturesWorker {
  private child: ChildProcessWithoutNullStreams | undefined
  private stdoutBuffer = Buffer.alloc(0)
  private stderr = ''
  private queue: Pending[] = []
  private active: Pending | undefined
  private starting: Promise<void> | undefined
  private closed = false
  private readonly timeoutMs: number
  private readonly observer:
    ((event: FuturesWorkerDiagnostic) => void) | undefined
  private readonly commitResult: (
    result: FuturesWorkerResult,
    request: FuturesWorkerRequest,
  ) => Promise<FuturesWorkerCommit>
  private readonly loopDelay:
    ReturnType<typeof monitorEventLoopDelay> | undefined
  private readonly sampler: NodeJS.Timeout | undefined

  constructor(options: {
    readonly timeoutMs?: number
    readonly maxQueue?: number
    readonly observer?: (event: FuturesWorkerDiagnostic) => void
    readonly eventLoopSampleIntervalMs?: number
    readonly commitResult: (
      result: FuturesWorkerResult,
      request: FuturesWorkerRequest,
    ) => Promise<FuturesWorkerCommit>
  }) {
    this.timeoutMs = options.timeoutMs ?? 10_000
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw new Error('Worker timeout must be a positive safe integer.')
    if (options.maxQueue !== undefined && options.maxQueue !== MAX_QUEUE)
      throw new Error(`Worker queue capacity is fixed at ${MAX_QUEUE}.`)
    this.commitResult = options.commitResult
    this.observer = options.observer
    if (options.eventLoopSampleIntervalMs !== undefined) {
      if (
        !Number.isSafeInteger(options.eventLoopSampleIntervalMs) ||
        options.eventLoopSampleIntervalMs < 10
      )
        throw new Error('Event-loop sample interval must be at least 10ms.')
      this.loopDelay = monitorEventLoopDelay({ resolution: 10 })
      this.loopDelay.enable()
      this.sampler = setInterval(() => {
        const delay = this.loopDelay!
        const memory = process.memoryUsage()
        const cpu = process.cpuUsage()
        if (this.observer)
          try {
            this.observer({
              phase: 'event_loop_sample',
              request_id: this.active?.request.request_id ?? 'worker',
              run_id: this.active?.request.run_id ?? 'worker',
              work_id: this.active?.request.work_id ?? 'worker',
              monotonic_ms: performance.now(),
              queue_count: this.queue.length,
              oldest_queue_age_ms: this.queue.length
                ? performance.now() - this.queue[0]!.enqueuedAt
                : 0,
              event_loop_delay_p50_ms: delay.percentile(50) / 1e6,
              event_loop_delay_p95_ms: delay.percentile(95) / 1e6,
              event_loop_delay_max_ms: delay.max / 1e6,
              event_loop_sample_count: delay.count,
              memory_usage: memory,
              cpu_usage: cpu,
              worker_pending_count:
                this.queue.length + Number(this.active !== undefined),
              worker_queue_depth: this.queue.length,
              worker_oldest_age_ms: this.queue.length
                ? performance.now() - this.queue[0]!.enqueuedAt
                : 0,
            })
          } catch {
            // Diagnostics must not interfere with worker processing.
          }
        delay.reset()
      }, options.eventLoopSampleIntervalMs)
      this.sampler.unref()
    }
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  submit(request: FuturesWorkerRequest): Promise<FuturesWorkerResult> {
    if (this.closed)
      return Promise.reject(new Error('Futures worker is closed.'))
    validateFuturesWorkerRequest(request)
    const serializedAt = performance.now()
    this.emitIdentity(request, 'serialization_start')
    const wireLine = JSON.stringify({
      type: 'work',
      protocol_version: PROTOCOL_VERSION,
      ...request,
    })
    const requestBytes = Buffer.byteLength(wireLine, 'utf8') + 1
    this.emitIdentity(request, 'serialization_end', {
      request_bytes: requestBytes,
      duration_ms: performance.now() - serializedAt,
    })
    if (requestBytes > MAX_LINE_BYTES)
      return Promise.reject(
        new Error('Futures worker request exceeds the JSONL line limit.'),
      )
    if (this.queue.length + Number(this.active !== undefined) >= MAX_QUEUE)
      return Promise.reject(new Error('Futures worker queue is full.'))
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        const index = this.queue.findIndex((item) => item.request === request)
        if (index >= 0) {
          const [expired] = this.queue.splice(index, 1)
          clearTimeout(expired!.timer)
          this.emit(expired!, 'queued_timeout', {
            queue_wait_ms: performance.now() - expired!.enqueuedAt,
          })
          rejectPromise(new Error('Futures worker request timed out in queue.'))
          return
        }
        if (this.active?.request === request) {
          this.emit(this.active, 'active_timeout', {
            duration_ms: performance.now() - this.active.enqueuedAt,
          })
          this.active = undefined
          this.child?.kill('SIGKILL')
          rejectPromise(new Error('Futures worker request timed out.'))
        }
      }, this.timeoutMs)
      this.queue.push({
        request,
        resolve: resolvePromise,
        reject: rejectPromise,
        timer,
        enqueuedAt: performance.now(),
        wireLine,
      })
      const item = this.queue.at(-1)!
      this.emit(item, 'enqueue')
      this.emit(item, 'serialization', {
        request_bytes: requestBytes,
        duration_ms: performance.now() - serializedAt,
      })
      void this.drain()
    })
  }

  async close(): Promise<void> {
    this.emitClose('closing_admission_begin')
    this.closed = true
    if (this.sampler) clearInterval(this.sampler)
    this.loopDelay?.disable()
    const pending = this.queue.splice(0)
    for (const item of pending) {
      clearTimeout(item.timer)
      item.reject(new Error('Futures worker closed before request was sent.'))
    }
    this.emitClose('closing_admission_end', {
      pending_request_ids: pending.map((item) => item.request.request_id),
      active_request_id: this.active?.request.request_id ?? null,
      pending_count: pending.length + Number(this.active !== undefined),
      oldest_pending_age_ms: this.oldestPendingAgeMs(),
    })
    if (!this.child) {
      this.emitClose('detached')
      this.emitClose('closed')
      return
    }
    const child = this.child
    if (this.active) {
      this.emitClose('active_termination', {
        signal_requested: 'SIGTERM',
        request_id: this.active.request.request_id,
      })
      child.kill('SIGTERM')
      this.active.reject(new Error('Futures worker closed during request.'))
      clearTimeout(this.active.timer)
      this.active = undefined
    } else {
      this.emitClose('request_shutdown', { protocol_request_id: 'shutdown' })
      this.child.stdin.write(
        `${JSON.stringify({
          type: 'shutdown',
          protocol_version: PROTOCOL_VERSION,
          request_id: 'shutdown',
          run_id: 'worker',
          work_id: 'shutdown',
        })}\n`,
      )
    }
    this.emitClose('wait_python_exit_begin', { worker_pid: child.pid })
    await new Promise<void>((resolvePromise) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        this.emitClose('wait_python_exit_end', {
          worker_pid: child.pid,
          exit_code: child.exitCode,
          signal: child.signalCode,
          forced: false,
          graceful: child.exitCode === 0 && child.signalCode === null,
        })
        return resolvePromise()
      }
      let forced = false
      const timeout = setTimeout(() => {
        forced = true
        this.emitClose('force_sigkill', { worker_pid: child.pid })
        child.kill('SIGKILL')
      }, 500)
      child.once('close', (code, signal) => {
        clearTimeout(timeout)
        this.emitClose('wait_python_exit_end', {
          worker_pid: child.pid,
          exit_code: code,
          signal,
          forced,
          graceful: !forced && code === 0 && signal === null,
        })
        resolvePromise()
      })
    })
    this.detach()
    this.emitClose('detached', { worker_pid: child.pid })
    this.emitClose('closed', { worker_pid: child.pid })
  }

  private async drain(): Promise<void> {
    if (this.active || this.queue.length === 0 || this.closed) return
    try {
      await this.start()
    } catch (error) {
      const queued = this.queue.splice(0)
      for (const item of queued) {
        clearTimeout(item.timer)
        item.reject(asError(error))
      }
      return
    }
    if (this.active || this.closed) return
    const child = this.child
    if (
      !child ||
      child.stdin.destroyed ||
      child.stdin.writableEnded ||
      !child.stdin.writable
    ) {
      const error = new Error(
        'Futures worker process is unavailable before request was sent.',
      )
      const queued = this.queue.splice(0)
      for (const item of queued) {
        clearTimeout(item.timer)
        this.emit(item, 'worker_error', { message: error.message })
        item.reject(error)
      }
      return
    }
    const item = this.queue.shift()
    if (!item) return
    this.active = item
    this.emit(item, 'send', {
      queue_wait_ms: performance.now() - item.enqueuedAt,
    })
    this.write(item, child.stdin, `${item.wireLine}\n`, 'stdin_write')
  }

  private start(): Promise<void> {
    if (this.child) return Promise.resolve()
    if (this.starting) return this.starting
    this.starting = new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(
        'python3',
        ['-m', 'balancita_engine.futures_worker'],
        {
          cwd: REPOSITORY_DIRECTORY,
          env: { ...process.env, PYTHONPATH: PYTHON_DIRECTORY },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
      this.child = child
      this.stderr = ''
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        rejectPromise(new Error('Futures worker handshake timed out.'))
      }, this.timeoutMs)
      this.stdoutBuffer = Buffer.alloc(0)
      child.stdout.on('data', (chunk: Buffer) => {
        if (this.active)
          this.emit(this.active, 'stdout_data', {
            chunk_bytes: chunk.length,
            readable_length: child.stdout.readableLength,
            readable_high_water_mark: child.stdout.readableHighWaterMark,
            readable_paused: child.stdout.isPaused(),
          })
        for (const line of this.readLines(chunk)) {
          if (this.active)
            this.emit(this.active, 'frame_complete', {
              frame_bytes: line.length + 1,
            })
          let message: unknown
          const parseStartedAt = performance.now()
          if (this.active) this.emit(this.active, 'json_parse_start')
          try {
            message = JSON.parse(line.toString('utf8'))
          } catch {
            child.kill('SIGKILL')
            return
          }
          if (this.active)
            this.emit(this.active, 'json_parse_end', {
              duration_ms: performance.now() - parseStartedAt,
            })
          if (!settled) {
            if (
              !isRecord(message) ||
              message.type !== 'ready' ||
              message.protocol_version !== PROTOCOL_VERSION
            ) {
              settled = true
              clearTimeout(timeout)
              rejectPromise(
                new Error(
                  'Futures worker handshake did not match protocol v1.',
                ),
              )
              child.kill('SIGKILL')
              return
            }
            settled = true
            clearTimeout(timeout)
            resolvePromise()
            continue
          }
          this.receive(message, performance.now() - parseStartedAt)
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8192)
      })
      child.stdin.on('error', (error) => this.failProcess(error))
      child.once('error', (error) => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          rejectPromise(
            new Error(
              `Could not start Python futures worker: ${error.message}`,
            ),
          )
        }
        this.failProcess(error)
      })
      child.once('close', (code, signal) => {
        if (!settled) {
          settled = true
          clearTimeout(timeout)
          rejectPromise(
            new Error(
              `Futures worker exited during handshake (${code ?? signal}).`,
            ),
          )
        }
        this.failProcess(
          new Error(
            `Futures worker exited (${code ?? signal}): ${this.stderr}`,
          ),
        )
      })
    }).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  private receive(message: unknown, parseDurationMs = 0): void {
    const active = this.active
    if (!active) {
      if (
        isRecord(message) &&
        message.type === 'shutdown' &&
        message.protocol_version === PROTOCOL_VERSION &&
        message.request_id === 'shutdown'
      )
        return
      this.child?.kill('SIGKILL')
      return
    }
    if (
      isRecord(message) &&
      message.type === 'error' &&
      message.request_id === active.request.request_id
    ) {
      this.active = undefined
      clearTimeout(active.timer)
      active.reject(
        new Error(`Futures worker rejected request: ${String(message.error)}`),
      )
      this.emit(active, 'worker_error')
      void this.drain()
      return
    }
    if (
      active.commit &&
      isCommittedAck(message, active.request, active.commit)
    ) {
      this.active = undefined
      this.emit(active, 'ack_received')
      clearTimeout(active.timer)
      active.resolve(active.result!)
      void this.drain()
      return
    }
    this.emit(active, 'schema_validation_start')
    if (
      !isResult(message, active.request) ||
      message.request_id !== active.request.request_id ||
      message.run_id !== active.request.run_id ||
      message.work_id !== active.request.work_id ||
      message.expected_state_version !==
        active.request.expected_state_version ||
      message.applied_state_version !==
        active.request.expected_state_version + 1
    ) {
      this.child?.kill('SIGKILL')
      return
    }
    this.emit(active, 'schema_validation_end')
    active.result = message
    this.emit(active, 'result_parse_validation', {
      duration_ms: parseDurationMs,
    })
    void this.commitAndAcknowledge(active, message)
  }

  private async commitAndAcknowledge(
    active: Pending,
    result: FuturesWorkerResult,
  ): Promise<void> {
    try {
      const commitStartedAt = performance.now()
      this.emit(active, 'commit_callback_start')
      const commit = await this.commitResult(result, active.request)
      this.emit(active, 'commit_callback_end', {
        duration_ms: performance.now() - commitStartedAt,
      })
      if (
        !['committed', 'superseded'].includes(commit.status) ||
        !Number.isSafeInteger(commit.applied_state_version) ||
        !/^[a-f0-9]{64}$/.test(commit.result_hash)
      )
        throw new Error('Node did not confirm a matching committed result.')
      active.commit = commit
      const ackLine = `${JSON.stringify({
        type: 'ack',
        status: commit.status,
        protocol_version: PROTOCOL_VERSION,
        request_id: result.request_id,
        run_id: result.run_id,
        work_id: result.work_id,
        applied_state_version: commit.applied_state_version,
        result_hash: commit.result_hash,
      })}\n`
      this.write(active, this.child!.stdin, ackLine, 'ack_write')
      this.emit(active, 'ack_sent')
    } catch (error) {
      this.active = undefined
      this.emit(active, 'worker_error', { message: asError(error).message })
      clearTimeout(active.timer)
      active.reject(asError(error))
      this.child?.kill('SIGKILL')
    }
  }

  private failProcess(error: Error): void {
    this.detach()
    const active = this.active
    if (active) {
      this.emit(active, 'worker_error', { message: error.message })
      clearTimeout(active.timer)
      this.active = undefined
      active.reject(error)
    }
    if (!this.closed) void this.drain()
  }

  private detach(): void {
    this.child = undefined
    this.stdoutBuffer = Buffer.alloc(0)
  }

  private emit(
    item: Pending,
    phase: string,
    details: Record<string, unknown> = {},
  ): void {
    if (!this.observer) return
    try {
      this.observer({
        phase,
        request_id: item.request.request_id,
        run_id: item.request.run_id,
        work_id: item.request.work_id,
        monotonic_ms: performance.now(),
        queue_count: this.queue.length,
        oldest_queue_age_ms: this.queue.length
          ? performance.now() - this.queue[0]!.enqueuedAt
          : 0,
        rss_bytes: process.memoryUsage().rss,
        ...details,
      })
    } catch {
      // Diagnostics must never interfere with worker or financial processing.
    }
  }

  private emitIdentity(
    request: FuturesWorkerRequest,
    phase: string,
    details: Record<string, unknown> = {},
  ): void {
    if (!this.observer) return
    try {
      this.observer({
        phase,
        request_id: request.request_id,
        run_id: request.run_id,
        work_id: request.work_id,
        monotonic_ms: performance.now(),
        queue_count: this.queue.length,
        oldest_queue_age_ms: this.queue.length
          ? performance.now() - this.queue[0]!.enqueuedAt
          : 0,
        rss_bytes: process.memoryUsage().rss,
        ...details,
      })
    } catch {
      // Diagnostics must never interfere with worker or financial processing.
    }
  }

  private oldestPendingAgeMs(): number {
    const oldest = this.queue[0] ?? this.active
    return oldest ? performance.now() - oldest.enqueuedAt : 0
  }

  private emitClose(
    phase: string,
    details: Record<string, unknown> = {},
  ): void {
    if (!this.observer) return
    try {
      this.observer({
        phase,
        request_id: 'worker',
        run_id: 'worker',
        work_id: 'close',
        monotonic_ms: performance.now(),
        queue_count: this.queue.length,
        oldest_queue_age_ms: this.oldestPendingAgeMs(),
        rss_bytes: process.memoryUsage().rss,
        ...details,
      })
    } catch {
      // Diagnostics must never interfere with worker processing.
    }
  }

  private write(
    item: Pending,
    stream: ChildProcessWithoutNullStreams['stdin'],
    data: string,
    phase: string,
  ): void {
    observeWorkerPipeWrite(
      stream,
      (event) => this.emit(item, event.phase, event),
      item.request,
      phase,
      data,
    )
  }

  private readLines(chunk: Buffer): Buffer[] {
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk])
    if (
      this.stdoutBuffer.length > MAX_LINE_BYTES &&
      this.stdoutBuffer.indexOf(10) < 0
    ) {
      this.child?.kill('SIGKILL')
      return []
    }
    const lines: Buffer[] = []
    let newline = this.stdoutBuffer.indexOf(10)
    while (newline >= 0) {
      if (newline > MAX_LINE_BYTES) {
        this.child?.kill('SIGKILL')
        return []
      }
      let line = this.stdoutBuffer.subarray(0, newline)
      if (line.at(-1) === 13) line = line.subarray(0, -1)
      lines.push(line)
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1)
      newline = this.stdoutBuffer.indexOf(10)
    }
    if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
      this.child?.kill('SIGKILL')
      return []
    }
    return lines
  }
}

export function observeWorkerPipeWrite(
  stream: Pick<
    ChildProcessWithoutNullStreams['stdin'],
    | 'write'
    | 'once'
    | 'writableLength'
    | 'writableNeedDrain'
    | 'writableHighWaterMark'
  >,
  emit: (event: Record<string, unknown> & { readonly phase: string }) => void,
  request: Pick<FuturesWorkerRequest, 'request_id' | 'run_id' | 'work_id'>,
  phase: string,
  data = '',
): void {
  const started = performance.now()
  const base = { ...request }
  const accepted = stream.write(data, () =>
    emit({
      ...base,
      phase: `${phase}_callback`,
      monotonic_ms: performance.now(),
      callback_duration_ms: performance.now() - started,
    }),
  )
  emit({
    ...base,
    phase: `${phase}_return`,
    monotonic_ms: performance.now(),
    write_return: accepted,
    writable_length: stream.writableLength,
    writable_need_drain: stream.writableNeedDrain,
    writable_high_water_mark: stream.writableHighWaterMark,
  })
  if (!accepted)
    stream.once('drain', () =>
      emit({
        ...base,
        phase: `${phase}_drain`,
        monotonic_ms: performance.now(),
        drain_duration_ms: performance.now() - started,
        writable_length: stream.writableLength,
        writable_need_drain: stream.writableNeedDrain,
      }),
    )
}

export interface FuturesWorkerDiagnostic {
  readonly phase: string
  readonly request_id: string
  readonly run_id: string
  readonly work_id: string
  readonly monotonic_ms: number
  readonly queue_count: number
  readonly oldest_queue_age_ms: number
  readonly rss_bytes?: number
  readonly [key: string]: unknown
}

export function validateFuturesWorkerRequest(
  request: FuturesWorkerRequest,
): void {
  if (
    !isRecord(request) ||
    Object.keys(request).sort().join(',') !==
      (request.checkpoint === undefined
        ? 'expected_state_version,payload,request_id,run_id,work_id'
        : 'checkpoint,expected_state_version,payload,request_id,run_id,work_id') ||
    !['request_id', 'run_id', 'work_id'].every(
      (key) =>
        typeof request[key as keyof FuturesWorkerRequest] === 'string' &&
        String(request[key as keyof FuturesWorkerRequest]).length > 0 &&
        String(request[key as keyof FuturesWorkerRequest]).length <= 128,
    )
  )
    throw new Error('Invalid worker request identity.')
  if (
    !Number.isSafeInteger(request.expected_state_version) ||
    request.expected_state_version < 0
  )
    throw new Error('Invalid expected state version.')
  if (
    request.checkpoint !== undefined &&
    request.checkpoint !== null &&
    (!isRecord(request.checkpoint) || !isJsonSafe(request.checkpoint))
  )
    throw new Error('Invalid worker checkpoint.')
  if (!isRecord(request.payload) || !validateWorkerPayload(request.payload))
    throw new Error('Invalid futures worker payload.')
}

function validateWorkerPayload(payload: Record<string, unknown>): boolean {
  if (
    payload.operation === 'futures_runtime.v1' ||
    payload.operation === 'futures_runtime.v2' ||
    payload.operation === 'futures_runtime.v3'
  ) {
    const allowed = [
      'operation',
      'runtime_config',
      'instrument',
      'market_snapshot',
      'control',
    ]
    if (Object.keys(payload).some((key) => !allowed.includes(key))) return false
    if (
      !isRecord(payload.runtime_config) ||
      !isRecord(payload.instrument) ||
      !isRecord(payload.market_snapshot)
    )
      return false
    const config = payload.runtime_config
    if (
      !hasExactKeys(
        config,
        [
          'version',
          'initial_cash_usd',
          'max_notional_usd',
          'max_exposure_multiple',
          'risk_fraction',
          'execution_latency_ms',
          'max_book_age_ms',
          'max_spread_bps',
          'cost_version',
          'maker_rate',
          'taker_rate',
        ],
        payload.operation === 'futures_runtime.v3'
          ? ['daily_loss_fraction']
          : [],
      ) ||
      ![
        'futures-runtime-lab.v1',
        'futures-runtime-strategies.v1',
        ...(payload.operation === 'futures_runtime.v2'
          ? ['futures-runtime-execution.v1']
          : payload.operation === 'futures_runtime.v3'
            ? ['futures-runtime-risk.v1']
            : []),
      ].includes(String(config.version)) ||
      config.cost_version !== 'kraken-futures-eea-btcusd-base.v1'
    )
      return false
    if (
      payload.operation === 'futures_runtime.v3' &&
      config.daily_loss_fraction !== '0.01'
    )
      return false
    for (const key of [
      'initial_cash_usd',
      'max_notional_usd',
      'max_exposure_multiple',
      'risk_fraction',
      'max_spread_bps',
      'maker_rate',
      'taker_rate',
    ])
      if (!isDecimalString(config[key])) return false
    for (const key of ['execution_latency_ms', 'max_book_age_ms'])
      if (
        !Number.isSafeInteger(config[key]) ||
        Number(config[key]) < 0 ||
        Number(config[key]) > 86_400_000
      )
        return false
    const instrument = payload.instrument
    if (
      !hasExactKeys(instrument, [
        'instrument_id',
        'provider_symbol',
        'quantity_step_btc',
        'minimum_quantity_btc',
        'price_tick_usd',
      ]) ||
      instrument.instrument_id !== 'kraken-futures:PF_XBTUSD' ||
      instrument.provider_symbol !== 'PF_XBTUSD'
    )
      return false
    for (const key of [
      'quantity_step_btc',
      'minimum_quantity_btc',
      'price_tick_usd',
    ])
      if (
        !isDecimalString(instrument[key]) ||
        String(instrument[key]).startsWith('-') ||
        /^0(?:\.0+)?$/.test(String(instrument[key]))
      )
        return false
    if (
      payload.control !== undefined &&
      (!isRecord(payload.control) ||
        (payload.operation === 'futures_runtime.v3'
          ? !hasExactKeys(payload.control, ['type'], ['command_id']) ||
            !['paper.close', 'paper.pause', 'paper.resume'].includes(
              String(payload.control.type),
            ) ||
            ('command_id' in payload.control &&
              (typeof payload.control.command_id !== 'string' ||
                payload.control.command_id.length < 1 ||
                payload.control.command_id.length > 128))
          : !hasExactKeys(payload.control, ['type', 'command_id']) ||
            payload.control.type !== 'paper.close' ||
            typeof payload.control.command_id !== 'string' ||
            payload.control.command_id.length < 1 ||
            payload.control.command_id.length > 128))
    )
      return false
    const market = payload.market_snapshot
    if (
      !hasExactKeys(market, [
        'mode',
        'instrument',
        'decision_time_ms',
        'cutoff_received_at_ms',
        'events',
      ]) ||
      !isRecord(market.instrument) ||
      !sameKeys(market.instrument, instrument) ||
      !Array.isArray(market.events) ||
      market.events.length > 100_000 ||
      !Number.isSafeInteger(market.decision_time_ms) ||
      !Number.isSafeInteger(market.cutoff_received_at_ms) ||
      Number(market.decision_time_ms) < 0 ||
      Number(market.cutoff_received_at_ms) < 0 ||
      Number(market.cutoff_received_at_ms) > Number(market.decision_time_ms) ||
      !['mock', 'replay', 'paper_live'].includes(String(market.mode)) ||
      !market.events.every(isRecord) ||
      !market.events.every(isValidFundingEvent) ||
      !isJsonSafe(market) ||
      Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_LINE_BYTES - 1024
    )
      return false
    return true
  }
  const allowed = [
    'operation',
    'cash_usd',
    'leverage',
    'side',
    'quantity_btc',
    'entry_price',
    'exit_price',
    'opened_at_ms',
    'closed_at_ms',
  ]
  if (
    Object.keys(payload).some((key) => !allowed.includes(key)) ||
    payload.operation !== 'round_trip'
  )
    return false
  if (
    !['cash_usd', 'quantity_btc', 'entry_price', 'exit_price'].every((key) =>
      isDecimalString(payload[key]),
    )
  )
    return false
  if (
    (payload.leverage !== undefined && typeof payload.leverage !== 'string') ||
    (payload.side !== 'long' && payload.side !== 'short')
  )
    return false
  return ['opened_at_ms', 'closed_at_ms'].every(
    (key) =>
      payload[key] === undefined ||
      (Number.isSafeInteger(payload[key]) && Number(payload[key]) >= 0),
  )
}

function isValidFundingEvent(event: Record<string, unknown>): boolean {
  if (event.type !== 'funding_observation') return true
  if (
    !hasExactKeys(
      event,
      ['type', 'received_at_ms', 'known_at_ms', 'observation'],
      ['id', 'event_time_ms', 'reception_order', 'epoch'],
    ) ||
    !Number.isSafeInteger(event.received_at_ms) ||
    !Number.isSafeInteger(event.known_at_ms) ||
    !isRecord(event.observation)
  )
    return false
  const observation = event.observation
  if (
    !hasExactKeys(
      observation,
      [
        'source',
        'provider',
        'product',
        'field',
        'raw_rate',
        'unit',
        'effective_start_ms',
        'effective_end_ms',
        'known_at_ms',
        'received_seq',
        'observation_id',
        'sha256',
        'semantic_version',
        'predicted',
      ],
      ['reference_price_usd_per_btc', 'reference_price_at_ms'],
    ) ||
    !['source', 'observation_id'].every(
      (key) => typeof observation[key] === 'string' && observation[key] !== '',
    ) ||
    observation.provider !== 'kraken' ||
    observation.product !== 'PF_XBTUSD' ||
    !['funding_rate', 'relative_funding_rate'].includes(
      String(observation.field),
    ) ||
    !isDecimalString(observation.raw_rate) ||
    ![
      'usd_per_btc_per_hour',
      'relative_per_hour',
      'provider-unresolved',
    ].includes(String(observation.unit)) ||
    (observation.unit !== 'provider-unresolved' &&
      ((observation.field === 'funding_rate' &&
        observation.unit !== 'usd_per_btc_per_hour') ||
        (observation.field === 'relative_funding_rate' &&
          observation.unit !== 'relative_per_hour'))) ||
    !Number.isSafeInteger(observation.known_at_ms) ||
    !Number.isSafeInteger(observation.received_seq) ||
    Number(observation.received_seq) < 0 ||
    typeof observation.predicted !== 'boolean' ||
    observation.semantic_version !== 'kraken-funding-normalization.v1' ||
    typeof observation.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(observation.sha256) ||
    'reference_price_usd_per_btc' in observation !==
      'reference_price_at_ms' in observation ||
    ('reference_price_usd_per_btc' in observation &&
      (!isDecimalString(observation.reference_price_usd_per_btc) ||
        !Number.isSafeInteger(observation.reference_price_at_ms)))
  )
    return false
  const start = observation.effective_start_ms
  const end = observation.effective_end_ms
  return (
    (start === null && end === null) ||
    (Number.isSafeInteger(start) &&
      Number.isSafeInteger(end) &&
      Number(end) > Number(start))
  )
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: string[],
  optional: string[] = [],
): boolean {
  const actual = Object.keys(value)
  return (
    keys.every((key) => actual.includes(key)) &&
    actual.every((key) => keys.includes(key) || optional.includes(key))
  )
}

function sameKeys(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return (
    hasExactKeys(left, Object.keys(right)) &&
    Object.keys(right).every((key) => left[key] === right[key])
  )
}

function isDecimalString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 128 &&
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  )
}

function isJsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 20) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true
  if (typeof value === 'number')
    return Number.isFinite(value) && Number.isSafeInteger(value)
  if (Array.isArray(value))
    return (
      value.length <= 100_000 &&
      value.every((item) => isJsonSafe(item, depth + 1))
    )
  return (
    isRecord(value) &&
    Object.keys(value).length <= 100 &&
    Object.values(value).every((item) => isJsonSafe(item, depth + 1))
  )
}

function isResult(
  value: unknown,
  request: FuturesWorkerRequest,
): value is FuturesWorkerResult {
  if (
    request.payload.operation === 'futures_runtime.v1' ||
    request.payload.operation === 'futures_runtime.v2' ||
    request.payload.operation === 'futures_runtime.v3'
  )
    return (
      isRecord(value) &&
      value.type === 'result' &&
      value.protocol_version === PROTOCOL_VERSION &&
      value.operation === request.payload.operation &&
      value.request_id === request.request_id &&
      value.run_id === request.run_id &&
      value.work_id === request.work_id &&
      value.expected_state_version === request.expected_state_version &&
      value.applied_state_version === request.expected_state_version + 1 &&
      Number.isSafeInteger(value.runtime_event_time_ms) &&
      isRecord(value.result) &&
      Array.isArray(value.events) &&
      value.events.every(isRecord) &&
      isRecord(value.runtime_output) &&
      isRecord(value.runtime_checkpoint) &&
      Array.isArray(value.runtime_funding_events) &&
      value.runtime_funding_events.every(isRecord)
    )
  return (
    isRecord(value) &&
    value.type === 'result' &&
    value.protocol_version === PROTOCOL_VERSION &&
    typeof value.request_id === 'string' &&
    typeof value.run_id === 'string' &&
    typeof value.work_id === 'string' &&
    Number.isSafeInteger(value.expected_state_version) &&
    Number.isSafeInteger(value.applied_state_version) &&
    isRecord(value.event_times_ms) &&
    Number.isSafeInteger(value.event_times_ms.opened_at_ms) &&
    Number.isSafeInteger(value.event_times_ms.closed_at_ms) &&
    isRecord(value.result) &&
    Array.isArray(value.events) &&
    value.events.every(isRecord) &&
    value.operation === undefined
  )
}

function isCommittedAck(
  value: unknown,
  request: FuturesWorkerRequest,
  commit: FuturesWorkerCommit,
): boolean {
  return (
    isRecord(value) &&
    value.type === 'ack' &&
    value.status === commit.status &&
    value.protocol_version === PROTOCOL_VERSION &&
    value.request_id === request.request_id &&
    value.run_id === request.run_id &&
    value.work_id === request.work_id &&
    value.applied_state_version === commit.applied_state_version &&
    value.result_hash === commit.result_hash
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
