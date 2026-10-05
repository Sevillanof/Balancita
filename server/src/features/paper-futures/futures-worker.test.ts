import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { createHash } from 'node:crypto'
import type { spawn } from 'node:child_process'
import {
  FuturesWorker,
  type FuturesWorkerDiagnostic,
  observeWorkerPipeWrite,
  validateFuturesWorkerRequest,
} from './futures-worker.ts'

describe('FuturesWorker', () => {
  it('records deterministic false-write, callback, and drain backpressure timing', () => {
    class ControlledPipe extends EventEmitter {
      writableLength = 9
      writableNeedDrain = true
      writableHighWaterMark = 8
      write(_data: string, callback: () => void) {
        callback()
        return false
      }
    }
    const pipe = new ControlledPipe()
    const events: Array<Record<string, unknown>> = []
    observeWorkerPipeWrite(
      pipe as unknown as Parameters<typeof observeWorkerPipeWrite>[0],
      (event) => events.push(event),
      {
        request_id: 'backpressure-request',
        run_id: 'run-fixture',
        work_id: 'backpressure-work',
      },
      'request_write',
    )
    pipe.emit('drain')
    expect(events.map((event) => event.phase)).toEqual([
      'request_write_callback',
      'request_write_return',
      'request_write_drain',
    ])
    expect(events[1]).toMatchObject({
      write_return: false,
      writable_length: 9,
      writable_need_drain: true,
    })
    expect(events[2]).toMatchObject({
      request_id: 'backpressure-request',
      drain_duration_ms: expect.any(Number),
    })
  })

  it('counts transmitted UTF-8 payload bytes including the JSONL newline', () => {
    class ControlledPipe extends EventEmitter {
      writableLength = 0
      writableNeedDrain = false
      writableHighWaterMark = 8
      write(_data: string, callback: () => void) {
        callback()
        return true
      }
    }
    const events: Array<Record<string, unknown>> = []
    observeWorkerPipeWrite(
      new ControlledPipe() as unknown as Parameters<
        typeof observeWorkerPipeWrite
      >[0],
      (event) => events.push(event),
      { request_id: 'ack-request', run_id: 'run-fixture', work_id: 'ack-work' },
      'ack_write',
      '{"value":"€"}\n',
    )
    expect(events[0]).toMatchObject({
      phase: 'ack_write_callback',
      payload_bytes: Buffer.byteLength('{"value":"€"}\n', 'utf8'),
      payload_bytes_include_newline: true,
    })
  })

  it('rejects untyped funding provenance before worker submission', () => {
    const request = normalizedFundingRequest()
    request.payload.market_snapshot.events[0]!.observation.unit = 'unknown'
    expect(() => validateFuturesWorkerRequest(request)).toThrow(/payload/)
  })

  it('accepts explicitly unresolved funding without inventing an interval', () => {
    const request = normalizedFundingRequest()
    const observation = request.payload.market_snapshot.events[0]!
      .observation as unknown as Record<string, unknown>
    observation.unit = 'provider-unresolved'
    observation.effective_start_ms = null
    observation.effective_end_ms = null
    expect(() => validateFuturesWorkerRequest(request)).not.toThrow()
  })

  it('continues to reject oversized arbitrary checkpoint objects', () => {
    const request = {
      ...normalizedFundingRequest(),
      checkpoint: Object.fromEntries(
        Array.from({ length: 101 }, (_, index) => [`key-${index}`, 'value']),
      ),
    }
    expect(() => validateFuturesWorkerRequest(request)).toThrow(
      'Invalid worker checkpoint.',
    )
  })

  it('uses one persistent Python process for ordered ledger requests', async () => {
    const committed: string[] = []
    const worker = new FuturesWorker({
      commitResult: async (result) => {
        committed.push(result.work_id)
        return {
          status: 'committed',
          applied_state_version: result.applied_state_version,
          result_hash: 'a'.repeat(64),
        }
      },
    })
    try {
      const first = worker.submit(request('request-1', 'work-1', 'long'))
      const pid = worker.pid
      const second = worker.submit(request('request-2', 'work-2', 'short'))
      const [long, short] = await Promise.all([first, second])

      expect(pid).toBeDefined()
      expect(worker.pid).toBe(pid)
      expect(long.result.realized_net_complete).toBe('0.09895')
      expect(short.result.realized_net_complete).toBe('0.09905')
      expect(long.events.map((event) => event.type)).toEqual(['open', 'close'])
      expect(short.events.map((event) => event.type)).toEqual(['open', 'close'])
      expect(committed).toEqual(['work-1', 'work-2'])
    } finally {
      await worker.close()
    }
    await expect(
      worker.submit(request('after-close', 'work-3', 'long')),
    ).rejects.toThrow(/closed/)
  })

  it('binds an in-job query, waits for its host reply, and isolates queued work through commit ACK', async () => {
    const order: string[] = []
    const diagnostics: FuturesWorkerDiagnostic[] = []
    let releaseLookup!: (value: readonly unknown[]) => void
    const lookupBarrier = new Promise<readonly unknown[]>((resolve) => {
      releaseLookup = resolve
    })
    const worker = new FuturesWorker({
      spawnProcess: fakeQueryWorker(order) as typeof spawn,
      observer: (event) => diagnostics.push(event),
      identityLookup: async (boundRequest, query) => {
        order.push(`lookup:${boundRequest.work_id}:${query.query_sequence}`)
        expect(Object.isFrozen(boundRequest)).toBe(true)
        if (boundRequest.work_id === 'rpc-work-1') {
          expect(boundRequest.work_id).toBe('rpc-work-1')
          expect(query.source_frontier).toBe(7)
          expect(query.checkpoint_hash).toBe(
            createHash('sha256')
              .update('{"market_context_checkpoint":{"current_frontier":7}}')
              .digest('hex'),
          )
        }
        return lookupBarrier
      },
      commitResult: async (result, boundRequest) => {
        order.push(`commit:${boundRequest.work_id}`)
        return {
          status: 'committed',
          applied_state_version: result.applied_state_version,
          result_hash: 'a'.repeat(64),
        }
      },
    })
    const firstRequest = {
      ...request('rpc-request-1', 'rpc-work-1', 'long'),
      checkpoint: { market_context_checkpoint: { current_frontier: 7 } },
    }
    const first = worker.submit(firstRequest)
    firstRequest.work_id = 'caller-mutated-after-submit'
    const second = worker.submit(
      request('rpc-request-2', 'rpc-work-2', 'short'),
    )
    await vi.waitFor(() => expect(order).toContain('lookup:rpc-work-1:1'))
    expect(order).not.toContain('commit:rpc-work-1')
    expect(order).not.toContain('lookup:rpc-work-2:1')
    releaseLookup([null])
    await Promise.all([first, second])
    expect(order).toEqual([
      'work:rpc-work-1',
      'lookup:rpc-work-1:1',
      'commit:rpc-work-1',
      'ack:rpc-work-1',
      'work:rpc-work-2',
      'lookup:rpc-work-2:1',
      'commit:rpc-work-2',
      'ack:rpc-work-2',
    ])
    expect(
      diagnostics.filter((event) => event.phase === 'identity_query_received'),
    ).toHaveLength(2)
    expect(
      diagnostics.filter((event) => event.phase === 'identity_reply_ready'),
    ).toHaveLength(2)
    expect(
      diagnostics
        .filter((event) => event.phase === 'identity_query_received')
        .every((event) => Number(event.query_bytes) > 0),
    ).toBe(true)
    expect(
      diagnostics
        .filter((event) => event.phase === 'identity_reply_ready')
        .every((event) => Number(event.reply_bytes) > 0),
    ).toBe(true)
    await worker.close()
  })

  it.each([
    ['foreign run', { run_id: 'foreign-run' }],
    ['foreign work', { work_id: 'foreign-work' }],
    ['foreign version', { expected_state_version: 1 }],
    ['foreign checkpoint hash', { checkpoint_hash: 'b'.repeat(64) }],
    ['foreign source frontier', { source_frontier: 1 }],
    ['future knowledge cutoff', { knowledge_cutoff_ms: 1 }],
    ['out-of-order sequence', { query_sequence: 2 }],
  ])('rejects %s without host lookup or commit', async (_case, override) => {
    const order: string[] = []
    const lookup = vi.fn(async () => [])
    const worker = new FuturesWorker({
      spawnProcess: fakeQueryWorker(order, override) as typeof spawn,
      identityLookup: lookup,
      commitResult: async () => {
        order.push('commit')
        throw new Error('must not commit')
      },
      timeoutMs: 1_000,
    })
    await expect(
      worker.submit(request('foreign-rpc-request', 'foreign-rpc-work', 'long')),
    ).rejects.toThrow()
    expect(lookup).not.toHaveBeenCalled()
    expect(order).not.toContain('commit')
    await worker.close()
  })

  it('returns typed unavailable when the host lookup fails and never treats it as absence', async () => {
    const order: string[] = []
    const worker = new FuturesWorker({
      spawnProcess: fakeQueryWorker(order),
      identityLookup: async () => {
        throw new Error('read failure')
      },
      commitResult: async () => {
        order.push('commit')
        throw new Error('must not commit')
      },
    })
    await expect(
      worker.submit(request('unavailable-rpc', 'unavailable-work', 'long')),
    ).rejects.toThrow(/rejected request/)
    expect(order).not.toContain('commit')
    expect(order).toContain('typed-unavailable')
    await worker.close()
  })

  it('keeps identity queries disabled for legacy workers without a trusted callback', async () => {
    const order: string[] = []
    const worker = new FuturesWorker({
      spawnProcess: fakeQueryWorker(order) as typeof spawn,
      commitResult: async () => {
        order.push('commit')
        throw new Error('legacy query must not commit')
      },
    })
    await expect(
      worker.submit(request('disabled-rpc', 'disabled-work', 'long')),
    ).rejects.toThrow()
    expect(order).not.toContain('commit')
    await worker.close()
  })

  it('keeps identity queries disabled for requests outside the trusted scope', async () => {
    const order: string[] = []
    const lookup = vi.fn(async () => [null] as readonly unknown[])
    const worker = new FuturesWorker({
      spawnProcess: fakeQueryWorker(order) as typeof spawn,
      identityLookup: lookup,
      identityScope: () => false,
      commitResult: async () => {
        order.push('commit')
        throw new Error('out-of-scope query must not commit')
      },
    })
    await expect(
      worker.submit(request('scoped-rpc', 'scoped-work', 'long')),
    ).rejects.toThrow()
    expect(lookup).not.toHaveBeenCalled()
    expect(order).not.toContain('commit')
    await worker.close()
  })

  it('aborts an in-flight read-only lookup when the worker closes', async () => {
    const order: string[] = []
    let receivedSignal: AbortSignal | undefined
    const worker = new FuturesWorker({
      spawnProcess: fakeQueryWorker(order) as typeof spawn,
      identityLookup: async (_request, _query, signal) => {
        receivedSignal = signal
        return new Promise(() => {})
      },
      commitResult: async () => {
        throw new Error('must not commit')
      },
    })
    const pending = worker.submit(
      request('close-rpc-request', 'close-rpc-work', 'long'),
    )
    void pending.catch(() => {})
    await vi.waitFor(() => expect(receivedSignal).toBeDefined())
    await worker.close()
    expect(receivedSignal?.aborted).toBe(true)
    await expect(pending).rejects.toThrow(/closed during request/)
  })

  it('rejects accepted requests explicitly when the child disappears after start', async () => {
    const worker = new FuturesWorker({
      commitResult: async () => {
        throw new Error('unexpected commit')
      },
    })
    vi.spyOn(
      worker as unknown as { start: () => Promise<void> },
      'start',
    ).mockImplementation(async () => {
      ;(worker as unknown as { child: undefined }).child = undefined
    })

    await expect(
      worker.submit(request('vanished-request', 'vanished-work', 'long')),
    ).rejects.toThrow(
      'Futures worker process is unavailable before request was sent.',
    )
    await worker.close()
  })

  it('emits correlated worker phase diagnostics without affecting completion', async () => {
    const events: Array<Record<string, unknown>> = []
    const worker = new FuturesWorker({
      observer: (event) => events.push(event),
      commitResult: async (result) => ({
        status: 'committed',
        applied_state_version: result.applied_state_version,
        result_hash: 'd'.repeat(64),
      }),
    })
    try {
      await worker.submit(
        request('diagnostic-request', 'diagnostic-work', 'long'),
      )
    } finally {
      await worker.close()
    }
    expect(events.map((event) => event.phase)).toEqual(
      expect.arrayContaining([
        'serialization_start',
        'serialization_end',
        'stdin_write_return',
        'stdin_write_callback',
        'stdout_data',
        'frame_complete',
        'json_parse_start',
        'json_parse_end',
        'schema_validation_start',
        'schema_validation_end',
        'ack_write_return',
      ]),
    )
    expect(
      events.find((event) => event.phase === 'stdin_write_return'),
    ).toMatchObject({
      request_id: 'diagnostic-request',
      write_return: expect.any(Boolean),
      writable_length: expect.any(Number),
      writable_high_water_mark: expect.any(Number),
    })
    expect(events.some((event) => event.phase === 'stdin_write_return')).toBe(
      true,
    )
    expect(events.some((event) => event.phase === 'stdout_data')).toBe(true)
    expect(events.some((event) => event.phase === 'frame_complete')).toBe(true)
    expect(
      events.every(
        (event) =>
          (typeof event.phase === 'string' &&
            (event.phase.startsWith('closing_') ||
              event.phase.startsWith('wait_python_'))) ||
          event.phase === 'request_shutdown' ||
          event.phase === 'detached' ||
          event.phase === 'closed' ||
          (event.request_id === 'diagnostic-request' &&
            event.run_id === 'run-fixture' &&
            event.work_id === 'diagnostic-work' &&
            typeof event.monotonic_ms === 'number' &&
            typeof event.queue_count === 'number' &&
            typeof event.rss_bytes === 'number'),
      ),
    ).toBe(true)
  })

  it('reports shutdown phases and confirmed Python process exit', async () => {
    const events: Array<Record<string, unknown>> = []
    const worker = new FuturesWorker({
      observer: (event) => events.push(event),
      commitResult: async (result) => ({
        status: 'committed',
        applied_state_version: result.applied_state_version,
        result_hash: 'd'.repeat(64),
      }),
    })
    await worker.submit(request('close-request', 'close-work', 'long'))
    const pid = worker.pid
    expect(pid).toBeDefined()
    await worker.close()
    expect(events.map((event) => event.phase)).toEqual(
      expect.arrayContaining([
        'closing_admission_begin',
        'closing_admission_end',
        'request_shutdown',
        'wait_python_exit_begin',
        'wait_python_exit_end',
        'detached',
      ]),
    )
    expect(
      events.find((event) => event.phase === 'wait_python_exit_begin'),
    ).toMatchObject({
      worker_pid: pid,
    })
    expect(
      events.find((event) => event.phase === 'wait_python_exit_end'),
    ).toMatchObject({
      worker_pid: pid,
      exit_code: 0,
      signal: null,
    })
  })

  it('reports forced shutdown when the active child ignores SIGTERM', async () => {
    const events: Array<Record<string, unknown>> = []
    let commitStarted!: () => void
    const started = new Promise<void>((resolve) => {
      commitStarted = resolve
    })
    const worker = new FuturesWorker({
      observer: (event) => events.push(event),
      commitResult: async () => {
        commitStarted()
        return new Promise(() => {})
      },
    })
    const requestPromise = worker.submit(
      request('stalled-close-request', 'stalled-close-work', 'long'),
    )
    void requestPromise.catch(() => {})
    await started
    const child = (
      worker as unknown as {
        child: { kill: (signal: NodeJS.Signals) => boolean }
      }
    ).child
    const kill = child.kill.bind(child)
    child.kill = (signal) => signal === 'SIGTERM' || kill(signal)

    await worker.close()

    expect(events.map((event) => event.phase)).toContain('force_sigkill')
    expect(
      events.find((event) => event.phase === 'wait_python_exit_end'),
    ).toMatchObject({
      forced: true,
      graceful: false,
      signal: 'SIGKILL',
    })
  })

  it('samples event-loop and worker state only when opted in and clears on close', async () => {
    const events: Array<Record<string, unknown>> = []
    const worker = new FuturesWorker({
      eventLoopSampleIntervalMs: 10,
      observer: (event) => events.push(event),
      commitResult: async (result) => ({
        status: 'committed',
        applied_state_version: result.applied_state_version,
        result_hash: 'f'.repeat(64),
      }),
    })
    await worker.submit(request('sample-request', 'sample-work', 'long'))
    await worker.close()
    expect(events.some((event) => event.phase === 'event_loop_sample')).toBe(
      true,
    )
    expect(
      events.find((event) => event.phase === 'event_loop_sample'),
    ).toMatchObject({
      event_loop_sample_count: expect.any(Number),
      event_loop_delay_p95_ms: expect.any(Number),
      worker_pending_count: expect.any(Number),
    })
  })

  it('ignores observer exceptions and emits active timeout diagnostics', async () => {
    const events: Array<Record<string, unknown>> = []
    const originalSetTimeout = globalThis.setTimeout
    let requestTimeout!: () => void
    const setTimeoutSpy = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation(((
        handler: Parameters<typeof setTimeout>[0],
        timeout?: number,
      ) => {
        const timer = originalSetTimeout(handler, timeout)
        if (!requestTimeout && timeout === 5_000)
          requestTimeout = () => handler()
        return timer
      }) as typeof setTimeout)
    const worker = new FuturesWorker({
      timeoutMs: 5_000,
      observer: (event) => {
        events.push(event)
        if (event.phase === 'send') requestTimeout()
        throw new Error('observer failure')
      },
      commitResult: async (result) => {
        return {
          status: 'committed',
          applied_state_version: result.applied_state_version,
          result_hash: 'e'.repeat(64),
        }
      },
    })
    try {
      await expect(
        worker.submit(request('timeout-request', 'timeout-work', 'long')),
      ).rejects.toThrow(/timed out/)
    } finally {
      setTimeoutSpy.mockRestore()
      await worker.close()
    }
    expect(events.some((event) => event.phase === 'active_timeout')).toBe(true)
    expect(events.some((event) => event.phase === 'queued_timeout')).toBe(false)
  })

  it('rejects invalid identity and state version before writing to the process', async () => {
    const worker = new FuturesWorker({
      commitResult: async (result) => ({
        status: 'committed',
        applied_state_version: result.applied_state_version,
        result_hash: 'b'.repeat(64),
      }),
    })
    expect(() =>
      worker.submit({
        ...request('bad', 'work-bad', 'long'),
        expected_state_version: -1,
      }),
    ).toThrow(/version/)
    await worker.close()
  })

  it('enforces a fixed bounded queue instead of silently dropping accepted work', async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const worker = new FuturesWorker({
      timeoutMs: 30_000,
      commitResult: async (result) => {
        await barrier
        return {
          status: 'committed',
          applied_state_version: result.applied_state_version,
          result_hash: 'c'.repeat(64),
        }
      },
    })
    const accepted = Array.from({ length: 32 }, (_, index) =>
      worker.submit(
        request(`bounded-${index}`, `bounded-work-${index}`, 'long'),
      ),
    )
    await expect(
      worker.submit(
        request('bounded-overflow', 'bounded-work-overflow', 'long'),
      ),
    ).rejects.toThrow(/queue is full/)
    release()
    await Promise.all(accepted)
    await worker.close()
  })
})

