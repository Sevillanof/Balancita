import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import {
  classifyReplayCompletion,
  createReplayScheduler,
  summarizeOfflineDiagnostics,
} from './offline-futures-scheduler.mjs'

export function sourcePendingLagReportFields(sourceQueueSnapshot) {
  return {
    source_pending_lag_ms: sourceQueueSnapshot?.source_pending_lag_ms ?? null,
    source_pending_lag_clock_domain:
      sourceQueueSnapshot?.source_pending_lag_clock_domain ?? null,
    source_pending_lag_cutoff_received_at:
      sourceQueueSnapshot?.source_pending_lag_cutoff_received_at ?? null,
    source_pending_lag_watermark_sequence:
      sourceQueueSnapshot?.source_pending_lag_watermark_sequence ?? null,
    source_pending_lag_watermark_received_at:
      sourceQueueSnapshot?.source_pending_lag_watermark_received_at ?? null,
    source_pending_lag_oldest_sequence:
      sourceQueueSnapshot?.source_pending_lag_oldest_sequence ?? null,
    source_pending_lag_oldest_received_at:
      sourceQueueSnapshot?.source_pending_lag_oldest_received_at ?? null,
    source_pending_lag_unavailable_reason:
      sourceQueueSnapshot &&
      Object.hasOwn(
        sourceQueueSnapshot,
        'source_pending_lag_unavailable_reason',
      )
        ? sourceQueueSnapshot.source_pending_lag_unavailable_reason
        : sourceQueueSnapshot
          ? 'source_pending_lag_unavailable'
          : 'source_queue_snapshot_unavailable',
    source_oldest_pending_age_ms: null,
    source_oldest_pending_age_unavailable_reason:
      'No mapping from source received time to wall clock is established.',
  }
}

if (process.argv[2] === '--source-pending-lag-fixture') {
  process.stdout.write(
    `${JSON.stringify(sourcePendingLagReportFields(JSON.parse(process.argv[3] ?? 'null')))}\n`,
  )
  process.exit(0)
}

const input = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('Pass the immutable JSONL input path.')
const speed = Number(process.env.OFFLINE_REPLAY_SPEED ?? 1)
if (![0.5, 1, 2].includes(speed))
  throw new Error('OFFLINE_REPLAY_SPEED must be 0.5, 1, or 2.')
const bytes = readFileSync(input)
const hash = createHash('sha256').update(bytes).digest('hex')
const records = bytes
  .toString('utf8')
  .trimEnd()
  .split('\n')
  .map((line) => JSON.parse(line))
const responses = records.filter((row) => row.kind === 'http_response')
const frames = records.filter((row) => row.kind === 'websocket_frame')
const catalogResponse = responses.find((row) =>
  row.url.includes('/instruments'),
)
const funding = responses.find((row) =>
  row.url.includes('historical-funding-rates'),
)
if (!catalogResponse || !funding)
  throw new Error('Capture must contain catalog and funding responses.')
