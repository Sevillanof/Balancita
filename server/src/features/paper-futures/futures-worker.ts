import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  readonly operation?: 'futures_runtime.v1'
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
  private readonly commitResult: (
    result: FuturesWorkerResult,
    request: FuturesWorkerRequest,
  ) => Promise<FuturesWorkerCommit>

  constructor(options: {
    readonly timeoutMs?: number
    readonly maxQueue?: number
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
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  submit(request: FuturesWorkerRequest): Promise<FuturesWorkerResult> {
    if (this.closed)
      return Promise.reject(new Error('Futures worker is closed.'))
    validateFuturesWorkerRequest(request)
    const wireLine = JSON.stringify({
      type: 'work',
      protocol_version: PROTOCOL_VERSION,
      ...request,
    })
    if (Buffer.byteLength(wireLine, 'utf8') + 1 > MAX_LINE_BYTES)
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
          rejectPromise(new Error('Futures worker request timed out in queue.'))
          return
        }
        if (this.active?.request === request) {
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
      })
      void this.drain()
    })
  }

  async close(): Promise<void> {
    this.closed = true
    const pending = this.queue.splice(0)
    for (const item of pending) {
      clearTimeout(item.timer)
      item.reject(new Error('Futures worker closed before request was sent.'))
    }
    if (!this.child) return
    if (this.active) {
      this.child.kill('SIGTERM')
      this.active.reject(new Error('Futures worker closed during request.'))
      clearTimeout(this.active.timer)
      this.active = undefined
    } else {
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
    await new Promise<void>((resolvePromise) => {
      const child = this.child
      if (!child || child.exitCode !== null) return resolvePromise()
      const timeout = setTimeout(() => child.kill('SIGKILL'), 500)
      child.once('close', () => {
        clearTimeout(timeout)
        resolvePromise()
      })
    })
    this.detach()
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
    const item = this.queue.shift()
    if (!item) return
    this.active = item
    this.child!.stdin.write(
      `${JSON.stringify({
        type: 'work',
        protocol_version: PROTOCOL_VERSION,
        ...item.request,
      })}\n`,
    )
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
        for (const line of this.readLines(chunk)) {
          let message: unknown
          try {
            message = JSON.parse(line.toString('utf8'))
          } catch {
            child.kill('SIGKILL')
            return
          }
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
          this.receive(message)
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

  private receive(message: unknown): void {
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
      void this.drain()
      return
    }
    if (
      active.commit &&
      isCommittedAck(message, active.request, active.commit)
    ) {
      this.active = undefined
      clearTimeout(active.timer)
      active.resolve(active.result!)
      void this.drain()
      return
    }
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
    active.result = message
    void this.commitAndAcknowledge(active, message)
  }

  private async commitAndAcknowledge(
    active: Pending,
    result: FuturesWorkerResult,
  ): Promise<void> {
    try {
      const commit = await this.commitResult(result, active.request)
      if (
        !['committed', 'superseded'].includes(commit.status) ||
        !Number.isSafeInteger(commit.applied_state_version) ||
        !/^[a-f0-9]{64}$/.test(commit.result_hash)
      )
        throw new Error('Node did not confirm a matching committed result.')
      active.commit = commit
      this.child!.stdin.write(
        `${JSON.stringify({
          type: 'ack',
          status: commit.status,
          protocol_version: PROTOCOL_VERSION,
          request_id: result.request_id,
          run_id: result.run_id,
          work_id: result.work_id,
          applied_state_version: commit.applied_state_version,
          result_hash: commit.result_hash,
        })}\n`,
      )
    } catch (error) {
      this.active = undefined
      clearTimeout(active.timer)
      active.reject(asError(error))
      this.child?.kill('SIGKILL')
    }
  }

  private failProcess(error: Error): void {
    this.detach()
    const active = this.active
    if (active) {
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
  if (payload.operation === 'futures_runtime.v1') {
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
      !hasExactKeys(config, [
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
      ]) ||
      config.version !== 'futures-runtime-lab.v1' ||
      config.cost_version !== 'kraken-futures-eea-btcusd-base.v1'
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
        !hasExactKeys(payload.control, ['type', 'command_id']) ||
        payload.control.type !== 'paper.close' ||
        typeof payload.control.command_id !== 'string' ||
        payload.control.command_id.length < 1 ||
        payload.control.command_id.length > 128)
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

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',')
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
  if (request.payload.operation === 'futures_runtime.v1')
    return (
      isRecord(value) &&
      value.type === 'result' &&
      value.protocol_version === PROTOCOL_VERSION &&
      value.operation === 'futures_runtime.v1' &&
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