function normalizedFundingRequest() {
  const instrument = {
    instrument_id: 'kraken-futures:PF_XBTUSD',
    provider_symbol: 'PF_XBTUSD',
    quantity_step_btc: '0.0001',
    minimum_quantity_btc: '0.0001',
    price_tick_usd: '1',
  }
  return {
    request_id: 'funding-request',
    run_id: 'funding-run',
    work_id: 'funding-work',
    expected_state_version: 0,
    payload: {
      operation: 'futures_runtime.v3' as const,
      runtime_config: {
        version: 'futures-runtime-risk.v1',
        initial_cash_usd: '10000',
        max_notional_usd: '1000',
        max_exposure_multiple: '1',
        risk_fraction: '0.001',
        execution_latency_ms: 100,
        max_book_age_ms: 3000,
        max_spread_bps: '5',
        cost_version: 'kraken-futures-eea-btcusd-base.v1',
        maker_rate: '0.0002',
        taker_rate: '0.0005',
        daily_loss_fraction: '0.01',
      },
      instrument,
      market_snapshot: {
        mode: 'mock',
        instrument,
        decision_time_ms: 1000,
        cutoff_received_at_ms: 1000,
        events: [
          {
            type: 'funding_observation',
            received_at_ms: 0,
            known_at_ms: 0,
            observation: {
              source: 'fixture',
              provider: 'kraken',
              product: 'PF_XBTUSD',
              field: 'funding_rate',
              raw_rate: '0.0001',
              unit: 'usd_per_btc_per_hour',
              effective_start_ms: 0,
              effective_end_ms: 3_600_000,
              known_at_ms: 0,
              received_seq: 1,
              observation_id: 'funding-1',
              sha256: 'a'.repeat(64),
              semantic_version: 'kraken-funding-normalization.v1',
              predicted: false,
            },
          },
        ],
      },
    },
  }
}

