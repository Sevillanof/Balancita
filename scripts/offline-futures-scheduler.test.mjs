import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyReplayCompletion,
  createReplayScheduler,
  summarizeOfflineDiagnostics,
} from './offline-futures-scheduler.mjs'
import { closeOfflineChild } from './offline-futures-child-close.mjs'

describe('offline replay scheduler', () => {
  afterEach(() => vi.useRealTimers())

  it('closes the owned app and emits closed IPC using the app-close trace paths', async () => {
    const messages = []
    const closePhasesTracePath = '/owned/app-close-phases.jsonl'
    const workerTracePath = '/owned/worker-observer.jsonl'

    await closeOfflineChild({
      app: { close: vi.fn().mockResolvedValue(undefined) },
      closePhasesTracePath,
      workerTracePath,
      closeSourceState: { durable_pending_source_rows: 0 },
      readTraceEvents: vi.fn((path) => {
        expect([closePhasesTracePath, workerTracePath]).toContain(path)
        return [
          {
            phase: path === closePhasesTracePath ? 'close' : 'closed',
            state: 'end',
          },
        ]
      }),
      readLastTraceEvent: vi.fn(() => ({ source_received_seq: 0 })),
      sourceQueueTracePath: '/owned/app-source-queue.jsonl',
      send: (message) => messages.push(message),
      disconnect: vi.fn(),
    })

    expect(messages).toEqual([
      expect.objectContaining({
        type: 'closed',
        normal_close: true,
        app_resources_closed: true,
        worker_closed: true,
        durable_pending_source_rows: 0,
        final_source_queue: { source_received_seq: 0 },
      }),
    ])
  })

  it('preserves source order and schedules against monotonic receive offsets', () => {
    vi.useFakeTimers()
    const delivered = []
    const rows = [
      { received_at: 900 },
      { received_at: 925 },
      { received_at: 1200 },
    ]
    const scheduler = createReplayScheduler({
      rows,
      now: () => performance.now(),
      deliver: (row, timing) => delivered.push({ row, timing }),
    })

    vi.advanceTimersByTime(0)
    expect(delivered.map(({ row }) => row.received_at)).toEqual([900])
    vi.advanceTimersByTime(25)
    expect(delivered.map(({ row }) => row.received_at)).toEqual([900, 925])
    vi.advanceTimersByTime(275)
    expect(delivered.map(({ row }) => row.received_at)).toEqual([
      900, 925, 1200,
    ])
    expect(scheduler.complete).toBe(true)
    expect(delivered.map(({ timing }) => timing.due)).toEqual([0, 25, 300])
  })

  it.each([0.5, 1, 2])(
    'applies replay speed %s without reordering frames',
    async (speed) => {
      vi.useFakeTimers()
      const delivered = []
      const scheduler = createReplayScheduler({
        rows: [{ received_at: 100 }, { received_at: 120 }],
        speed,
        now: () => performance.now(),
        deliver: (row) => delivered.push(row.received_at),
      })
      await vi.advanceTimersByTimeAsync(20 / speed - 1)
      expect(delivered).toEqual([100])
      await vi.advanceTimersByTimeAsync(1)
      expect(delivered).toEqual([100, 120])
      expect(scheduler.complete).toBe(true)
    },
  )

  it('does not wait for a consumer and emits every frame on its deadline', async () => {
    vi.useFakeTimers()
    const delivered = []
    const scheduler = createReplayScheduler({
      rows: [{ received_at: 0 }, { received_at: 10 }, { received_at: 20 }],
      now: () => performance.now(),
      deliver: (row) => {
        delivered.push(row.received_at)
        return new Promise(() => {})
      },
    })
    await vi.advanceTimersByTimeAsync(20)
    expect(delivered).toEqual([0, 10, 20])
    expect(scheduler.processed).toBe(3)
  })

  it('does not report replay complete when close reports durable pending rows', () => {
    const closeMessage = {
      type: 'closed',
      source_count: 6195,
      source_watermark: 127,
      durable_pending_source_rows: 24,
      normal_close: true,
      child_process_closed: true,
      app_resources_closed: true,
      worker_closed: true,
      final_source_queue: {
        inspection_policy_bound: true,
        source_events_persisted: 6195,
        source_received_seq: 6195,
        last_inspected_source_seq: 127,
        last_financial_source_seq: 127,
        durable_source_backlog: 6068,
      },
    }

    expect(
      classifyReplayCompletion({
        closeMessage,
        processed: 6100,
        total: 6100,
      }),
    ).toMatchObject({
      outcome: 'stopped_deferred',
      processing_complete: false,
      delivery_complete: true,
      closed: true,
      durable_pending_source_rows: 6068,
      eligible_pending_source_rows: 24,
    })
    expect(
      classifyReplayCompletion({
        closeMessage: {
          ...closeMessage,
          source_count: 6195,
          source_watermark: 148,
          durable_pending_source_rows: 0,
          child_process_closed: true,
          child_exit_code: 0,
          child_signal_code: null,
          forced_termination: false,
          app_resources_closed: true,
          worker_closed: true,
          final_source_queue: {
            inspection_policy_bound: true,
            source_events_persisted: 6195,
            source_received_seq: 6195,
            last_inspected_source_seq: 6195,
            source_watermark: 148,
            last_financial_source_seq: 148,
            durable_source_backlog: 0,
            inspected_no_action_source_rows: 6047,
            financial_source_coverage_rows: 148,
            source_coverage_rows: 6195,
          },
        },
        processed: 6100,
        total: 6195,
      }),
    ).toMatchObject({
      outcome: 'source_complete',
      processing_complete: true,
      delivery_complete: false,
      durable_pending_source_rows: 0,
      normalized_source_events_persisted: 6195,
      source_watermark: 148,
      last_inspected_source_seq: 6195,
      last_financial_source_seq: 148,
      inspected_no_action_source_rows: 6047,
      financial_source_coverage_rows: 148,
      source_coverage_rows: 6195,
    })
    expect(
      classifyReplayCompletion({
        closeMessage: { type: 'closed', normal_close: true },
        processed: 6194,
        total: 6195,
      }),
    ).toMatchObject({
      outcome: 'unknown_processing',
      processing_complete: false,
      closed: true,
      durable_pending_source_rows: null,
    })
    expect(
      classifyReplayCompletion({
        closeMessage: {
          type: 'closed',
          normal_close: true,
          source_inspection_contract: 'futures-source-inspection.v1',
          final_source_queue: {
            inspection_policy_bound: true,
            source_events_persisted: 6195,
            source_received_seq: 6195,
            last_inspected_source_seq: null,
            durable_source_backlog: null,
          },
        },
        processed: 6100,
        total: 6100,
      }),
    ).toMatchObject({
      outcome: 'unknown_processing',
      processing_complete: false,
      delivery_complete: true,
      durable_pending_source_rows: null,
    })
  })

  it('keeps unknown processing distinct from complete frame delivery', () => {
    expect(
      classifyReplayCompletion({
        closeMessage: { type: 'closed', normal_close: true },
        processed: 6100,
        total: 6100,
      }),
    ).toMatchObject({
      delivery_complete: true,
      processing_complete: false,
      durable_pending_source_rows: null,
      eligible_pending_source_rows: null,
      outcome: 'unknown_processing',
    })
    expect(
      summarizeOfflineDiagnostics({
        workerEvents: [
          {
            request_id: 'work-1',
            phase: 'serialization_end',
            request_bytes: 41,
          },
          { request_id: 'work-1', phase: 'stdin_write_callback' },
          { request_id: 'work-1', phase: 'stdin_write_callback' },
          { request_id: 'work-1', phase: 'frame_complete', frame_bytes: 73 },
          { request_id: 'work-1', phase: 'ack_write_callback' },
          {
            request_id: 'work-1',
            phase: 'ack_write_callback',
            payload_bytes: 29,
          },
          {
            request_id: 'work-1',
            run_id: 'run-1',
            work_id: 'work-1',
            phase: 'strategy_work',
            strategy_selection_cycles: 1,
            strategy_evaluations: 4,
          },
        ],
        driverEvents: [
          {
            run_id: 'run-1',
            work_id: 'work-1',
            source_received_seq: 4,
            phase: 'receipt-materialize-hash',
            outcome: 'end',
          },
          {
            run_id: 'run-1',
            work_id: 'work-1',
            source_received_seq: 4,
            phase: 'receipt-materialize-hash',
            outcome: 'end',
          },
        ],
      }),
    ).toMatchObject({
      ipc_request_wire_bytes: 41,
      ipc_request_write_count: 1,
      ipc_response_line_bytes: 73,
      ipc_response_line_count: 1,
      ipc_ack_write_bytes: 29,
      ipc_ack_write_count: 1,
      financial_work_count: 1,
      financial_source_coverage_rows: 1,
      confirmed_full_cycle_analysis_count: 1,
      strategy_evaluation_count: 4,
    })
    expect(
      summarizeOfflineDiagnostics({
        workerEvents: [
          { request_id: 'legacy-request', phase: 'stdin_write_callback' },
          { request_id: 'legacy-request', phase: 'ack_write_callback' },
        ],
        driverEvents: [],
      }),
    ).toMatchObject({
      ipc_ack_write_bytes: null,
      confirmed_full_cycle_analysis_count: null,
      strategy_evaluation_count: null,
    })
  })
})
