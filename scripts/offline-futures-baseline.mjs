import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createReplayScheduler } from './offline-futures-scheduler.mjs'

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
let forcedTermination = false
const writeReport = (partial = false) => {
  if (finalized) return
  finalized = true
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
        emitted,
        delivered,
        outcome,
        elapsed_ms: Math.round(performance.now() - started),
        partial,
        child_pid: childPid,
        child_process_group: childPid,
        child_closed: childClosed,
        child_exit_code: child.exitCode,
        child_signal_code: child.signalCode,
        forced_termination: forcedTermination,
        source_queue_snapshot: (() => {
          const path = join(temp, 'app-source-queue.jsonl')
          if (!existsSync(path)) return null
          const lines = readFileSync(path, 'utf8').trim().split('\n')
          try {
            return JSON.parse(lines.at(-1))
          } catch {
            return null
          }
        })(),
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
            if (event.state === 'begin') open.set(key, event)
            else open.delete(key)
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
    childClosed = true
    outcome = 'replay_complete'
    writeReport()
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
  clearTimeout(watchdog)
  clearInterval(poll)
  if (!finalized) {
    outcome = child.exitCode === 0 ? 'child_exited' : 'child_failed'
    writeReport(true)
  } else if (outcome === 'watchdog_deadline') {
    finalized = false
    writeReport(true)
  }
})