function fakeQueryWorker(
  order: string[],
  override: Record<string, unknown> = {},
) {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough
      stderr: PassThrough
      pid: number
      exitCode: number | null
      signalCode: NodeJS.Signals | null
      stdin: Writable
      kill: (signal: NodeJS.Signals) => boolean
    }
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    child.stdout = stdout
    child.stderr = stderr
    child.pid = 777
    child.exitCode = null
    child.signalCode = null
    child.kill = (signal: NodeJS.Signals) => {
      child.signalCode = signal
      child.exitCode = signal === 'SIGKILL' ? null : 0
      setImmediate(() => child.emit('close', child.exitCode, signal))
      return true
    }
    let pendingQuery: Record<string, unknown> | undefined
    child.stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        const message = JSON.parse(chunk.toString('utf8')) as Record<
          string,
          unknown
        >
        const checkpoint = message.checkpoint as
          | { market_context_checkpoint?: { current_frontier?: number } }
          | undefined
        if (message.type === 'work') {
          order.push(`work:${message.work_id}`)
          const query = {
            type: 'identity_query',
            protocol_version: 1,
            request_id: message.request_id,
            run_id: message.run_id,
            work_id: message.work_id,
            expected_state_version: message.expected_state_version,
            checkpoint_hash: createHash('sha256')
              .update(JSON.stringify(message.checkpoint ?? null))
              .digest('hex'),
            source_frontier:
              checkpoint?.market_context_checkpoint?.current_frontier ?? 0,
            query_sequence: 1,
            operation: 'lookup',
            kind: 'order',
            keys: ['fixture-order'],
            knowledge_cutoff_ms: 0,
            ...override,
          }
          pendingQuery = query
          setImmediate(() => stdout.write(`${JSON.stringify(query)}\n`))
        } else if (message.type === 'identity_reply') {
          if (
            !pendingQuery ||
            Object.keys(message).sort().join(',') !==
              [
                ...Object.keys(pendingQuery),
                'status',
                ...(message.status === 'ok' ? ['values'] : []),
              ]
                .sort()
                .join(',') ||
            Object.keys(pendingQuery).some(
              (key) =>
                JSON.stringify(message[key]) !==
                JSON.stringify(
                  key === 'type' ? 'identity_reply' : pendingQuery![key],
                ),
            )
          ) {
            order.push('reply-echo-mismatch')
            callback(new Error('reply did not echo query'))
            return
          }
          if (message.status === 'unavailable') {
            order.push('typed-unavailable')
            setImmediate(() =>
              stdout.write(
                `${JSON.stringify({ type: 'error', request_id: message.request_id, error: 'identity_unavailable' })}\n`,
              ),
            )
          } else {
            const result = {
              type: 'result',
              protocol_version: 1,
              request_id: message.request_id,
              run_id: message.run_id,
              work_id: message.work_id,
              expected_state_version: message.expected_state_version,
              applied_state_version: Number(message.expected_state_version) + 1,
              event_times_ms: { opened_at_ms: 0, closed_at_ms: 0 },
              result: { realized_net_complete: '0' },
              events: [],
            }
            setImmediate(() => stdout.write(`${JSON.stringify(result)}\n`))
          }
        } else if (message.type === 'ack') {
          order.push(`ack:${message.work_id}`)
          setImmediate(() =>
            stdout.write(`${JSON.stringify({ ...message, type: 'ack' })}\n`),
          )
        } else if (message.type === 'shutdown') {
          setImmediate(() => {
            stdout.write(
              `${JSON.stringify({ type: 'shutdown', protocol_version: 1, request_id: 'shutdown' })}\n`,
            )
            child.exitCode = 0
            child.emit('close', 0, null)
          })
        }
        callback()
      },
    })
    setImmediate(() => stdout.write('{"type":"ready","protocol_version":1}\n'))
    return child
  }) as unknown as typeof spawn
}

function request(requestId: string, workId: string, side: 'long' | 'short') {
  return {
    request_id: requestId,
    run_id: 'run-fixture',
    work_id: workId,
    expected_state_version: 0,
    payload: {
      operation: 'round_trip' as const,
      cash_usd: '1000',
      side,
      quantity_btc: '0.01',
      entry_price: '100',
      exit_price: side === 'long' ? '110' : '90',
    },
  }
}