const catalog = JSON.parse(catalogResponse.raw)
const temp = join(tmpdir(), `balancita-offline-${randomUUID()}`)
const reportDir = resolve(
  'playwright-artifacts/futures-paper-live/offline-baseline',
)
mkdirSync(reportDir, { recursive: true })
const reportPath = join(
  reportDir,
  `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.json`,
)
const deadlineMs = Number(process.env.OFFLINE_WATCHDOG_MS ?? 145_000)
const child = spawn(
  process.execPath,
  [
    '--experimental-strip-types',
    new URL('./offline-futures-child.mjs', import.meta.url).pathname,
  ],
  {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    detached: true,
    env: process.env,
  },
)
const started = performance.now()
const emitted = []
const delivered = []
let activeTimestamp = new Date(
  Number(frames[0]?.received_at ?? Date.now()),
).toISOString()
let scheduler
let watchdog
let finalized = false
let childPid = child.pid
let outcome = 'starting'
let error = null
let childClosed = false
let closeClassification = null
let closeMessage = null
let forcedTermination = false
const writeReport = (partial = false) => {
  if (finalized) return
  finalized = true
  const sourceQueueSnapshot =
    closeClassification?.source_queue_snapshot ?? finalSourceQueue()
  const diagnostics = summarizeOfflineDiagnostics({
    workerEvents: readTraceEvents('worker-observer.jsonl'),
    driverEvents: readTraceEvents('driver-trace.jsonl'),
  })
  const sourceQueueEvents = readTraceEvents('app-source-queue.jsonl') ?? []
  const noActionRows = sourceQueueSnapshot?.inspected_no_action_source_rows
  const financialSourceRows = diagnostics.financial_source_coverage_rows
  const sourceCoverageRows =
    Number.isSafeInteger(noActionRows) &&
    Number.isSafeInteger(financialSourceRows)
      ? noActionRows + financialSourceRows
      : null
  const observedQueueAges = sourceQueueEvents
    .map((event) => event.oldest_job_age_ms)
    .filter((age) => Number.isFinite(age) && age >= 0)
  const localQueueAge = observedQueueAges.length
    ? observedQueueAges.reduce((maximum, age) => Math.max(maximum, age), 0)
    : null
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        input,
        input_sha256: hash,
        input_bytes: bytes.length,
        speed,
        rows_total: frames.length,
        rows_emitted: emitted.length,
        rows_delivered: delivered.length,
        raw_frames_total: frames.length,
        raw_frames_emitted: emitted.length,
        raw_frames_delivered: delivered.length,
        normalized_source_events_persisted:
          sourceQueueSnapshot?.source_events_persisted ?? null,
        last_inspected_source_seq:
          closeClassification?.last_inspected_source_seq ??
          sourceQueueSnapshot?.last_inspected_source_seq ??
          null,
        last_financial_source_seq:
          closeClassification?.last_financial_source_seq ??
          sourceQueueSnapshot?.last_financial_source_seq ??
          null,
        last_considered_source_seq:
          closeClassification?.source_received_seq ??
          sourceQueueSnapshot?.source_received_seq ??
          null,
        source_watermark:
          closeClassification?.source_watermark ??
          sourceQueueSnapshot?.source_watermark ??
          null,
        inspected_no_action_range_count:
          sourceQueueSnapshot?.inspected_no_action_range_count ?? null,
        inspected_no_action_source_rows:
          closeClassification?.inspected_no_action_source_rows ??
          sourceQueueSnapshot?.inspected_no_action_source_rows ??
          null,
        inspection_policy_bound:
          sourceQueueSnapshot?.inspection_policy_bound ?? null,
        financial_source_coverage_rows:
          diagnostics.financial_source_coverage_rows,
        source_coverage_rows: sourceCoverageRows,
        source_coverage_unavailable_reason:
          sourceCoverageRows === null
            ? 'Financial receipt source-row coverage or inspected no-action audit count is unavailable.'
            : null,
        financial_work_count: diagnostics.financial_work_count,
        confirmed_full_cycle_analysis_count:
          diagnostics.confirmed_full_cycle_analysis_count,
        analysis_count_unavailable_reason:
          diagnostics.analysis_count_unavailable_reason,
        ipc_request_wire_bytes: diagnostics.ipc_request_wire_bytes,
        ipc_request_write_count: diagnostics.ipc_request_write_count,
        ipc_request_wire_bytes_unavailable_reason:
          diagnostics.ipc_request_wire_bytes_unavailable_reason,
        ipc_response_line_bytes: diagnostics.ipc_response_line_bytes,
        ipc_response_line_count: diagnostics.ipc_response_line_count,
        ipc_ack_write_bytes: diagnostics.ipc_ack_write_bytes,
        ipc_ack_write_count: diagnostics.ipc_ack_write_count,
        ipc_ack_bytes_unavailable_reason:
          diagnostics.ipc_ack_bytes_unavailable_reason,
        ...sourcePendingLagReportFields(sourceQueueSnapshot),
        local_oldest_source_job_age_ms: Number.isFinite(localQueueAge)
          ? localQueueAge
          : null,
        local_oldest_source_job_age_clock_domain: Number.isFinite(localQueueAge)
          ? 'node_process_monotonic_ms'
          : null,
        local_oldest_source_job_age_sample_count: observedQueueAges.length,
        emitted,
        delivered,
        outcome,
        elapsed_ms: Math.round(performance.now() - started),
        partial,
        child_pid: childPid,
        child_process_group: childPid,
        child_closed: childClosed,
        processing_complete: closeClassification?.processing_complete ?? false,
        delivery_complete: closeClassification?.delivery_complete ?? false,
        eligible_pending_source_rows:
          closeClassification?.eligible_pending_source_rows ?? null,
        source_processing_outcome: closeClassification?.outcome ?? outcome,
        inspection_completion_unavailable_reason:
          closeClassification?.inspection_completion_unavailable_reason ??
          'Final child close evidence was unavailable.',
        source_count: closeClassification?.source_count ?? null,
        durable_pending_source_rows:
          closeClassification?.durable_pending_source_rows ?? null,
        child_exit_code: child.exitCode,
        child_signal_code: child.signalCode,
        forced_termination: forcedTermination,
        child_process_closed: childClosed,
        normal_close: closeMessage?.normal_close ?? null,
        app_resources_closed: closeMessage?.app_resources_closed ?? null,
        worker_closed: closeMessage?.worker_closed ?? null,
        source_queue_snapshot: sourceQueueSnapshot,
        last_unended_close_phase: (() => {
          const path = join(temp, 'app-close-phases.jsonl')
          if (!existsSync(path)) return null
          const events = readFileSync(path, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
          const open = new Map()
          for (const event of events) {
            const key = `${event.phase}:${event.resource_id ?? ''}`
            if (event.state === 'begin' || event.state === 'error')
              open.set(key, event)
            else if (event.state === 'end') open.delete(key)
          }
          return [...open.values()].at(-1) ?? null
        })(),
        worker_pid: (() => {
          const path = join(temp, 'python-diagnostics.jsonl')
          if (!existsSync(path)) return null
          const events = readFileSync(path, 'utf8').trim().split('\n')
          for (let i = events.length - 1; i >= 0; i -= 1) {
            try {
              const event = JSON.parse(events[i])
              if (event.process_pid) return event.process_pid
            } catch {}
          }
          return null
        })(),
        preserved_temp_directory: existsSync(temp) ? temp : null,
        trace_paths: {
          worker: join(temp, 'worker-observer.jsonl'),
          driver: join(temp, 'driver-trace.jsonl'),
          sqlite: join(temp, 'sqlite-observer.jsonl'),
          python: join(temp, 'python-diagnostics.jsonl'),
          account_db: join(temp, 'account.sqlite'),
          market_db: join(temp, 'market.sqlite'),
        },
        error,
      },
      null,
      2,
    ),
  )
}
const killOwnedGroup = () => {
  if (childPid && !childClosed) {
    try {
      process.kill(-childPid, 'SIGTERM')
    } catch {}
    const timer = setTimeout(() => {
      forcedTermination = true
      try {
        process.kill(-childPid, 'SIGKILL')
      } catch {}
    }, 250)
    timer.unref()
  }
}
const finalSourceQueue = () => {
  const path = join(temp, 'app-source-queue.jsonl')
  if (!existsSync(path)) return null
  const lines = readFileSync(path, 'utf8').trim().split('\n')
  try {
    return JSON.parse(lines.at(-1))
  } catch {
    return null
  }
}
const readTraceEvents = (name) => {
  const path = join(temp, name)
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}
child.on('message', (message) => {
  if (message.type === 'ready') {
    scheduler = createReplayScheduler({
      rows: frames,
      speed,
      now: () => performance.now(),
      deliver: (frame, timing) => {
        const id = emitted.length
        emitted.push({
          id,
          received_at: frame.received_at,
          emitted_at_ms: timing.actual,
          lateness_ms: timing.latenessMs,
        })
        activeTimestamp = new Date(Number(frame.received_at)).toISOString()
        child.send({
          type: 'frame',
          id,
          raw: frame.raw,
          timestamp: new Date(Number(frame.received_at)).toISOString(),
        })
      },
    })
  } else if (message.type === 'delivered') {
    delivered.push({ id: message.id, delivered_at_ms: performance.now() })
  } else if (message.type === 'error') {
    error = message.error
    outcome = 'child_error'
    writeReport(true)
    killOwnedGroup()
  } else if (message.type === 'closed') {
    closeMessage = message
    outcome = 'awaiting_child_exit'
  }
})
child.once('close', () => {
  childClosed = true
})
child.once('error', (cause) => {
  error = cause.stack ?? String(cause)
  outcome = 'spawn_error'
  writeReport(true)
})
child.send({ type: 'start', temp, catalog, funding, activeTimestamp })
watchdog = setTimeout(() => {
  outcome = 'watchdog_deadline'
  error = `Independent watchdog reached ${deadlineMs}ms.`
  writeReport(true)
  scheduler?.cancel()
  killOwnedGroup()
}, deadlineMs)
const poll = setInterval(() => {
  if (scheduler?.complete && emitted.length === frames.length && !finalized) {
    clearInterval(poll)
    child.send({ type: 'finish' })
  }
}, 10)
child.once('close', () => {
  childClosed = true
  clearTimeout(watchdog)
  clearInterval(poll)
  if (!finalized && closeMessage) {
    const sourceQueue = closeMessage.final_source_queue ?? finalSourceQueue()
    const workerEvents = readTraceEvents('worker-observer.jsonl')
    const driverEvents = readTraceEvents('driver-trace.jsonl')
    const diagnostics = summarizeOfflineDiagnostics({
      workerEvents,
      driverEvents,
    })
    const noActionRows = sourceQueue?.inspected_no_action_source_rows
    const sourceCoverageRows =
      Number.isSafeInteger(noActionRows) &&
      Number.isSafeInteger(diagnostics.financial_source_coverage_rows)
        ? noActionRows + diagnostics.financial_source_coverage_rows
        : null
    closeClassification = classifyReplayCompletion({
      closeMessage: {
        ...closeMessage,
        final_source_queue: {
          ...sourceQueue,
          financial_work_count: diagnostics.financial_work_count,
          financial_source_coverage_rows:
            diagnostics.financial_source_coverage_rows,
          source_coverage_rows: sourceCoverageRows,
        },
        child_process_closed: true,
        child_exit_code: child.exitCode,
        child_signal_code: child.signalCode,
      },
      processed: delivered.length,
      total: frames.length,
    })
    outcome = closeClassification.outcome
    writeReport()
  } else if (!finalized) {
    outcome = child.exitCode === 0 ? 'child_exited' : 'child_failed'
    writeReport(true)
  } else if (outcome === 'watchdog_deadline') {
    finalized = false
    writeReport(true)
  }
})
