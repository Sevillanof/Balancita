import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  canonicalHash,
  canonicalJson,
  normalizeDecimal,
  normalizeTimestampMs,
} from './futures-canonical.ts'
import {
  FuturesOperativeIdentityStore,
  OPERATIVE_CHECKPOINT_POLICY_VERSION,
  ensureFuturesOperativeIdentitySchema,
  isOperativeRuntimeConfig,
  operativeCheckpointView,
  type FuturesOperativeIdentityKind,
  type FuturesOperativeIdentityUpdate,
  type FuturesOperativeIdentityValue,
} from './futures-operative-state.ts'

type JsonRecord = Record<string, unknown>

export type FuturesSqlObserver = (event: {
  readonly phase: string
  readonly request_id: string
  readonly run_id: string
  readonly work_id: string
  readonly monotonic_ms: number
  readonly duration_ms?: number
}) => void

export type TerminalEventType =
  | 'analysis.completed'
  | 'analysis.superseded'
  | 'order.updated'
  | 'fill.created'
  | 'position.updated'
  | 'account.updated'
  | 'engine.status'
  | 'market.updated'
  | 'command.ack'
  | 'command.result'

export interface TerminalEventInput {
  readonly type: TerminalEventType
  readonly data: JsonRecord
  readonly eventTime?: number
}

export interface TerminalStoredEvent {
  readonly schema_version: 1
  readonly event_id: string
  readonly stream_id: string
  readonly run_id: string
  readonly seq: number
  readonly type: TerminalEventType
  readonly instrument_id: string
  readonly event_time: number
  readonly published_at: number
  readonly data: JsonRecord
}

export interface TerminalCommandMetadata {
  readonly command_id: string
  readonly action: string
  readonly stream_run_id: string
  readonly expected_state_version: number
  readonly child_run_id?: string
}

export interface TerminalSnapshot {
  readonly schema_version: 1
  readonly stream_id: string
  readonly run_id: string
  readonly watermark: number
  readonly instrument_id: string
  readonly state: JsonRecord
  readonly market?: JsonRecord
}

function terminalEntriesFromResult(result: JsonRecord): TerminalEventInput[] {
  const output = isRecord(result.runtime_output)
    ? result.runtime_output
    : undefined
  if (output === undefined)
    return [
      {
        type: 'engine.status',
        data: {
          work_id: result.work_id,
          run_id: result.run_id,
          status: 'committed',
        },
      },
    ]

  const runId = String(result.run_id)
  const workId = String(result.work_id)
  const checkpoint = isRecord(result.runtime_checkpoint)
    ? isOperativeRuntimeConfig(result.runtime_checkpoint.runtime_config)
      ? operativeCheckpointView(result.runtime_checkpoint)
      : result.runtime_checkpoint
    : undefined
  const execution =
    checkpoint && isRecord(checkpoint.execution_checkpoint)
      ? checkpoint.execution_checkpoint
      : undefined
  const executionOrders =
    execution && isRecord(execution.orders) ? execution.orders : {}
  const common = { run_id: runId, work_id: workId, command_id: workId }
  const decisionTime = appliedDecisionTime(result)
  const timestamp =
    (typeof output.decision_time_ms === 'number' && output.decision_time_ms) ||
    Date.now()
  const entries: TerminalEventInput[] = []
  if (isRecord(output.analysis))
    entries.push({
      type: 'analysis.completed',
      eventTime: timestamp,
      data: {
        ...common,
        analysis_id:
          typeof output.analysis.analysis_id === 'string'
            ? output.analysis.analysis_id
            : workId,
        analysis: {
          ...output.analysis,
          analysis_id: workId,
          ...(decisionTime === undefined
            ? {}
            : { decision_time_ms: decisionTime }),
          runtime_version:
            typeof output.runtime_version === 'string'
              ? output.runtime_version
              : undefined,
        },
      },
    })
  const observedOrderIds = new Set<string>()
  if (Array.isArray(output.orders))
    for (const order of output.orders) {
      if (!isRecord(order)) continue
      const orderId = typeof order.order_id === 'string' ? order.order_id : null
      const checkpointOrder =
        orderId && isRecord(executionOrders[orderId])
          ? executionOrders[orderId]
          : undefined
      if (orderId) observedOrderIds.add(orderId)
      entries.push({
        type: 'order.updated',
        eventTime:
          typeof order.event_time_ms === 'number'
            ? order.event_time_ms
            : timestamp,
        data: {
          ...common,
          order:
            checkpointOrder && isRecord(checkpointOrder.intent)
              ? {
                  ...order,
                  ...checkpointOrder.intent,
                  state: checkpointOrder.state,
                  status: checkpointOrder.state,
                  filled_quantity_btc: checkpointOrder.filled,
                  remaining_quantity_btc: checkpointOrder.remaining,
                }
              : order,
        },
      })
    }
  for (const [orderId, checkpointOrder] of Object.entries(executionOrders))
    if (
      !observedOrderIds.has(orderId) &&
      isRecord(checkpointOrder) &&
      isRecord(checkpointOrder.intent)
    )
      entries.push({
        type: 'order.updated',
        eventTime: timestamp,
        data: {
          ...common,
          order: {
            ...checkpointOrder.intent,
            state: checkpointOrder.state,
            status: checkpointOrder.state,
            filled_quantity_btc: checkpointOrder.filled,
            remaining_quantity_btc: checkpointOrder.remaining,
          },
        },
      })
  if (Array.isArray(output.fills))
    for (const fill of output.fills)
      if (isRecord(fill))
        entries.push({
          type: 'fill.created',
          eventTime:
            typeof fill.event_time_ms === 'number'
              ? fill.event_time_ms
              : timestamp,
          data: { ...common, fill },
        })
  if (isRecord(output.position))
    entries.push({
      type: 'position.updated',
      eventTime: timestamp,
      data: { ...common, position: output.position },
    })
  if (isRecord(output.ledger))
    entries.push({
      type: 'account.updated',
      eventTime: timestamp,
      data: { ...common, account: output.ledger },
    })
  if (entries.length === 0)
    entries.push({
      type: 'engine.status',
      eventTime: timestamp,
      data: { ...common, status: 'committed' },
    })
  return entries
}

function appliedDecisionTime(result: JsonRecord): number | undefined {
  if (!Array.isArray(result.events)) return undefined
  let decisionTime: number | undefined
  for (const event of result.events)
    if (
      isRecord(event) &&
      event.type === 'account' &&
      Number.isSafeInteger(event.event_time_ms)
    )
      decisionTime = Number(event.event_time_ms)
  return decisionTime
}

export class FuturesStore {
  private readonly db: DatabaseSync
  private operativeIdentityStore: FuturesOperativeIdentityStore | undefined
  private terminalRetention = 10_000
  private readonly terminalListeners = new Set<
    (event: TerminalStoredEvent) => void
  >()

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS paper_futures_schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
      INSERT OR IGNORE INTO paper_futures_schema_migrations VALUES(1, unixepoch('subsec') * 1000);
      CREATE TABLE IF NOT EXISTS paper_futures_runs(run_id TEXT PRIMARY KEY, frozen_json TEXT NOT NULL, frozen_hash TEXT NOT NULL, state_version INTEGER NOT NULL DEFAULT 0, head_hash TEXT NOT NULL) STRICT;
      CREATE TRIGGER IF NOT EXISTS paper_futures_run_frozen BEFORE UPDATE OF run_id,frozen_json,frozen_hash ON paper_futures_runs BEGIN SELECT RAISE(ABORT,'frozen futures run identity'); END;
      CREATE TABLE IF NOT EXISTS paper_futures_work(work_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES paper_futures_runs(run_id), cycle_key TEXT NOT NULL, expected_version INTEGER NOT NULL, snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL, UNIQUE(run_id,cycle_key)) STRICT;
      CREATE TRIGGER IF NOT EXISTS paper_futures_work_no_update BEFORE UPDATE ON paper_futures_work BEGIN SELECT RAISE(ABORT,'immutable futures work'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_work_no_delete BEFORE DELETE ON paper_futures_work BEGIN SELECT RAISE(ABORT,'immutable futures work'); END;
      CREATE TABLE IF NOT EXISTS paper_futures_records(seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES paper_futures_runs(run_id), work_id TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL, payload_hash TEXT NOT NULL, previous_hash TEXT NOT NULL, record_hash TEXT NOT NULL UNIQUE) STRICT;
      CREATE TRIGGER IF NOT EXISTS paper_futures_records_no_update BEFORE UPDATE ON paper_futures_records BEGIN SELECT RAISE(ABORT,'append-only futures record'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_records_no_delete BEFORE DELETE ON paper_futures_records BEGIN SELECT RAISE(ABORT,'append-only futures record'); END;
      CREATE TABLE IF NOT EXISTS paper_futures_applied(work_id TEXT PRIMARY KEY REFERENCES paper_futures_work(work_id), result_hash TEXT NOT NULL, receipt_json TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS paper_futures_fill_ids(fill_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES paper_futures_work(work_id)) STRICT;
      CREATE TABLE IF NOT EXISTS paper_futures_events(event_id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES paper_futures_work(work_id), payload_json TEXT NOT NULL) STRICT;
      CREATE TRIGGER IF NOT EXISTS paper_futures_events_no_update BEFORE UPDATE ON paper_futures_events BEGIN SELECT RAISE(ABORT,'append-only futures event'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_events_no_delete BEFORE DELETE ON paper_futures_events BEGIN SELECT RAISE(ABORT,'append-only futures event'); END;
      CREATE TABLE IF NOT EXISTS paper_futures_ledger(work_id TEXT NOT NULL REFERENCES paper_futures_work(work_id), event_id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(work_id,event_id)) STRICT;
      CREATE TRIGGER IF NOT EXISTS paper_futures_ledger_no_update BEFORE UPDATE ON paper_futures_ledger BEGIN SELECT RAISE(ABORT,'append-only futures ledger'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_ledger_no_delete BEFORE DELETE ON paper_futures_ledger BEGIN SELECT RAISE(ABORT,'append-only futures ledger'); END;
      CREATE TABLE IF NOT EXISTS paper_futures_projections(run_id TEXT PRIMARY KEY REFERENCES paper_futures_runs(run_id), state_json TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS paper_futures_checkpoints(run_id TEXT PRIMARY KEY REFERENCES paper_futures_runs(run_id), state_version INTEGER NOT NULL, result_hash TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS paper_futures_outbox(outbox_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, work_id TEXT NOT NULL, payload_json TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS paper_futures_commands(command_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, acceptance_json TEXT NOT NULL) STRICT;
      CREATE TRIGGER IF NOT EXISTS paper_futures_commands_no_update BEFORE UPDATE ON paper_futures_commands BEGIN SELECT RAISE(ABORT,'immutable accepted command'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_commands_no_delete BEFORE DELETE ON paper_futures_commands BEGIN SELECT RAISE(ABORT,'immutable accepted command'); END;
      CREATE TABLE IF NOT EXISTS paper_futures_command_queue(command_id TEXT PRIMARY KEY REFERENCES paper_futures_commands(command_id), payload_json TEXT NOT NULL) STRICT;
      CREATE TRIGGER IF NOT EXISTS paper_futures_command_queue_no_update BEFORE UPDATE ON paper_futures_command_queue BEGIN SELECT RAISE(ABORT,'immutable queued futures command'); END;
      CREATE TRIGGER IF NOT EXISTS paper_futures_command_queue_no_delete BEFORE DELETE ON paper_futures_command_queue BEGIN SELECT RAISE(ABORT,'immutable queued futures command'); END;
       INSERT OR IGNORE INTO paper_futures_schema_migrations VALUES(2, unixepoch('subsec') * 1000);
       CREATE TABLE IF NOT EXISTS paper_futures_replay_sessions(run_id TEXT PRIMARY KEY REFERENCES paper_futures_runs(run_id), binding_json TEXT NOT NULL, binding_hash TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS paper_futures_replay_work(work_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES paper_futures_replay_sessions(run_id), source_sequence INTEGER NOT NULL, input_hash TEXT NOT NULL, work_json TEXT NOT NULL, work_hash TEXT NOT NULL, receipt_json TEXT, receipt_hash TEXT, UNIQUE(run_id,source_sequence)) STRICT;
       CREATE TRIGGER IF NOT EXISTS paper_futures_replay_work_identity_immutable BEFORE UPDATE OF work_id,run_id,source_sequence,input_hash,work_json,work_hash ON paper_futures_replay_work BEGIN SELECT RAISE(ABORT,'immutable replay work identity'); END;
       INSERT OR IGNORE INTO paper_futures_schema_migrations VALUES(3, unixepoch('subsec') * 1000);
       CREATE TABLE IF NOT EXISTS paper_futures_terminal_streams(run_id TEXT PRIMARY KEY REFERENCES paper_futures_runs(run_id), stream_id TEXT NOT NULL UNIQUE, last_seq INTEGER NOT NULL DEFAULT 0, first_seq INTEGER NOT NULL DEFAULT 1) STRICT;
       CREATE TABLE IF NOT EXISTS paper_futures_terminal_events(run_id TEXT NOT NULL REFERENCES paper_futures_terminal_streams(run_id), seq INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, event_json TEXT NOT NULL, PRIMARY KEY(run_id,seq)) STRICT;
       CREATE TRIGGER IF NOT EXISTS paper_futures_terminal_events_no_update BEFORE UPDATE ON paper_futures_terminal_events BEGIN SELECT RAISE(ABORT,'immutable terminal stream event'); END;
       INSERT OR IGNORE INTO paper_futures_schema_migrations VALUES(4, unixepoch('subsec') * 1000);
       CREATE TABLE IF NOT EXISTS paper_futures_evaluation_progress(run_id TEXT PRIMARY KEY REFERENCES paper_futures_runs(run_id), policy_identity TEXT NOT NULL, source_identity TEXT NOT NULL, cursor_rowid INTEGER NOT NULL, next_due_at INTEGER, next_due_reasons_json TEXT NOT NULL) STRICT;
       CREATE TABLE IF NOT EXISTS paper_futures_evaluation_skipped(run_id TEXT NOT NULL REFERENCES paper_futures_runs(run_id), policy_identity TEXT NOT NULL, source_identity TEXT NOT NULL, from_rowid INTEGER NOT NULL, to_rowid INTEGER NOT NULL, inspected_row_count INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(run_id,from_rowid), CHECK(from_rowid>0 AND to_rowid>=from_rowid AND inspected_row_count>0)) STRICT;
       INSERT OR IGNORE INTO paper_futures_schema_migrations VALUES(5, unixepoch('subsec') * 1000);
    `)
    ensureFuturesOperativeIdentitySchema(this.db)
    this.db
      .prepare(
        "INSERT OR IGNORE INTO paper_futures_schema_migrations VALUES(6, unixepoch('subsec') * 1000)",
      )
      .run()
    const existingRuns = this.db
      .prepare('SELECT run_id FROM paper_futures_runs')
      .all() as { run_id: string }[]
    for (const { run_id } of existingRuns) this.ensureTerminalStream(run_id)
  }

  private identities(): FuturesOperativeIdentityStore {
    this.operativeIdentityStore ??= new FuturesOperativeIdentityStore(this.db)
    return this.operativeIdentityStore
  }

  /** Committed exact identity lookup for the job-bound worker RPC (null = absent). */
  lookupOperativeIdentities(
    runId: string,
    kind: FuturesOperativeIdentityKind,
    keys: readonly string[],
  ): (FuturesOperativeIdentityValue[FuturesOperativeIdentityKind] | null)[] {
    const found = this.identities().lookupMany(runId, kind, keys)
    return keys.map((key) => found.get(key) ?? null)
  }

  close(): void {
    this.db.close()
    this.terminalListeners.clear()
  }

  subscribeTerminalEvents(
    listener: (event: TerminalStoredEvent) => void,
  ): () => void {
    this.terminalListeners.add(listener)
    return () => this.terminalListeners.delete(listener)
  }

  setTerminalEventRetention(retention: number): void {
    if (
      !Number.isSafeInteger(retention) ||
      retention < 1 ||
      retention > 100_000
    )
      throw new Error('Terminal event retention must be between 1 and 100000.')
    this.terminalRetention = retention
  }

  getTerminalSnapshot(runId: string): TerminalSnapshot {
    this.ensureTerminalStream(runId)
    this.db.exec('BEGIN')
    try {
      const run = this.db
        .prepare('SELECT frozen_json FROM paper_futures_runs WHERE run_id=?')
        .get(runId) as { frozen_json: string } | undefined
      if (!run) throw new Error('Unknown futures run.')
      const stream = this.db
        .prepare(
          'SELECT stream_id,last_seq FROM paper_futures_terminal_streams WHERE run_id=?',
        )
        .get(runId) as { stream_id: string; last_seq: number } | undefined
      const projection = this.db
        .prepare(
          'SELECT state_json FROM paper_futures_projections WHERE run_id=?',
        )
        .get(runId) as { state_json: string } | undefined
      if (!stream || !projection)
        throw new Error('Terminal snapshot projection is incomplete.')
      const frozen = JSON.parse(run.frozen_json) as JsonRecord
      const instrument = isRecord(frozen.instrument) ? frozen.instrument : {}
      const analysisRows = this.db
        .prepare(
          `SELECT work_id,payload_json FROM paper_futures_records
           WHERE run_id=? AND kind='applied-result' ORDER BY seq`,
        )
        .all(runId) as { work_id: string; payload_json: string }[]
      const appliedResults = analysisRows.map(({ work_id, payload_json }) => ({
        workId: work_id,
        applied: JSON.parse(payload_json) as JsonRecord,
      }))
      const analyses = appliedResults.flatMap(({ workId, applied }) => {
        const output = isRecord(applied.runtime_output)
          ? applied.runtime_output
          : undefined
        if (!output || !isRecord(output.analysis)) return []
        const decisionTime = appliedDecisionTime(applied)
        return [
          {
            ...output.analysis,
            analysis_id: workId,
            ...(decisionTime === undefined
              ? {}
              : { decision_time_ms: decisionTime }),
            runtime_version: output.runtime_version,
          },
        ]
      })
      const projectionState = JSON.parse(projection.state_json) as JsonRecord
      const projectionRuntimeOutput = isRecord(projectionState.runtime_output)
        ? projectionState.runtime_output
        : {}
      const runtimeFills = new Map<string, JsonRecord>()
      const fillsWithoutIdentity: JsonRecord[] = []
      const collectFills = (output: JsonRecord) => {
        if (!Array.isArray(output.fills)) return
        for (const value of output.fills) {
          if (!isRecord(value)) continue
          if (typeof value.fill_id !== 'string') {
            fillsWithoutIdentity.push(value)
            continue
          }
          if (!runtimeFills.has(value.fill_id))
            runtimeFills.set(value.fill_id, value)
        }
      }
      for (const { applied } of appliedResults)
        if (isRecord(applied.runtime_output))
          collectFills(applied.runtime_output)
      collectFills(projectionRuntimeOutput)
      const terminalProjection = {
        ...projectionState,
        runtime_output: {
          ...projectionRuntimeOutput,
          fills: [...runtimeFills.values(), ...fillsWithoutIdentity],
        },
      }
      const state = projectTerminalState(
        terminalProjection,
        runId,
        analyses,
        isRecord(frozen.seed) ? frozen.seed.cash_usd : null,
      )
      this.db.exec('COMMIT')
      return {
        schema_version: 1,
        stream_id: stream.stream_id,
        run_id: runId,
        watermark: Number(stream.last_seq),
        instrument_id:
          typeof instrument.instrument_id === 'string'
            ? instrument.instrument_id
            : 'kraken-futures:PF_XBTUSD',
        state,
        ...(frozen.config &&
        isRecord(frozen.config) &&
        (frozen.config.mode === 'mock' || frozen.config.mode === 'replay') &&
        isRecord(frozen.seed) &&
        isRecord(frozen.seed.terminal_market)
          ? { market: frozen.seed.terminal_market }
          : {}),
      }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  listTerminalEvents(
    runId: string,
    input: { afterSeq?: number; beforeSeq?: number; limit: number },
  ): {
    readonly streamId: string
    readonly firstSeq: number
    readonly lastSeq: number
    readonly expired: boolean
    readonly events: TerminalStoredEvent[]
    readonly nextBeforeSeq: number | null
  } {
    const { afterSeq = 0, beforeSeq, limit } = input
    if (
      !Number.isSafeInteger(afterSeq) ||
      afterSeq < 0 ||
      (beforeSeq !== undefined &&
        (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      throw new Error('Terminal event cursor or page size is invalid.')
    const stream = this.db
      .prepare(
        'SELECT stream_id,first_seq,last_seq FROM paper_futures_terminal_streams WHERE run_id=?',
      )
      .get(runId) as
      { stream_id: string; first_seq: number; last_seq: number } | undefined
    if (!stream) throw new Error('Unknown terminal stream.')
    const expired =
      beforeSeq === undefined && afterSeq < Number(stream.first_seq) - 1
    const rows =
      beforeSeq === undefined
        ? (this.db
            .prepare(
              'SELECT event_json FROM paper_futures_terminal_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT ?',
            )
            .all(runId, afterSeq, limit + 1) as { event_json: string }[])
        : (this.db
            .prepare(
              'SELECT event_json FROM paper_futures_terminal_events WHERE run_id=? AND seq<? ORDER BY seq DESC LIMIT ?',
            )
            .all(runId, beforeSeq, limit + 1) as { event_json: string }[])
    const hasMore = rows.length > limit
    const page = rows.slice(0, limit)
    if (beforeSeq !== undefined) page.reverse()
    const events = page.map(
      (row) => JSON.parse(row.event_json) as TerminalStoredEvent,
    )
    const nextBeforeSeq = hasMore ? (events[0]?.seq ?? null) : null
    return {
      streamId: stream.stream_id,
      firstSeq: Number(stream.first_seq),
      lastSeq: Number(stream.last_seq),
      expired,
      events,
      nextBeforeSeq,
    }
  }

  getTerminalAnalysisDetail(
    runId: string,
    analysisId: string,
  ): JsonRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT work_id,record_hash,payload_json FROM paper_futures_records
         WHERE run_id=? AND kind='applied-result' AND work_id=? ORDER BY seq DESC LIMIT 1`,
      )
      .get(runId, analysisId) as
      { work_id: string; record_hash: string; payload_json: string } | undefined
    if (!row) return undefined
    const result = JSON.parse(row.payload_json) as JsonRecord
    const runtimeOutput = isRecord(result.runtime_output)
      ? result.runtime_output
      : undefined
    const analysis = runtimeOutput?.analysis
    if (!isRecord(analysis)) return undefined
    return {
      analysis_id: row.work_id,
      record_hash: row.record_hash,
      analysis,
      runtime_output: runtimeOutput,
    }
  }

  private ensureTerminalStream(runId: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO paper_futures_terminal_streams(run_id,stream_id,last_seq,first_seq) VALUES(?,?,0,1)',
      )
      .run(runId, randomUUID())
  }

  private appendTerminalEventsInTransaction(
    runId: string,
    entries: readonly TerminalEventInput[],
    retention: number,
  ): TerminalStoredEvent[] {
    if (!Number.isSafeInteger(retention) || retention < 1)
      throw new Error('Terminal outbox retention must be a positive integer.')
    this.ensureTerminalStream(runId)
    const stream = this.db
      .prepare(
        'SELECT stream_id,last_seq FROM paper_futures_terminal_streams WHERE run_id=?',
      )
      .get(runId) as { stream_id: string; last_seq: number }
    const instrumentId = this.instrumentId(runId)
    const events = entries.map((entry, index) => {
      const seq = Number(stream.last_seq) + index + 1
      const publishedAt = Date.now()
      const event: TerminalStoredEvent = {
        schema_version: 1,
        event_id: randomUUID(),
        stream_id: stream.stream_id,
        run_id: runId,
        seq,
        type: entry.type,
        instrument_id: instrumentId,
        event_time: entry.eventTime ?? publishedAt,
        published_at: publishedAt,
        data: entry.data,
      }
      this.db
        .prepare(
          'INSERT INTO paper_futures_terminal_events(run_id,seq,event_id,type,event_json) VALUES(?,?,?,?,?)',
        )
        .run(runId, seq, event.event_id, event.type, canonicalJson(event))
      return event
    })
    if (events.length > 0) {
      const lastSeq = events.at(-1)!.seq
      const firstSeq = Math.max(1, lastSeq - retention + 1)
      this.db
        .prepare(
          'UPDATE paper_futures_terminal_streams SET last_seq=?,first_seq=? WHERE run_id=?',
        )
        .run(lastSeq, firstSeq, runId)
      this.db
        .prepare(
          'DELETE FROM paper_futures_terminal_events WHERE run_id=? AND seq<?',
        )
        .run(runId, firstSeq)
    }
    return events
  }

  private instrumentId(runId: string): string {
    const row = this.db
      .prepare('SELECT frozen_json FROM paper_futures_runs WHERE run_id=?')
      .get(runId) as { frozen_json: string } | undefined
    if (!row) throw new Error('Unknown futures run.')
    const frozen = JSON.parse(row.frozen_json) as JsonRecord
    return isRecord(frozen.instrument) &&
      typeof frozen.instrument.instrument_id === 'string'
      ? frozen.instrument.instrument_id
      : 'kraken-futures:PF_XBTUSD'
  }

  private notifyTerminalEvents(events: readonly TerminalStoredEvent[]): void {
    for (const event of events)
      for (const listener of this.terminalListeners) {
        try {
          listener(event)
        } catch {
          // A transport subscriber must never roll back committed financial state.
        }
      }
  }

  bindReplaySession(runId: string, binding: unknown): void {
    const json = canonicalJson(binding)
    const hash = canonicalHash(binding)
    const existing = this.db
      .prepare(
        'SELECT binding_json,binding_hash FROM paper_futures_replay_sessions WHERE run_id=?',
      )
      .get(runId) as { binding_json: string; binding_hash: string } | undefined
    if (existing) {
      if (existing.binding_hash !== hash || existing.binding_json !== json)
        throw new Error(
          'Replay session conflicts with frozen dataset or configuration.',
        )
      return
    }
    this.db
      .prepare('INSERT INTO paper_futures_replay_sessions VALUES(?,?,?)')
      .run(runId, json, hash)
  }

  getReplaySessionBinding(runId: string): JsonRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT binding_json,binding_hash FROM paper_futures_replay_sessions WHERE run_id=?',
      )
      .get(runId) as { binding_json: string; binding_hash: string } | undefined
    if (!row) return undefined
    const binding = JSON.parse(row.binding_json) as JsonRecord
    if (
      canonicalJson(binding) !== row.binding_json ||
      canonicalHash(binding) !== row.binding_hash
    )
      throw new Error(
        'Durable replay session binding hash verification failed.',
      )
    return binding
  }

  persistReplayWork(
    runId: string,
    sourceSequence: number,
    inputHash: string,
    work: unknown,
  ): JsonRecord {
    const json = canonicalJson(work)
    const hash = canonicalHash(work)
    const prior = this.db
      .prepare(
        'SELECT * FROM paper_futures_replay_work WHERE run_id=? AND source_sequence=?',
      )
      .get(runId, sourceSequence) as JsonRecord | undefined
    if (prior) {
      if (prior.input_hash !== inputHash)
        throw new Error(
          'Replay source sequence conflicts with durable evidence.',
        )
      const savedWork = JSON.parse(String(prior.work_json)) as JsonRecord
      if (
        canonicalJson(savedWork) !== prior.work_json ||
        canonicalHash(savedWork) !== prior.work_hash
      )
        throw new Error('Durable replay work hash verification failed.')
      return {
        ...(JSON.parse(String(prior.work_json)) as JsonRecord),
        receipt: prior.receipt_json
          ? JSON.parse(String(prior.receipt_json))
          : null,
      }
    }
    this.db
      .prepare(
        'INSERT INTO paper_futures_replay_work(work_id,run_id,source_sequence,input_hash,work_json,work_hash) VALUES(?,?,?,?,?,?)',
      )
      .run(
        String((work as JsonRecord).work_id),
        runId,
        sourceSequence,
        inputHash,
        json,
        hash,
      )
    return { ...(work as JsonRecord), receipt: null }
  }

  commitReplayWork(runId: string, workId: string, receipt: unknown): void {
    const json = canonicalJson(receipt)
    const row = this.db
      .prepare(
        'SELECT receipt_json FROM paper_futures_replay_work WHERE run_id=? AND work_id=?',
      )
      .get(runId, workId) as { receipt_json: string | null } | undefined
    if (!row) throw new Error('Cannot commit unknown replay work.')
    if (row.receipt_json) {
      if (row.receipt_json !== json)
        throw new Error('Replay work receipt conflicts with durable result.')
      return
    }
    const parsed = receipt as JsonRecord
    if (parsed.status !== 'committed')
      throw new Error('Only committed runtime work advances replay cursor.')
    this.db
      .prepare(
        'UPDATE paper_futures_replay_work SET receipt_json=?,receipt_hash=? WHERE run_id=? AND work_id=?',
      )
      .run(json, canonicalHash(receipt), runId, workId)
  }

  loadReplaySession(
    runId: string,
    binding: unknown,
  ): { works: JsonRecord[]; cursor: number } {
    const session = this.db
      .prepare(
        'SELECT binding_json,binding_hash FROM paper_futures_replay_sessions WHERE run_id=?',
      )
      .get(runId) as { binding_json: string; binding_hash: string } | undefined
    if (
      !session ||
      session.binding_hash !== canonicalHash(binding) ||
      session.binding_json !== canonicalJson(binding)
    )
      throw new Error('Replay session binding is missing or has drifted.')
    const rows = this.db
      .prepare(
        'SELECT * FROM paper_futures_replay_work WHERE run_id=? ORDER BY source_sequence',
      )
      .all(runId) as JsonRecord[]
    let cursor = 0
    const works = rows.map((row) => {
      const work = JSON.parse(String(row.work_json)) as JsonRecord
      if (
        canonicalJson(work) !== row.work_json ||
        canonicalHash(work) !== row.work_hash
      )
        throw new Error('Durable replay work hash verification failed.')
      if (canonicalHash(work.input) !== row.input_hash)
        throw new Error('Durable replay input hash verification failed.')
      if (row.receipt_json) {
        const receipt = JSON.parse(String(row.receipt_json)) as JsonRecord
        if (
          canonicalJson(receipt) !== row.receipt_json ||
          canonicalHash(receipt) !== row.receipt_hash ||
          receipt.status !== 'committed'
        )
          throw new Error('Durable replay receipt verification failed.')
        cursor = Math.max(cursor, Number(row.source_sequence))
      }
      return {
        ...work,
        receipt: row.receipt_json ? JSON.parse(String(row.receipt_json)) : null,
      }
    })
    return { works, cursor }
  }

  createRun(input: {
    runId: string
    config: unknown
    seed: unknown
    instrument: unknown
    costs: unknown
    runtime?: unknown
    parentRunId?: string
    revisionId?: string
  }): void {
    validateFrozenRun(input)
    const frozen = {
      config: input.config,
      seed: input.seed,
      instrument: input.instrument,
      costs: input.costs,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
      ...(input.parentRunId === undefined
        ? {}
        : { parent_run_id: input.parentRunId }),
      ...(input.revisionId === undefined
        ? {}
        : { revision_id: input.revisionId }),
    }
    const json = canonicalJson(frozen)
    const hash = canonicalHash(frozen)
    const prior = this.db
      .prepare(
        'SELECT frozen_json,frozen_hash,state_version FROM paper_futures_runs WHERE run_id=?',
      )
      .get(input.runId) as
      | { frozen_json: string; frozen_hash: string; state_version: number }
      | undefined
    if (prior) {
      if (prior.frozen_hash !== hash)
        throw new Error('Run identity conflicts with frozen inputs.')
      const projection = this.db
        .prepare(
          'SELECT state_json FROM paper_futures_projections WHERE run_id=?',
        )
        .get(input.runId) as { state_json: string } | undefined
      if (!projection)
        throw new Error('Existing run is missing its state projection.')
      const parsedProjection = JSON.parse(projection.state_json) as JsonRecord
      if (
        canonicalJson(parsedProjection) !== projection.state_json ||
        parsedProjection.state_version !== prior.state_version
      )
        throw new Error(
          'Existing run projection is inconsistent with its state version.',
        )
      const parsedFrozen = JSON.parse(prior.frozen_json) as unknown
      if (
        canonicalJson(parsedFrozen) !== prior.frozen_json ||
        canonicalHash(parsedFrozen) !== prior.frozen_hash
      )
        throw new Error('Existing run frozen configuration is inconsistent.')
      return
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          'INSERT INTO paper_futures_runs(run_id,frozen_json,frozen_hash,state_version,head_hash) VALUES(?,?,?,0,?)',
        )
        .run(input.runId, json, hash, '0'.repeat(64))
      this.db
        .prepare('INSERT INTO paper_futures_projections VALUES(?,?)')
        .run(input.runId, canonicalJson({ state_version: 0 }))
      this.ensureTerminalStream(input.runId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getRunDefinition(runId: string): {
    config: unknown
    seed: unknown
    instrument: unknown
    costs: unknown
    runtime?: unknown
  } {
    const row = this.db
      .prepare('SELECT frozen_json FROM paper_futures_runs WHERE run_id=?')
      .get(runId) as { frozen_json: string } | undefined
    if (!row) throw new Error('Unknown futures run.')
    const frozen = JSON.parse(row.frozen_json) as JsonRecord
    return {
      config: frozen.config,
      seed: frozen.seed,
      instrument: frozen.instrument,
      costs: frozen.costs,
      ...(frozen.runtime === undefined ? {} : { runtime: frozen.runtime }),
    }
  }

  createChildRun(input: {
    runId: string
    parentRunId: string
    revisionId: string
    config: unknown
    seed: unknown
    instrument: unknown
    costs: unknown
    runtime?: unknown
  }): void {
    this.createRun({
      ...input,
      parentRunId: input.parentRunId,
      revisionId: input.revisionId,
    })
  }

  getRunMetadata(
    runId: string,
  ): { parent_run_id: string | null; revision_id: string } | undefined {
    const row = this.db
      .prepare('SELECT frozen_json FROM paper_futures_runs WHERE run_id=?')
      .get(runId) as { frozen_json: string } | undefined
    if (!row) return undefined
    const frozen = JSON.parse(row.frozen_json) as JsonRecord
    return {
      parent_run_id:
        typeof frozen.parent_run_id === 'string' ? frozen.parent_run_id : null,
      revision_id:
        typeof frozen.revision_id === 'string'
          ? frozen.revision_id
          : canonicalHash(frozen),
    }
  }

  getLatestRunId(): string | undefined {
    const row = this.db
      .prepare(
        `SELECT run_id FROM paper_futures_runs
         WHERE run_id NOT LIKE '%:batch-verification:%'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get() as { run_id: string } | undefined
    return row?.run_id
  }

  appendTerminalEvents(
    runId: string,
    entries: readonly TerminalEventInput[],
  ): TerminalStoredEvent[] {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const events = this.appendTerminalEventsInTransaction(
        runId,
        entries,
        this.terminalRetention,
      )
      this.db.exec('COMMIT')
      this.notifyTerminalEvents(events)
      return events
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getRuntimeBinding(runId: string): JsonRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT frozen_json,frozen_hash FROM paper_futures_runs WHERE run_id=?',
      )
      .get(runId) as { frozen_json: string; frozen_hash: string } | undefined
    if (!row) return undefined
    const frozen = JSON.parse(row.frozen_json) as JsonRecord
    if (
      canonicalJson(frozen) !== row.frozen_json ||
      canonicalHash(frozen) !== row.frozen_hash
    )
      throw new Error('Stored frozen run configuration is inconsistent.')
    if (!('runtime' in frozen)) return undefined
    validateRuntimeBinding(frozen.runtime, frozen)
    return JSON.parse(canonicalJson(frozen.runtime)) as JsonRecord
  }

  recordWork(input: {
    workId: string
    runId: string
    cycleKey: string
    expectedVersion: number
    snapshot: unknown
  }): void {
    if (
      !input.workId ||
      !input.runId ||
      !input.cycleKey ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0
    )
      throw new Error('Invalid immutable work identity or expected version.')
    const json = canonicalJson(input.snapshot)
    const hash = canonicalHash(input.snapshot)
    const prior = this.db
      .prepare(
        'SELECT run_id,cycle_key,expected_version,snapshot_hash FROM paper_futures_work WHERE work_id=?',
      )
      .get(input.workId) as JsonRecord | undefined
    if (prior) {
      if (
        prior.run_id !== input.runId ||
        prior.cycle_key !== input.cycleKey ||
        prior.expected_version !== input.expectedVersion ||
        prior.snapshot_hash !== hash
      )
        throw new Error('Work identity conflicts with frozen snapshot.')
      return
    }
    const cycle = this.db
      .prepare(
        'SELECT work_id FROM paper_futures_work WHERE run_id=? AND cycle_key=?',
      )
      .get(input.runId, input.cycleKey)
    if (cycle)
      throw new Error('Cycle key already belongs to another work item.')
    this.db
      .prepare('INSERT INTO paper_futures_work VALUES(?,?,?,?,?,?)')
      .run(
        input.workId,
        input.runId,
        input.cycleKey,
        input.expectedVersion,
        json,
        hash,
      )
  }

  applyResult(
    value: unknown,
    injectFailureAt?: 'before-commit',
    trace?: {
      readonly requestId: string
      readonly observer: FuturesSqlObserver
    },
  ): JsonRecord {
    const enteredAt = performance.now()
    const report = (phase: string, duration_ms?: number) => {
      if (!trace || !isRecord(value)) return
      try {
        trace.observer({
          phase,
          request_id: trace.requestId,
          run_id: String(value.run_id ?? ''),
          work_id: String(value.work_id ?? ''),
          monotonic_ms: performance.now(),
          ...(duration_ms === undefined ? {} : { duration_ms }),
        })
      } catch {
        // Diagnostics must not affect durable result processing.
      }
    }
    report('sql_entry')
    if (!isRecord(value)) throw new Error('Invalid futures result schema.')
    const runtimeWork =
      value.schema_version === 'futures-runtime-work.v1' ||
      value.schema_version === 'futures-runtime-work.v2' ||
      value.schema_version === 'futures-runtime-work.v3'
    assertKeys(
      value,
      [
        'protocol_version',
        'run_id',
        'work_id',
        'applied_state_version',
        'result',
        'events',
      ],
      runtimeWork
        ? [
            'result_hash',
            'schema_version',
            'runtime_checkpoint',
            'runtime_output',
            'runtime_identity_updates',
          ]
        : ['result_hash'],
    )
    if (
      value.protocol_version !== 1 ||
      typeof value.run_id !== 'string' ||
      typeof value.work_id !== 'string' ||
      !Number.isSafeInteger(value.applied_state_version) ||
      (value.applied_state_version as number) < 1 ||
      !isRecord(value.result) ||
      !Array.isArray(value.events)
    )
      throw new Error('Invalid futures result schema.')
    const work = this.db
      .prepare('SELECT * FROM paper_futures_work WHERE work_id=?')
      .get(value.work_id) as JsonRecord | undefined
    if (!work || work.run_id !== value.run_id)
      throw new Error('Unknown work/run identity.')
    if (
      canonicalHash(JSON.parse(String(work.snapshot_json))) !==
      work.snapshot_hash
    )
      throw new Error('Stored immutable work snapshot hash mismatch.')
    const run = this.db
      .prepare('SELECT * FROM paper_futures_runs WHERE run_id=?')
      .get(value.run_id) as JsonRecord | undefined
    if (!run) throw new Error('Unknown futures run.')
    const frozen = JSON.parse(String(run.frozen_json)) as JsonRecord
    if (canonicalHash(frozen) !== run.frozen_hash)
      throw new Error('Stored frozen run hash mismatch.')
    const runtimeBound = 'runtime' in frozen
    if (runtimeWork !== runtimeBound)
      throw new Error('Runtime work schema does not match frozen run binding.')
    if (runtimeWork)
      validateRuntimeWork(
        value,
        frozen,
        String(value.run_id),
        Number(value.applied_state_version),
      )
    const operative =
      runtimeWork &&
      isOperativeRuntimeConfig((frozen.runtime as JsonRecord).runtime_config)
    const identityUpdates = parseOperativeIdentityUpdates(
      value.runtime_identity_updates,
      operative,
    )
    validateLedgerSnapshot(value.result, frozen)
    validateFuturesEvents(
      value.events,
      String(value.run_id),
      String(value.work_id),
      frozen,
    )
    const { result_hash: suppliedHash, ...hashedValue } = value
    const resultHash = canonicalHash(hashedValue)
    if (suppliedHash !== undefined && suppliedHash !== resultHash)
      throw new Error('Futures result hash mismatch.')
    const old = this.db
      .prepare(
        'SELECT result_hash,receipt_json FROM paper_futures_applied WHERE work_id=?',
      )
      .get(value.work_id) as
      { result_hash: string; receipt_json: string } | undefined
    if (old) {
      if (old.result_hash !== resultHash)
        throw new Error('Applied work result conflicts with stored result.')
      return JSON.parse(old.receipt_json) as JsonRecord
    }
    if (
      work.expected_version !== run.state_version ||
      value.applied_state_version !== Number(run.state_version) + 1
    ) {
      const receipt = {
        type: 'ack',
        status: 'superseded',
        protocol_version: 1,
        request_id: value.work_id,
        run_id: value.run_id,
        applied_state_version: Number(run.state_version),
        result_hash: resultHash,
      }
      const payload = {
        work_id: value.work_id,
        status: 'superseded',
        result_hash: resultHash,
      }
      const payloadHash = canonicalHash(payload)
      const previous = String(run.head_hash)
      const recordHash = createHash('sha256')
        .update(`${previous}${payloadHash}`)
        .digest('hex')
      report('sql_prepare', performance.now() - enteredAt)
      const beginAt = performance.now()
      this.db.exec('BEGIN IMMEDIATE')
      report('sql_begin_immediate', performance.now() - beginAt)
      const bodyAt = performance.now()
      try {
        this.db
          .prepare(
            'INSERT INTO paper_futures_records(run_id,work_id,kind,payload_json,payload_hash,previous_hash,record_hash) VALUES(?,?,?,?,?,?,?)',
          )
          .run(
            value.run_id,
            value.work_id,
            'superseded',
            canonicalJson(payload),
            payloadHash,
            previous,
            recordHash,
          )
        this.db
          .prepare('UPDATE paper_futures_runs SET head_hash=? WHERE run_id=?')
          .run(recordHash, value.run_id)
        this.db
          .prepare('INSERT INTO paper_futures_applied VALUES(?,?,?)')
          .run(value.work_id, resultHash, canonicalJson(receipt))
        this.db
          .prepare('INSERT INTO paper_futures_outbox VALUES(?,?,?,?)')
          .run(
            `superseded:${value.work_id}`,
            value.run_id,
            value.work_id,
            canonicalJson(receipt),
          )
        const terminalEvents = this.appendTerminalEventsInTransaction(
          String(value.run_id),
          [
            {
              type: 'analysis.superseded',
              data: {
                work_id: value.work_id,
                run_id: value.run_id,
                result_hash: resultHash,
                status: 'superseded',
              },
            },
          ],
          this.terminalRetention,
        )
        report('sql_transaction_body', performance.now() - bodyAt)
        const commitAt = performance.now()
        report('sql_commit_call')
        this.db.exec('COMMIT')
        report('sql_commit_success', performance.now() - commitAt)
        this.notifyTerminalEvents(terminalEvents)
        return receipt
      } catch (error) {
        report('sql_error')
        report('sql_rollback')
        this.db.exec('ROLLBACK')
        throw error
      }
    }
    const events = value.events as JsonRecord[]
    for (const event of events)
      if (!isRecord(event) || typeof event.id !== 'string')
        throw new Error('Each event requires an immutable id.')
    const receipt = {
      type: 'ack',
      status: 'committed',
      protocol_version: 1,
      request_id: value.work_id,
      run_id: value.run_id,
      applied_state_version: value.applied_state_version,
      result_hash: resultHash,
    }
    report('sql_prepare', performance.now() - enteredAt)
    const beginAt = performance.now()
    this.db.exec('BEGIN IMMEDIATE')
    report('sql_begin_immediate', performance.now() - beginAt)
    const bodyAt = performance.now()
    try {
      for (const event of events) {
        this.db
          .prepare('INSERT INTO paper_futures_events VALUES(?,?,?)')
          .run(String(event.id), value.work_id, canonicalJson(event))
        if (
          ['fill', 'funding', 'position', 'account'].includes(
            String(event.type),
          )
        )
          this.db
            .prepare('INSERT INTO paper_futures_ledger VALUES(?,?,?)')
            .run(value.work_id, String(event.id), canonicalJson(event))
        if (event.type === 'fill' || 'fill_id' in event)
          this.db
            .prepare('INSERT INTO paper_futures_fill_ids VALUES(?,?)')
            .run(String(event.fill_id ?? event.id), value.work_id)
      }
      if (
        runtimeWork &&
        isRecord(value.result) &&
        Array.isArray(value.result.events)
      )
        value.result.events.forEach((event, index) => {
          this.db
            .prepare('INSERT INTO paper_futures_ledger VALUES(?,?,?)')
            .run(
              String(value.work_id),
              `runtime:${value.work_id}:${index}`,
              canonicalJson(event),
            )
        })
      if (operative) {
        // Provisional until COMMIT: same transaction as the result record, so a
        // duplicate, conflict, or gap rolls back the whole job.
        const frontier = operativeSourceFrontier(value.runtime_checkpoint)
        const identities = this.identities()
        identities.withOwnerTransaction((transaction) =>
          identities.apply(transaction, {
            runId: String(value.run_id),
            workId: String(value.work_id),
            expectedStateVersion: Number(work.expected_version),
            sourceFrontier: frontier,
            confirmedSourceFrontier: frontier,
            updates: identityUpdates,
          }),
        )
      }
      const previous = String(run.head_hash)
      const payloadHash = canonicalHash(value)
      const recordHash = createHash('sha256')
        .update(`${previous}${payloadHash}`)
        .digest('hex')
      this.db
        .prepare(
          'INSERT INTO paper_futures_records(run_id,work_id,kind,payload_json,payload_hash,previous_hash,record_hash) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          value.run_id,
          value.work_id,
          'applied-result',
          canonicalJson(value),
          payloadHash,
          previous,
          recordHash,
        )
      this.db
        .prepare('INSERT INTO paper_futures_applied VALUES(?,?,?)')
        .run(value.work_id, resultHash, canonicalJson(receipt))
      this.db
        .prepare(
          'UPDATE paper_futures_runs SET state_version=?,head_hash=? WHERE run_id=?',
        )
        .run(value.applied_state_version, recordHash, value.run_id)
      this.db
        .prepare(
          'UPDATE paper_futures_projections SET state_json=? WHERE run_id=?',
        )
        .run(
          canonicalJson({
            state_version: value.applied_state_version,
            result: value.result,
            ...(isRecord(value.runtime_output)
              ? { runtime_output: value.runtime_output }
              : {}),
            ...(runtimeWork ? { checkpoint: value.runtime_checkpoint } : {}),
          }),
          value.run_id,
        )
      this.db
        .prepare(
          'INSERT INTO paper_futures_checkpoints VALUES(?,?,?) ON CONFLICT(run_id) DO UPDATE SET state_version=excluded.state_version,result_hash=excluded.result_hash',
        )
        .run(value.run_id, value.applied_state_version, resultHash)
      this.db
        .prepare('INSERT INTO paper_futures_outbox VALUES(?,?,?,?)')
        .run(
          `result:${value.work_id}`,
          value.run_id,
          value.work_id,
          canonicalJson({ result: value, receipt }),
        )
      const terminalEvents = this.appendTerminalEventsInTransaction(
        String(value.run_id),
        terminalEntriesFromResult(value),
        this.terminalRetention,
      )
      if (injectFailureAt === 'before-commit')
        throw new Error('Injected pre-commit failure.')
      report('sql_transaction_body', performance.now() - bodyAt)
      const commitAt = performance.now()
      report('sql_commit_call')
      this.db.exec('COMMIT')
      report('sql_commit_success', performance.now() - commitAt)
      this.notifyTerminalEvents(terminalEvents)
      return receipt
    } catch (error) {
      report('sql_error')
      report('sql_rollback')
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  acceptCommand(
    commandId: string,
    payload: unknown,
    injectFailureAt?: 'before-commit',
    checkpoint?: unknown,
    terminalCommand?: TerminalCommandMetadata,
  ): JsonRecord {
    if (
      typeof commandId !== 'string' ||
      commandId.length < 1 ||
      commandId.length > 128
    )
      throw new Error('Invalid durable command identity.')
    const payloadJson = canonicalJson(payload)
    if (Buffer.byteLength(payloadJson, 'utf8') > 1_048_576)
      throw new Error(
        'Durable command payload exceeds the JSONL message limit.',
      )
    if (
      terminalCommand !== undefined &&
      (terminalCommand.command_id !== commandId ||
        !terminalCommand.stream_run_id ||
        !terminalCommand.action ||
        !Number.isSafeInteger(terminalCommand.expected_state_version) ||
        terminalCommand.expected_state_version < 0)
    )
      throw new Error('Invalid terminal command acceptance metadata.')
    const hash = canonicalHash(
      terminalCommand === undefined ? payload : { payload, terminalCommand },
    )
    const queuedJson = canonicalJson(
      terminalCommand !== undefined
        ? { request: payload, checkpoint: checkpoint ?? null, terminalCommand }
        : checkpoint === undefined
          ? payload
          : { request: payload, checkpoint },
    )
    if (Buffer.byteLength(queuedJson, 'utf8') > 1_048_576)
      throw new Error(
        'Durable command checkpoint exceeds the JSONL message limit.',
      )
    const old = this.db
      .prepare(
        'SELECT payload_hash,acceptance_json FROM paper_futures_commands WHERE command_id=?',
      )
      .get(commandId) as
      { payload_hash: string; acceptance_json: string } | undefined
    if (old) {
      if (old.payload_hash !== hash)
        throw new Error('Command identity conflicts with accepted payload.')
      const queued = this.db
        .prepare('SELECT 1 FROM paper_futures_command_queue WHERE command_id=?')
        .get(commandId)
      const result = this.db
        .prepare('SELECT 1 FROM paper_futures_outbox WHERE outbox_id=?')
        .get(`command-result:${commandId}`)
      if (!queued && !result)
        throw new Error('Accepted command predates durable payload recovery.')
      return JSON.parse(old.acceptance_json) as JsonRecord
    }
    const receipt = {
      type: 'command.ack',
      status: 'accepted',
      protocol_version: 1,
      command_id: commandId,
      payload_hash: hash,
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('INSERT INTO paper_futures_commands VALUES(?,?,?)')
        .run(commandId, hash, canonicalJson(receipt))
      this.db
        .prepare('INSERT INTO paper_futures_command_queue VALUES(?,?)')
        .run(commandId, queuedJson)
      this.db
        .prepare('INSERT INTO paper_futures_outbox VALUES(?,?,?,?)')
        .run(`command:${commandId}`, '', commandId, canonicalJson(receipt))
      const terminalEvents = terminalCommand
        ? this.appendTerminalEventsInTransaction(
            terminalCommand.stream_run_id,
            [
              {
                type: 'command.ack',
                data: {
                  command_id: commandId,
                  action: terminalCommand.action,
                  status: 'accepted',
                  expected_state_version:
                    terminalCommand.expected_state_version,
                  ...(terminalCommand.child_run_id
                    ? { child_run_id: terminalCommand.child_run_id }
                    : {}),
                },
              },
            ],
            this.terminalRetention,
          )
        : []
      if (injectFailureAt === 'before-commit')
        throw new Error('Injected command acceptance pre-commit failure.')
      this.db.exec('COMMIT')
      this.notifyTerminalEvents(terminalEvents)
      return receipt
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  loadPendingCommands(limit = 32): { command_id: string; payload: unknown }[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32)
      throw new Error('Pending command batch limit must be between 1 and 32.')
    const rows = this.db
      .prepare(
        `SELECT q.command_id,q.payload_json FROM paper_futures_command_queue q
        LEFT JOIN paper_futures_outbox o ON o.outbox_id='command-result:' || q.command_id
        WHERE o.outbox_id IS NULL ORDER BY q.rowid LIMIT ?`,
      )
      .all(limit) as { command_id: string; payload_json: string }[]
    return rows.map((row) => ({
      command_id: row.command_id,
      payload: JSON.parse(row.payload_json) as unknown,
    }))
  }

  /** Bind only after the caller has verified these immutable identities. Existing runs are never assigned a default policy. */
  bindEvaluationProgress(input: {
    runId: string
    policyIdentity: string
    sourceIdentity: string
    baselineRowid: number
    nextDueAt: number | null
    nextDueReasons: readonly string[]
  }): void {
    if (
      !input.policyIdentity ||
      !input.sourceIdentity ||
      !Number.isSafeInteger(input.baselineRowid) ||
      input.baselineRowid < 0
    )
      throw new Error('Evaluation progress binding is invalid.')
    const reasons = canonicalJson(input.nextDueReasons)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (
        !this.db
          .prepare('SELECT 1 FROM paper_futures_runs WHERE run_id=?')
          .get(input.runId)
      )
        throw new Error('Unknown futures run.')
      const existing = this.db
        .prepare(
          'SELECT * FROM paper_futures_evaluation_progress WHERE run_id=?',
        )
        .get(input.runId) as JsonRecord | undefined
      if (existing) {
        if (
          existing.policy_identity !== input.policyIdentity ||
          existing.source_identity !== input.sourceIdentity ||
          Number(existing.cursor_rowid) !== input.baselineRowid ||
          existing.next_due_at !== input.nextDueAt ||
          existing.next_due_reasons_json !== reasons
        )
          throw new Error(
            'Evaluation progress is already bound to different identities or baseline.',
          )
      } else {
        this.db
          .prepare(
            'INSERT INTO paper_futures_evaluation_progress VALUES(?,?,?,?,?,?)',
          )
          .run(
            input.runId,
            input.policyIdentity,
            input.sourceIdentity,
            input.baselineRowid,
            input.nextDueAt,
            reasons,
          )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getEvaluationProgress(runId: string):
    | {
        policyIdentity: string
        sourceIdentity: string
        cursorRowid: number
        nextDueAt: number | null
        nextDueReasons: string[]
      }
    | undefined {
    const row = this.db
      .prepare('SELECT * FROM paper_futures_evaluation_progress WHERE run_id=?')
      .get(runId) as JsonRecord | undefined
    if (!row) return undefined
    return {
      policyIdentity: String(row.policy_identity),
      sourceIdentity: String(row.source_identity),
      cursorRowid: Number(row.cursor_rowid),
      nextDueAt: row.next_due_at === null ? null : Number(row.next_due_at),
      nextDueReasons: JSON.parse(String(row.next_due_reasons_json)) as string[],
    }
  }

  getEvaluationSkippedRanges(runId: string): {
    policyIdentity: string
    sourceIdentity: string
    fromRowid: number
    toRowid: number
    inspectedRowCount: number
    reason: string
  }[] {
    return (
      this.db
        .prepare(
          'SELECT * FROM paper_futures_evaluation_skipped WHERE run_id=? ORDER BY from_rowid',
        )
        .all(runId) as JsonRecord[]
    ).map((row) => ({
      policyIdentity: String(row.policy_identity),
      sourceIdentity: String(row.source_identity),
      fromRowid: Number(row.from_rowid),
      toRowid: Number(row.to_rowid),
      inspectedRowCount: Number(row.inspected_row_count),
      reason: String(row.reason),
    }))
  }

  commitEvaluationProcessedSource(input: {
    runId: string
    expectedPolicyIdentity: string
    expectedSourceIdentity: string
    expectedStateVersion: number
    expectedHeadHash: string
    fromRowid: number
    sourceRowid: number
    inspectedRowCount: number
    workId: string
    nextDueAt: number | null
    nextDueReasons: readonly string[]
  }): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.db
        .prepare(
          'SELECT state_version,head_hash FROM paper_futures_runs WHERE run_id=?',
        )
        .get(input.runId) as
        { state_version: number; head_hash: string } | undefined
      const progress = this.db
        .prepare(
          'SELECT * FROM paper_futures_evaluation_progress WHERE run_id=?',
        )
        .get(input.runId) as JsonRecord | undefined
      const receiptRow = this.db
        .prepare(
          'SELECT source_sequence,receipt_json FROM paper_futures_replay_work WHERE run_id=? AND work_id=?',
        )
        .get(input.runId, input.workId) as
        { source_sequence: number; receipt_json: string | null } | undefined
      if (
        !run ||
        Number(run.state_version) !== input.expectedStateVersion ||
        run.head_hash !== input.expectedHeadHash
      )
        throw new Error('Processed source expected financial head is stale.')
      if (
        !progress ||
        progress.policy_identity !== input.expectedPolicyIdentity ||
        progress.source_identity !== input.expectedSourceIdentity
      )
        throw new Error(
          'Processed source policy or source identity is not bound.',
        )
      if (
        !receiptRow ||
        Number(receiptRow.source_sequence) !== input.sourceRowid ||
        !receiptRow.receipt_json ||
        (JSON.parse(receiptRow.receipt_json) as JsonRecord).status !==
          'committed'
      )
        throw new Error(
          'Processed source requires its durable committed replay receipt.',
        )
      if (
        !Number.isSafeInteger(input.fromRowid) ||
        !Number.isSafeInteger(input.sourceRowid) ||
        input.fromRowid !== Number(progress.cursor_rowid) + 1 ||
        input.sourceRowid < input.fromRowid ||
        !Number.isSafeInteger(input.inspectedRowCount) ||
        input.inspectedRowCount < 1
      )
        throw new Error(
          'Processed source must be contiguous with the consumed-source cursor.',
        )
      this.db
        .prepare(
          'UPDATE paper_futures_evaluation_progress SET cursor_rowid=?,next_due_at=?,next_due_reasons_json=? WHERE run_id=?',
        )
        .run(
          input.sourceRowid,
          input.nextDueAt,
          canonicalJson(input.nextDueReasons),
          input.runId,
        )
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Audit and cursor advance are atomic; source ROWIDs are opaque ordered IDs, not a count. Exact retries are accepted. */
  commitEvaluationSkippedRange(input: {
    runId: string
    expectedPolicyIdentity: string
    expectedSourceIdentity: string
    expectedStateVersion: number
    expectedHeadHash: string
    fromRowid: number
    toRowid: number
    inspectedRowCount: number
    reason: string
    nextDueAt: number | null
    nextDueReasons: readonly string[]
  }): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.db
        .prepare(
          'SELECT state_version,head_hash FROM paper_futures_runs WHERE run_id=?',
        )
        .get(input.runId) as
        { state_version: number; head_hash: string } | undefined
      if (
        !run ||
        Number(run.state_version) !== input.expectedStateVersion ||
        run.head_hash !== input.expectedHeadHash
      )
        throw new Error('Evaluation range expected financial head is stale.')
      const progress = this.db
        .prepare(
          'SELECT * FROM paper_futures_evaluation_progress WHERE run_id=?',
        )
        .get(input.runId) as JsonRecord | undefined
      if (
        !progress ||
        progress.policy_identity !== input.expectedPolicyIdentity ||
        progress.source_identity !== input.expectedSourceIdentity
      )
        throw new Error(
          'Evaluation range policy or source identity is not bound.',
        )
      if (this.loadPendingCommands(1).length)
        throw new Error(
          'Cannot skip evaluation while accepted commands are pending.',
        )
      if (
        !Number.isSafeInteger(input.fromRowid) ||
        !Number.isSafeInteger(input.toRowid) ||
        input.fromRowid < 1 ||
        input.toRowid < input.fromRowid ||
        !Number.isSafeInteger(input.inspectedRowCount) ||
        input.inspectedRowCount < 1 ||
        !input.reason.trim()
      )
        throw new Error('Evaluation range is invalid.')
      const cursor = Number(progress.cursor_rowid)
      const prior = this.db
        .prepare(
          'SELECT * FROM paper_futures_evaluation_skipped WHERE run_id=? AND from_rowid=?',
        )
        .get(input.runId, input.fromRowid) as JsonRecord | undefined
      if (
        prior &&
        Number(prior.to_rowid) === input.toRowid &&
        Number(prior.inspected_row_count) === input.inspectedRowCount &&
        prior.reason === input.reason &&
        prior.policy_identity === input.expectedPolicyIdentity &&
        prior.source_identity === input.expectedSourceIdentity &&
        cursor === input.toRowid
      ) {
        this.db.exec('COMMIT')
        return
      }
      if (input.fromRowid !== cursor + 1)
        throw new Error(
          'Evaluation range must be contiguous with the consumed-source cursor.',
        )
      const reasons = canonicalJson(input.nextDueReasons)
      this.db
        .prepare(
          'INSERT INTO paper_futures_evaluation_skipped VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          input.runId,
          input.expectedPolicyIdentity,
          input.expectedSourceIdentity,
          input.fromRowid,
          input.toRowid,
          input.inspectedRowCount,
          input.reason,
          Date.now(),
        )
      this.db
        .prepare(
          'UPDATE paper_futures_evaluation_progress SET cursor_rowid=?,next_due_at=?,next_due_reasons_json=? WHERE run_id=?',
        )
        .run(input.toRowid, input.nextDueAt, reasons, input.runId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  getCommandResult(commandId: string): JsonRecord | undefined {
    const row = this.db
      .prepare(
        'SELECT payload_json FROM paper_futures_outbox WHERE outbox_id=?',
      )
      .get(`command-result:${commandId}`) as
      { payload_json: string } | undefined
    return row ? (JSON.parse(row.payload_json) as JsonRecord) : undefined
  }

  getAppliedReceipt(workId: string): JsonRecord | undefined {
    const row = this.db
      .prepare('SELECT receipt_json FROM paper_futures_applied WHERE work_id=?')
      .get(workId) as { receipt_json: string } | undefined
    return row ? (JSON.parse(row.receipt_json) as JsonRecord) : undefined
  }

  getAppliedRuntimeProjection(
    runId: string,
    workId: string,
    appliedStateVersion: number,
  ): { runtime_output: JsonRecord; ledger: JsonRecord } {
    if (!this.verifyRun(runId))
      throw new Error('Cannot restore runtime projection from an invalid run.')
    const row = this.db
      .prepare(
        `SELECT r.payload_json,r.payload_hash,a.result_hash,a.receipt_json
         FROM paper_futures_records r
         JOIN paper_futures_applied a ON a.work_id=r.work_id
         WHERE r.run_id=? AND r.work_id=? AND r.kind='applied-result'`,
      )
      .get(runId, workId) as
      | {
          payload_json: string
          payload_hash: string
          result_hash: string
          receipt_json: string
        }
      | undefined
    if (!row)
      throw new Error(
        'Applied runtime result is missing during replay recovery.',
      )
    const payload = JSON.parse(row.payload_json) as JsonRecord
    const receipt = JSON.parse(row.receipt_json) as JsonRecord
    const hashedPayload = { ...payload }
    delete hashedPayload.result_hash
    if (
      canonicalJson(payload) !== row.payload_json ||
      canonicalHash(payload) !== row.payload_hash ||
      canonicalHash(hashedPayload) !== row.result_hash ||
      payload.run_id !== runId ||
      payload.work_id !== workId ||
      ![
        'futures-runtime-work.v1',
        'futures-runtime-work.v2',
        'futures-runtime-work.v3',
      ].includes(String(payload.schema_version)) ||
      payload.applied_state_version !== appliedStateVersion ||
      receipt.status !== 'committed' ||
      receipt.applied_state_version !== appliedStateVersion ||
      !isRecord(payload.runtime_output) ||
      !isRecord(payload.result)
    )
      throw new Error(
        'Applied runtime result failed replay recovery validation.',
      )
    return {
      runtime_output: payload.runtime_output,
      ledger: payload.result,
    }
  }

  getAcceptedCommand(commandId: string): unknown {
    const row = this.db
      .prepare(
        'SELECT payload_json FROM paper_futures_command_queue WHERE command_id=?',
      )
      .get(commandId) as { payload_json: string } | undefined
    return row ? (JSON.parse(row.payload_json) as unknown) : undefined
  }

  getRunProjection(runId: string): JsonRecord | undefined {
    if (!this.verifyRun(runId))
      throw new Error('Futures run checkpoint failed integrity verification.')
    const row = this.db
      .prepare(
        'SELECT state_json FROM paper_futures_projections WHERE run_id=?',
      )
      .get(runId) as { state_json: string } | undefined
    return row ? (JSON.parse(row.state_json) as JsonRecord) : undefined
  }

  getAdmissionHead(
    runId: string,
  ): { stateVersion: number; headHash: string } | undefined {
    const row = this.db
      .prepare(
        'SELECT state_version,head_hash FROM paper_futures_runs WHERE run_id=?',
      )
      .get(runId) as { state_version: number; head_hash: string } | undefined
    return row
      ? { stateVersion: Number(row.state_version), headHash: row.head_hash }
      : undefined
  }

  getLastAppliedReplaySourceSequence(runId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(r.source_sequence) AS source_sequence
         FROM paper_futures_replay_work r
         JOIN paper_futures_applied a ON a.work_id=r.work_id
         WHERE r.run_id=?`,
      )
      .get(runId) as { source_sequence: number | null }
    return row.source_sequence === null ? null : Number(row.source_sequence)
  }

  getCommittedReplayWorkIdForSource(
    runId: string,
    sourceSequence: number,
  ): string | undefined {
    const row = this.db
      .prepare(
        'SELECT work_id,receipt_json,receipt_hash FROM paper_futures_replay_work WHERE run_id=? AND source_sequence=?',
      )
      .get(runId, sourceSequence) as
      | {
          work_id: string
          receipt_json: string | null
          receipt_hash: string | null
        }
      | undefined
    if (!row?.receipt_json || !row.receipt_hash) return undefined
    const receipt = JSON.parse(row.receipt_json) as unknown
    if (
      canonicalJson(receipt) !== row.receipt_json ||
      canonicalHash(receipt) !== row.receipt_hash ||
      !isRecord(receipt) ||
      receipt.status !== 'committed'
    )
      throw new Error('Durable replay receipt verification failed.')
    return row.work_id
  }

  getLastAppliedDecisionTime(runId: string): number | null {
    const row = this.db
      .prepare(
        `SELECT json_extract(w.snapshot_json,'$.request.payload.market_snapshot.decision_time_ms') AS decision_time_ms
         FROM paper_futures_work w
         JOIN paper_futures_applied a ON a.work_id=w.work_id
         WHERE w.run_id=?
         ORDER BY w.rowid DESC LIMIT 1`,
      )
      .get(runId) as { decision_time_ms: number | null } | undefined
    return row?.decision_time_ms === null || row === undefined
      ? null
      : Number(row.decision_time_ms)
  }

  persistCommandResult(commandId: string, result: unknown): JsonRecord {
    const command = this.db
      .prepare(
        'SELECT payload_hash FROM paper_futures_commands WHERE command_id=?',
      )
      .get(commandId) as { payload_hash: string } | undefined
    if (!command)
      throw new Error('Command result has no durable accepted command.')
    const hash = canonicalHash(result)
    const id = `command-result:${commandId}`
    const existing = this.db
      .prepare(
        'SELECT payload_json FROM paper_futures_outbox WHERE outbox_id=?',
      )
      .get(id) as { payload_json: string } | undefined
    if (existing) {
      const saved = JSON.parse(existing.payload_json) as JsonRecord
      if (saved.result_hash !== hash)
        throw new Error('Command result conflicts with stored result.')
      return saved
    }
    const stored = {
      type: 'command.result',
      protocol_version: 1,
      command_id: commandId,
      result_hash: hash,
      result,
    }
    const queuedRow = this.db
      .prepare(
        'SELECT payload_json FROM paper_futures_command_queue WHERE command_id=?',
      )
      .get(commandId) as { payload_json: string } | undefined
    const queued = queuedRow
      ? (JSON.parse(queuedRow.payload_json) as JsonRecord)
      : undefined
    const terminalCommand = queued?.terminalCommand
    if (
      terminalCommand !== undefined &&
      (!isRecord(terminalCommand) ||
        terminalCommand.command_id !== commandId ||
        typeof terminalCommand.stream_run_id !== 'string' ||
        typeof terminalCommand.action !== 'string')
    )
      throw new Error('Persisted terminal command metadata is invalid.')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('INSERT INTO paper_futures_outbox VALUES(?,?,?,?)')
        .run(id, '', commandId, canonicalJson(stored))
      const terminalEvents = isRecord(terminalCommand)
        ? this.appendTerminalEventsInTransaction(
            String(terminalCommand.stream_run_id),
            [
              {
                type: 'command.result',
                data: {
                  command_id: commandId,
                  action: terminalCommand.action,
                  result_hash: hash,
                  result: stored,
                  ...(terminalCommand.child_run_id
                    ? { child_run_id: terminalCommand.child_run_id }
                    : {}),
                },
              },
            ],
            this.terminalRetention,
          )
        : []
      this.db.exec('COMMIT')
      this.notifyTerminalEvents(terminalEvents)
      return stored
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  exportRun(runId: string): JsonRecord {
    const run = this.db
      .prepare('SELECT head_hash FROM paper_futures_runs WHERE run_id=?')
      .get(runId) as { head_hash: string } | undefined
    const receipt = this.db
      .prepare(
        `SELECT a.receipt_json FROM paper_futures_applied a JOIN paper_futures_work w ON w.work_id=a.work_id WHERE w.run_id=? ORDER BY w.rowid DESC LIMIT 1`,
      )
      .get(runId) as { receipt_json: string } | undefined
    const events = this.db
      .prepare(
        `SELECT e.payload_json FROM paper_futures_events e JOIN paper_futures_work w ON w.work_id=e.work_id WHERE w.run_id=? ORDER BY e.rowid`,
      )
      .all(runId) as { payload_json: string }[]
    const projection = this.db
      .prepare(
        'SELECT state_json FROM paper_futures_projections WHERE run_id=?',
      )
      .get(runId) as { state_json: string } | undefined
    const runtimeOutputs = this.db
      .prepare(
        `SELECT r.payload_json FROM paper_futures_records r
         WHERE r.run_id=? AND r.kind='applied-result' ORDER BY r.seq`,
      )
      .all(runId) as { payload_json: string }[]
    return {
      receipt: receipt ? JSON.parse(receipt.receipt_json) : null,
      events: events.map((row) => JSON.parse(row.payload_json)),
      projection: projection ? JSON.parse(projection.state_json) : null,
      head_hash: run?.head_hash ?? null,
      runtime_outputs: runtimeOutputs.flatMap((row) => {
        const payload = JSON.parse(row.payload_json) as JsonRecord
        return payload.runtime_output ? [payload.runtime_output] : []
      }),
    }
  }

  verifyRun(runId: string): boolean {
    try {
      return this.verifyRunIntegrity(runId)
    } catch {
      return false
    }
  }

  private verifyRunIntegrity(runId: string): boolean {
    const run = this.db
      .prepare(
        'SELECT run_id,frozen_json,frozen_hash,state_version,head_hash FROM paper_futures_runs WHERE run_id=?',
      )
      .get(runId) as JsonRecord | undefined
    if (!run) return false
    let frozen: JsonRecord
    try {
      frozen = JSON.parse(String(run.frozen_json)) as JsonRecord
      if (
        canonicalJson(frozen) !== run.frozen_json ||
        canonicalHash(frozen) !== run.frozen_hash
      )
        return false
      validateFrozenRun({
        runId,
        config: frozen.config,
        seed: frozen.seed,
        instrument: frozen.instrument,
        costs: frozen.costs,
        runtime: frozen.runtime,
      })
    } catch {
      return false
    }
    const works = this.db
      .prepare(
        'SELECT work_id,snapshot_json,snapshot_hash FROM paper_futures_work WHERE run_id=? ORDER BY rowid',
      )
      .all(runId) as JsonRecord[]
    const workIds = new Set<string>()
    try {
      for (const work of works) {
        const snapshot = JSON.parse(String(work.snapshot_json)) as unknown
        if (
          canonicalJson(snapshot) !== work.snapshot_json ||
          canonicalHash(snapshot) !== work.snapshot_hash
        )
          return false
        workIds.add(String(work.work_id))
      }
    } catch {
      return false
    }
    const records = this.db
      .prepare(
        'SELECT work_id,kind,payload_json,payload_hash,previous_hash,record_hash FROM paper_futures_records WHERE run_id=? ORDER BY seq',
      )
      .all(runId) as JsonRecord[]
    let previous = '0'.repeat(64)
    const expectedEvents = new Map<string, string>()
    const expectedRuntimeLedger = new Map<string, string>()
    let expectedStateVersion = 0
    let latestRuntimeCheckpoint: unknown
    let hasRuntimeCheckpoint = false
    const operativeRun = isOperativeRuntimeConfig(
      isRecord(frozen.runtime) ? frozen.runtime.runtime_config : undefined,
    )
    const expectedIdentityBatches = new Map<string, string>()
    for (const row of records) {
      if (!workIds.has(String(row.work_id))) return false
      let payload: unknown
      try {
        payload = JSON.parse(String(row.payload_json)) as unknown
        if (canonicalJson(payload) !== row.payload_json) return false
      } catch {
        return false
      }
      const hash = canonicalHash(payload)
      const chain = createHash('sha256')
        .update(`${previous}${hash}`)
        .digest('hex')
      if (
        hash !== row.payload_hash ||
        previous !== row.previous_hash ||
        chain !== row.record_hash
      )
        return false
      if (row.kind === 'applied-result') {
        if (
          !isRecord(payload) ||
          payload.run_id !== runId ||
          payload.work_id !== row.work_id ||
          !Array.isArray(payload.events)
        )
          return false
        const work = this.db
          .prepare(
            'SELECT expected_version FROM paper_futures_work WHERE work_id=?',
          )
          .get(String(row.work_id)) as { expected_version: number } | undefined
        if (
          !work ||
          payload.applied_state_version !== work.expected_version + 1 ||
          payload.applied_state_version !== expectedStateVersion + 1
        )
          return false
        expectedStateVersion = payload.applied_state_version as number
        const { result_hash: ignoredHash, ...hashedResult } = payload
        void ignoredHash
        const resultHash = canonicalHash(hashedResult)
        const applied = this.db
          .prepare(
            'SELECT result_hash FROM paper_futures_applied WHERE work_id=?',
          )
          .get(String(row.work_id)) as { result_hash: string } | undefined
        if (!applied || applied.result_hash !== resultHash) return false
        if (
          payload.schema_version === 'futures-runtime-work.v1' ||
          payload.schema_version === 'futures-runtime-work.v2' ||
          payload.schema_version === 'futures-runtime-work.v3'
        ) {
          if (!('runtime' in frozen)) return false
          validateRuntimeWork(
            payload,
            frozen,
            runId,
            Number(payload.applied_state_version),
          )
          latestRuntimeCheckpoint = payload.runtime_checkpoint
          hasRuntimeCheckpoint = true
          expectedIdentityBatches.set(
            String(row.work_id),
            canonicalHash(
              parseOperativeIdentityUpdates(
                payload.runtime_identity_updates,
                operativeRun,
              ),
            ),
          )
          if (
            !isRecord(payload.result) ||
            !Array.isArray(payload.result.events)
          )
            return false
          payload.result.events.forEach((event, index) => {
            expectedRuntimeLedger.set(
              `runtime:${String(row.work_id)}:${index}`,
              canonicalJson(event),
            )
          })
        }
        for (const event of payload.events) {
          if (
            !isRecord(event) ||
            typeof event.id !== 'string' ||
            expectedEvents.has(event.id)
          )
            return false
          expectedEvents.set(event.id, canonicalJson(event))
        }
      } else if (row.kind !== 'superseded') return false
      previous = chain
    }
    if (
      previous !== run.head_hash ||
      run.state_version !== expectedStateVersion
    )
      return false
    {
      // Exact identity history is verified in full and must match, batch for
      // batch, the identity updates carried by the hash-chained applied results.
      const identities = this.identities()
      const proof = identities.verifyRun(runId)
      const stored = identities.workBatchHashes(runId)
      if (!operativeRun) {
        if (proof.records !== 0 || stored.size !== 0) return false
      } else {
        if (stored.size !== expectedIdentityBatches.size) return false
        for (const [workId, hash] of expectedIdentityBatches)
          if (stored.get(workId) !== hash) return false
      }
    }
    const projectionRow = this.db
      .prepare(
        'SELECT state_json FROM paper_futures_projections WHERE run_id=?',
      )
      .get(runId) as { state_json: string } | undefined
    if (!projectionRow) return false
    const projection = JSON.parse(projectionRow.state_json) as JsonRecord
    if (
      canonicalJson(projection) !== projectionRow.state_json ||
      projection.state_version !== expectedStateVersion
    )
      return false
    if (
      hasRuntimeCheckpoint &&
      canonicalJson(projection.checkpoint) !==
        canonicalJson(latestRuntimeCheckpoint)
    )
      return false
    const committedEvents = new Map(expectedEvents)
    const storedEvents = this.db
      .prepare(
        'SELECT e.event_id,e.payload_json FROM paper_futures_events e JOIN paper_futures_work w ON w.work_id=e.work_id WHERE w.run_id=? ORDER BY e.rowid',
      )
      .all(runId) as JsonRecord[]
    if (storedEvents.length !== expectedEvents.size) return false
    for (const event of storedEvents) {
      if (
        typeof event.event_id !== 'string' ||
        expectedEvents.get(event.event_id) !== event.payload_json
      )
        return false
      expectedEvents.delete(event.event_id)
    }
    if (expectedEvents.size !== 0) return false
    const expectedLedger = new Map<string, string>()
    for (const [eventId, payloadJson] of committedEvents) {
      const event = JSON.parse(payloadJson) as JsonRecord
      if (
        ['fill', 'funding', 'position', 'account'].includes(String(event.type))
      )
        expectedLedger.set(eventId, payloadJson)
    }
    const ledgerRows = this.db
      .prepare(
        'SELECT l.work_id,l.event_id,l.payload_json FROM paper_futures_ledger l JOIN paper_futures_work w ON w.work_id=l.work_id WHERE w.run_id=? ORDER BY l.rowid',
      )
      .all(runId) as JsonRecord[]
    if (ledgerRows.length !== expectedLedger.size + expectedRuntimeLedger.size)
      return false
    for (const ledgerEvent of ledgerRows) {
      if (
        typeof ledgerEvent.event_id !== 'string' ||
        typeof ledgerEvent.payload_json !== 'string'
      )
        return false
      const work = this.db
        .prepare('SELECT run_id FROM paper_futures_work WHERE work_id=?')
        .get(String(ledgerEvent.work_id)) as { run_id: string } | undefined
      if (
        !work ||
        work.run_id !== runId ||
        (expectedLedger.get(ledgerEvent.event_id) ??
          expectedRuntimeLedger.get(ledgerEvent.event_id)) !==
          ledgerEvent.payload_json
      )
        return false
      const payload = JSON.parse(ledgerEvent.payload_json) as JsonRecord
      if (expectedRuntimeLedger.has(ledgerEvent.event_id)) {
        validateLedgerAuditEvent(payload)
        expectedRuntimeLedger.delete(ledgerEvent.event_id)
      } else {
        if (
          !['fill', 'funding', 'position', 'account'].includes(
            String(payload.type),
          )
        )
          return false
        expectedLedger.delete(ledgerEvent.event_id)
      }
    }
    return expectedLedger.size === 0 && expectedRuntimeLedger.size === 0
  }
}

export function projectTerminalState(
  projection: JsonRecord,
  runId: string,
  analyses: readonly JsonRecord[],
  initialCash: unknown,
): JsonRecord {
  const checkpoint = isRecord(projection.checkpoint)
    ? isOperativeRuntimeConfig(projection.checkpoint.runtime_config)
      ? operativeCheckpointView(projection.checkpoint)
      : projection.checkpoint
    : {}
  const result = isRecord(projection.result) ? projection.result : {}
  const runtimeOutput = isRecord(projection.runtime_output)
    ? projection.runtime_output
    : {}
  const decimal = (value: unknown): string | null =>
    typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value) ? value : null
  const negateDecimal = (value: string): string =>
    value.startsWith('-') ? value.slice(1) : value === '0' ? '0' : `-${value}`
  const seedCash = decimal(initialCash)
  const cash = decimal(checkpoint.cash_usd) ?? seedCash
  const funding = decimal(checkpoint.funding_paid) ?? '0'
  const fees = decimal(checkpoint.fees_usd) ?? '0'
  const realized = decimal(checkpoint.realized_gross_usd) ?? '0'
  const position = isRecord(checkpoint.ledger_position)
    ? checkpoint.ledger_position
    : null
  const ledgerEvents = Array.isArray(checkpoint.ledger_events)
    ? checkpoint.ledger_events.filter(isRecord)
    : []
  const orders = Array.isArray(runtimeOutput.orders) ? runtimeOutput.orders : []
  const fills = Array.isArray(runtimeOutput.fills) ? runtimeOutput.fills : []
  const fundingComplete = checkpoint.funding_complete === true
  const equity = decimal(result.equity_usd) ?? cash
  const net =
    fundingComplete && realized !== null && fees !== null && funding !== null
      ? addDecimalStrings(realized, negateDecimal(fees), negateDecimal(funding))
      : null
  const execution = isRecord(checkpoint.execution_checkpoint)
    ? checkpoint.execution_checkpoint
    : {}
  const executionOrders = isRecord(execution.orders) ? execution.orders : {}
  const projectedOrders = orders.filter(isRecord).map((order) => {
    const orderId = typeof order.order_id === 'string' ? order.order_id : null
    const checkpointOrder =
      orderId && isRecord(executionOrders[orderId])
        ? executionOrders[orderId]
        : undefined
    return checkpointOrder && isRecord(checkpointOrder.intent)
      ? {
          ...order,
          ...checkpointOrder.intent,
          state: checkpointOrder.state,
          status: checkpointOrder.state,
          filled_quantity_btc: checkpointOrder.filled,
          remaining_quantity_btc: checkpointOrder.remaining,
        }
      : order
  })
  for (const [orderId, checkpointOrder] of Object.entries(executionOrders))
    if (
      !projectedOrders.some((order) => order.order_id === orderId) &&
      isRecord(checkpointOrder) &&
      isRecord(checkpointOrder.intent)
    )
      projectedOrders.push({
        ...checkpointOrder.intent,
        state: checkpointOrder.state,
        status: checkpointOrder.state,
        filled_quantity_btc: checkpointOrder.filled,
        remaining_quantity_btc: checkpointOrder.remaining,
      })
  const dto: JsonRecord = {
    schema_version: 'paper-futures-terminal-state.v1',
    run_id: runId,
    state_version: projection.state_version,
    currency: 'USD',
    quantity_unit: 'BTC',
    account: {
      cash_usd: cash,
      equity_usd: equity,
      realized_gross_usd: realized,
      fees_usd: fees,
      funding_paid_usd: funding,
      funding_complete: fundingComplete,
      net_usd: net,
    },
    position: position
      ? {
          side: position.side ?? null,
          quantity_btc: decimal(position.quantity_btc ?? position.qty),
          entry_price_usd_per_btc: decimal(
            position.entry_price_usd_per_btc ?? position.entry_price,
          ),
        }
      : null,
    orders: projectedOrders,
    fills: (fills.filter(isRecord).length > 0
      ? fills.filter(isRecord)
      : ledgerEvents
    ).map((fill, index) => ({
      fill_id:
        typeof fill.fill_id === 'string'
          ? fill.fill_id
          : `${runId}:fill:${index}`,
      ...fill,
    })),
    analyses: [...analyses],
    ledger_events: ledgerEvents,
    feed_status: { status: 'unknown', observed_at_ms: null },
    engine_status: { status: 'unknown', observed_at_ms: null },
  }
  if (!validateTerminalState(dto))
    throw new Error('Terminal financial snapshot DTO is invalid.')
  return dto
}

function addDecimalStrings(...values: string[]): string {
  // Financial inputs remain decimal strings; this projection only combines the
  // already-normalized exact ledger totals using BigInt fixed-point arithmetic.
  const scale = Math.max(
    ...values.map((value) => value.split('.')[1]?.length ?? 0),
  )
  const factor = 10n ** BigInt(scale)
  const total = values.reduce((sum, value) => {
    const negative = value.startsWith('-')
    const [whole, fraction = ''] = value.replace(/^-/, '').split('.')
    const amount =
      BigInt(whole) * factor + BigInt(fraction.padEnd(scale, '0') || '0')
    return sum + (negative ? -amount : amount)
  }, 0n)
  const sign = total < 0n ? '-' : ''
  const absolute = total < 0n ? -total : total
  const whole = absolute / factor
  const fraction = scale
    ? `.${(absolute % factor).toString().padStart(scale, '0').replace(/0+$/, '')}`
    : ''
  return `${sign}${whole}${fraction === '.' ? '' : fraction}`
}

function validateTerminalState(value: JsonRecord): boolean {
  return (
    value.schema_version === 'paper-futures-terminal-state.v1' &&
    value.currency === 'USD' &&
    value.quantity_unit === 'BTC' &&
    isRecord(value.account) &&
    typeof value.account.funding_complete === 'boolean' &&
    (value.account.funding_complete
      ? typeof value.account.net_usd === 'string'
      : value.account.net_usd === null)
  )
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFundingPolicyEvidence(value: unknown): value is JsonRecord {
  if (
    !isRecord(value) ||
    typeof value.observation_id !== 'string' ||
    !['known', 'unknown'].includes(String(value.status)) ||
    !Number.isSafeInteger(value.known_at_ms) ||
    (value.effective_start_ms !== null &&
      !Number.isSafeInteger(value.effective_start_ms)) ||
    (value.effective_end_ms !== null &&
      !Number.isSafeInteger(value.effective_end_ms)) ||
    typeof value.applicable_at_decision !== 'boolean' ||
    (value.reason !== null && typeof value.reason !== 'string')
  )
    return false
  const hasBoundaryIdentity = [
    'provider',
    'product',
    'field',
    'unit',
    'sha256',
    'semantic_version',
    'predicted',
  ].some((key) => key in value)
  return (
    !hasBoundaryIdentity ||
    (value.provider === 'kraken' &&
      value.product === 'PF_XBTUSD' &&
      value.field === 'funding_rate' &&
      value.unit === 'usd_per_btc_per_hour' &&
      typeof value.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(value.sha256) &&
      value.semantic_version === 'kraken-funding-normalization.v1' &&
      value.predicted === false)
  )
}

const LEDGER_VERSION = 'linear-usd-ledger.v1'
const COST_VERSION = 'kraken-futures-eea-btcusd-base.v1'
const RISK_RESULT_FIELDS = [
  'daily_loss_latched',
  'entry_paused',
  'user_paused',
  'system_paused',
  'utc_day',
  'opening_equity_usd',
  'mark_quality',
  'reduction_intent_id',
  'estimated_close_net_usd',
  'estimated_close_complete',
]

function assertKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional])
  for (const key of required)
    if (!(key in value)) throw new Error(`Missing required field: ${key}.`)
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Unsupported field: ${key}.`)
}

function canonicalDecimal(
  value: unknown,
  label: string,
  sign: 'any' | 'nonnegative' | 'positive' = 'any',
): string {
  if (typeof value !== 'string')
    throw new Error(`${label} must be a decimal string.`)
  const normalized = normalizeDecimal(value)
  if (normalized !== value)
    throw new Error(`${label} must be normalized plain decimal text.`)
  const comparison = compareDecimal(normalized, '0')
  if (sign === 'nonnegative' && comparison < 0)
    throw new Error(`${label} must be nonnegative.`)
  if (sign === 'positive' && comparison <= 0)
    throw new Error(`${label} must be positive.`)
  return normalized
}

function compareDecimal(left: string, right: string): number {
  const split = (text: string) => {
    const negative = text.startsWith('-')
    const unsigned = text.replace(/^[+-]/, '')
    const [integer, fraction = ''] = unsigned.split('.')
    return { negative, integer: integer!, fraction }
  }
  const a = split(left)
  const b = split(right)
  if (a.negative !== b.negative) return a.negative ? -1 : 1
  const sign = a.negative ? -1 : 1
  if (a.integer.length !== b.integer.length)
    return (a.integer.length < b.integer.length ? -1 : 1) * sign
  if (a.integer !== b.integer) return (a.integer < b.integer ? -1 : 1) * sign
  const width = Math.max(a.fraction.length, b.fraction.length)
  const af = a.fraction.padEnd(width, '0')
  const bf = b.fraction.padEnd(width, '0')
  if (af === bf) return 0
  return (af < bf ? -1 : 1) * sign
}

function validateFrozenRun(input: {
  runId: string
  config: unknown
  seed: unknown
  instrument: unknown
  costs: unknown
  runtime?: unknown
}): void {
  if (
    !input.runId.trim() ||
    !isRecord(input.config) ||
    !isRecord(input.seed) ||
    !isRecord(input.instrument) ||
    !isRecord(input.costs)
  )
    throw new Error('Invalid frozen futures run identity.')
  assertKeys(
    input.config,
    ['ledger_version', 'decimal_precision', 'leverage'],
    ['mode', 'mode_config_hash'],
  )
  assertKeys(input.seed, ['cash_usd'], ['seed', 'source', 'terminal_market'])
  assertKeys(input.instrument, ['instrument_id'])
  assertKeys(input.costs, ['version', 'maker', 'taker'])
  if (
    input.config.ledger_version !== LEDGER_VERSION ||
    !Number.isSafeInteger(input.config.decimal_precision) ||
    (input.config.decimal_precision as number) < 28 ||
    (input.config.decimal_precision as number) > 100
  )
    throw new Error('Unsupported frozen ledger configuration.')
  if (
    (input.config.mode !== undefined &&
      !['mock', 'paper_live', 'replay'].includes(String(input.config.mode))) ||
    (input.config.mode_config_hash !== undefined &&
      (typeof input.config.mode_config_hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(input.config.mode_config_hash)))
  )
    throw new Error('Unsupported frozen futures run mode metadata.')
  const leverage = canonicalDecimal(
    input.config.leverage,
    'leverage',
    'positive',
  )
  if (compareDecimal(leverage, '1') > 0)
    throw new Error('Futures laboratory leverage cannot exceed 1x.')
  canonicalDecimal(input.seed.cash_usd, 'seed cash', 'nonnegative')
  if (input.seed.terminal_market !== undefined) {
    if (input.config.mode !== 'mock' && input.config.mode !== 'replay')
      throw new Error(
        'Terminal market data is only valid for MOCK or REPLAY runs.',
      )
    validateTerminalMarketFixture(input.seed.terminal_market, input.config.mode)
  }
  if (
    typeof input.instrument.instrument_id !== 'string' ||
    !input.instrument.instrument_id.trim()
  )
    throw new Error('Frozen instrument identity is required.')
  if (
    input.costs.version !== COST_VERSION ||
    canonicalDecimal(input.costs.maker, 'maker fee', 'nonnegative') !==
      '0.0002' ||
    canonicalDecimal(input.costs.taker, 'taker fee', 'nonnegative') !== '0.0005'
  )
    throw new Error('Unsupported frozen futures cost identity.')
  if (input.runtime !== undefined) {
    const frozen = {
      config: input.config,
      seed: input.seed,
      instrument: input.instrument,
      costs: input.costs,
      runtime: input.runtime,
    }
    validateRuntimeBinding(input.runtime, frozen)
  }
}

function validateTerminalMarketFixture(
  value: unknown,
  mode: 'mock' | 'replay',
): void {
  if (!isRecord(value)) throw new Error('Terminal market data is invalid.')
  assertKeys(value, ['schema_version', 'as_of_ms', 'interval_ms', 'candles'])
  if (
    value.schema_version !==
      (mode === 'mock'
        ? 'mock-terminal-market.v1'
        : 'futures-terminal-market.v1') ||
    !Number.isSafeInteger(value.as_of_ms) ||
    (value.as_of_ms as number) < 0 ||
    ![60_000, 300_000, 900_000, 3_600_000].includes(
      Number(value.interval_ms),
    ) ||
    !Array.isArray(value.candles) ||
    value.candles.length > 500
  )
    throw new Error('Terminal market version or bounds are invalid.')
  let previousTime = -1
  for (const candidate of value.candles) {
    if (!isRecord(candidate))
      throw new Error('Terminal fixture candle is invalid.')
    assertKeys(candidate, [
      'time_ms',
      'open',
      'high',
      'low',
      'close',
      'volume_btc',
      'closed',
    ])
    if (
      !Number.isSafeInteger(candidate.time_ms) ||
      (candidate.time_ms as number) <= previousTime ||
      (candidate.time_ms as number) + Number(value.interval_ms) >
        (value.as_of_ms as number) ||
      candidate.closed !== true
    )
      throw new Error(
        'Terminal fixture candles must be ordered and closed as of the snapshot.',
      )
    previousTime = candidate.time_ms as number
    const open = canonicalDecimal(
      candidate.open,
      'terminal candle open',
      'positive',
    )
    const high = canonicalDecimal(
      candidate.high,
      'terminal candle high',
      'positive',
    )
    const low = canonicalDecimal(
      candidate.low,
      'terminal candle low',
      'positive',
    )
    const close = canonicalDecimal(
      candidate.close,
      'terminal candle close',
      'positive',
    )
    canonicalDecimal(
      candidate.volume_btc,
      'terminal candle volume',
      'nonnegative',
    )
    if (
      compareDecimal(high, low) < 0 ||
      compareDecimal(high, open) < 0 ||
      compareDecimal(high, close) < 0 ||
      compareDecimal(low, open) > 0 ||
      compareDecimal(low, close) > 0
    )
      throw new Error('Terminal fixture OHLC values are inconsistent.')
  }
}

function validateRuntimeBinding(value: unknown, frozen: JsonRecord): void {
  if (!isRecord(value)) throw new Error('Runtime binding must be an object.')
  if (
    value.schema_version === 'futures-runtime-binding.v2' ||
    value.schema_version === 'futures-runtime-binding.v4' ||
    value.schema_version === 'futures-runtime-binding.v5'
  ) {
    assertKeys(value, [
      'schema_version',
      'runtime_config',
      'instrument_spec',
      'strategy_manifest',
      'strategy_config_hash',
      ...(value.schema_version === 'futures-runtime-binding.v5'
        ? ['admission_policy']
        : []),
    ])
    if (
      value.schema_version === 'futures-runtime-binding.v5' &&
      (!isRecord(value.admission_policy) ||
        value.admission_policy.schema_version !==
          'futures-entry-admission.v1' ||
        value.admission_policy.evaluation_interval_ms !== 5000 ||
        value.admission_policy.hash !==
          canonicalHash({
            schema_version: 'futures-entry-admission.v1',
            evaluation_interval_ms: 5000,
          }))
    )
      throw new Error('Unsupported frozen entry-admission policy.')
    const manifest = value.strategy_manifest
    const expectedManifest = {
      config_version: 'futures-strategies-config.v1',
      indicator_version: 'futures-closed-indicators.v1',
      strategy_ids: [
        'c25-pullback-perp-v1',
        'c26-reversion-perp-v1',
        'c27-breakout-perp-v1',
        'c28-adapter-perp-v1',
      ],
    }
    if (
      !isRecord(manifest) ||
      canonicalJson(manifest) !== canonicalJson(expectedManifest) ||
      value.strategy_config_hash !== canonicalHash(expectedManifest)
    )
      throw new Error('Unsupported or altered futures strategy manifest.')
  } else {
    assertKeys(value, ['schema_version', 'runtime_config', 'instrument_spec'])
  }
  if (
    (value.schema_version !== 'futures-runtime-binding.v1' &&
      value.schema_version !== 'futures-runtime-binding.v2' &&
      value.schema_version !== 'futures-runtime-binding.v3' &&
      value.schema_version !== 'futures-runtime-binding.v4' &&
      value.schema_version !== 'futures-runtime-binding.v5') ||
    !isRecord(value.runtime_config) ||
    !isRecord(value.instrument_spec)
  )
    throw new Error('Unsupported futures runtime binding.')
  const config = value.runtime_config
  assertKeys(
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
    value.schema_version === 'futures-runtime-binding.v4' ||
      value.schema_version === 'futures-runtime-binding.v5'
      ? [
          'daily_loss_fraction',
          ...(value.schema_version === 'futures-runtime-binding.v5'
            ? [
                'funding_policy_version',
                'strategy_selection_policy_version',
                'strategy_selection_interval_ms',
                'market_context_policy_version',
                'operative_checkpoint_policy_version',
              ]
            : []),
        ]
      : [],
  )
  if (
    'operative_checkpoint_policy_version' in config &&
    (value.schema_version !== 'futures-runtime-binding.v5' ||
      config.version !== 'futures-runtime-risk.v1' ||
      config.operative_checkpoint_policy_version !==
        OPERATIVE_CHECKPOINT_POLICY_VERSION)
  )
    throw new Error('Unsupported frozen operative checkpoint policy.')
  if ('funding_policy_version' in config) {
    if (
      value.schema_version !== 'futures-runtime-binding.v5' ||
      config.version !== 'futures-runtime-risk.v1' ||
      config.funding_policy_version !== 'funding-separation.v1'
    )
      throw new Error('Unsupported frozen funding-separation policy.')
  }
  if (
    'market_context_policy_version' in config &&
    (value.schema_version !== 'futures-runtime-binding.v5' ||
      config.version !== 'futures-runtime-risk.v1' ||
      config.market_context_policy_version !== 'market-context-transport.v1')
  )
    throw new Error('Unsupported frozen market-context transport policy.')
  if (
    ('strategy_selection_policy_version' in config &&
      (value.schema_version !== 'futures-runtime-binding.v5' ||
        config.version !== 'futures-runtime-risk.v1' ||
        config.strategy_selection_policy_version !==
          'strategy-selection-cadence.v1' ||
        config.strategy_selection_interval_ms !== 5000)) ||
    (config.strategy_selection_policy_version === undefined &&
      config.strategy_selection_interval_ms !== undefined)
  )
    throw new Error('Unsupported frozen strategy-selection cadence policy.')
  if (
    (value.schema_version === 'futures-runtime-binding.v4' ||
      value.schema_version === 'futures-runtime-binding.v5') &&
    config.daily_loss_fraction !== '0.01'
  )
    throw new Error('Unsupported frozen daily-loss risk limit.')
  if (
    config.version !==
      (value.schema_version === 'futures-runtime-binding.v2'
        ? 'futures-runtime-strategies.v1'
        : value.schema_version === 'futures-runtime-binding.v3'
          ? 'futures-runtime-execution.v1'
          : value.schema_version === 'futures-runtime-binding.v4' ||
              value.schema_version === 'futures-runtime-binding.v5'
            ? 'futures-runtime-risk.v1'
            : 'futures-runtime-lab.v1') ||
    config.cost_version !== (frozen.costs as JsonRecord).version
  )
    throw new Error('Unsupported futures runtime configuration.')
  for (const key of [
    'initial_cash_usd',
    'max_notional_usd',
    'max_exposure_multiple',
    'risk_fraction',
    'max_spread_bps',
    'maker_rate',
    'taker_rate',
  ])
    canonicalDecimal(
      config[key],
      `runtime ${key}`,
      key === 'initial_cash_usd' || key.endsWith('_rate')
        ? 'nonnegative'
        : 'positive',
    )
  if (
    compareDecimal(String(config.max_exposure_multiple), '1') > 0 ||
    compareDecimal(String(config.risk_fraction), '1') > 0 ||
    config.initial_cash_usd !== (frozen.seed as JsonRecord).cash_usd ||
    config.cost_version !== (frozen.costs as JsonRecord).version ||
    config.maker_rate !== (frozen.costs as JsonRecord).maker ||
    config.taker_rate !== (frozen.costs as JsonRecord).taker
  )
    throw new Error(
      'Runtime configuration conflicts with frozen seed or costs.',
    )
  for (const key of ['execution_latency_ms', 'max_book_age_ms'])
    if (
      !Number.isSafeInteger(config[key]) ||
      (config[key] as number) < 0 ||
      (config[key] as number) > 86_400_000
    )
      throw new Error(`Invalid runtime timing ${key}.`)
  if (
    (frozen.config as JsonRecord).decimal_precision !== 50 ||
    (frozen.config as JsonRecord).leverage !== '1'
  )
    throw new Error(
      'Runtime precision or leverage conflicts with frozen ledger config.',
    )
  const instrument = value.instrument_spec
  assertKeys(instrument, [
    'instrument_id',
    'provider_symbol',
    'quantity_step_btc',
    'minimum_quantity_btc',
    'price_tick_usd',
  ])
  if (
    instrument.instrument_id !==
      (frozen.instrument as JsonRecord).instrument_id ||
    instrument.provider_symbol !== 'PF_XBTUSD'
  )
    throw new Error('Runtime instrument conflicts with frozen instrument.')
  for (const key of [
    'quantity_step_btc',
    'minimum_quantity_btc',
    'price_tick_usd',
  ])
    canonicalDecimal(instrument[key], `instrument ${key}`, 'positive')
}

function validateExecutionCheckpoint(
  cp: JsonRecord,
  binding: JsonRecord,
  compact = false,
): void {
  const execution = cp.execution_checkpoint
  if (!isRecord(execution))
    throw new Error('Missing paper execution checkpoint.')
  assertKeys(
    execution,
    compact
      ? [
          'checkpoint_version',
          'model_version',
          'run_id',
          'instrument_id',
          'config',
          'orders',
          'position',
          'position_reduced',
          'book_budgets',
          'trade_budgets',
          'sequence',
          'last_cutoff_ms',
        ]
      : [
          'checkpoint_version',
          'model_version',
          'run_id',
          'instrument_id',
          'config',
          'orders',
          'events',
          'command_receipts',
          'position',
          'position_reduced',
          'book_budgets',
          'trade_budgets',
          'trade_ids',
          'sequence',
          'last_cutoff_ms',
        ],
  )
  const instrument = binding.instrument_spec as JsonRecord
  const config = execution.config
  if (
    ![
      ...(compact
        ? ['paper-execution-operative-checkpoint.v1']
        : ['paper-execution-checkpoint.v1', 'paper-execution-checkpoint.v2']),
    ].includes(String(execution.checkpoint_version)) ||
    execution.model_version !== 'paper-execution.v1' ||
    execution.run_id !== cp.run_id ||
    execution.instrument_id !== instrument.instrument_id ||
    !isRecord(config)
  )
    throw new Error('Execution checkpoint identity is invalid.')
  assertKeys(config, [
    'version',
    'latency_ms',
    'tick_size',
    'lot_size',
    'max_book_age_ms',
    'precision',
    'queue_model',
  ])
  const runtimeConfig = binding.runtime_config as JsonRecord
  if (
    config.version !== 'paper-execution.v1' ||
    config.latency_ms !== runtimeConfig.execution_latency_ms ||
    config.tick_size !== instrument.price_tick_usd ||
    config.lot_size !== instrument.quantity_step_btc ||
    config.max_book_age_ms !== runtimeConfig.max_book_age_ms ||
    config.precision !== 50 ||
    config.queue_model !== 'conservative.v1'
  )
    throw new Error('Execution checkpoint config differs from frozen binding.')
  if (
    !isRecord(execution.orders) ||
    !isRecord(execution.position) ||
    !Array.isArray(execution.book_budgets) ||
    !Array.isArray(execution.trade_budgets) ||
    (!compact &&
      (!Array.isArray(execution.events) ||
        !Array.isArray(execution.trade_ids) ||
        !isRecord(execution.command_receipts)))
  )
    throw new Error('Execution checkpoint collections are invalid.')
  if (
    compact &&
    Object.values(execution.orders).some(
      (order) =>
        !isRecord(order) ||
        !['accepted', 'partially_filled'].includes(String(order.state)),
    )
  )
    throw new Error('Compact execution checkpoint retains a terminal order.')
  if (
    compact ||
    execution.checkpoint_version === 'paper-execution-checkpoint.v2'
  ) {
    for (const candidate of execution.book_budgets) {
      if (
        !Array.isArray(candidate) ||
        candidate.length !== 2 ||
        !Array.isArray(candidate[0]) ||
        candidate[0].length !== 5 ||
        !candidate[0].every((part) => typeof part === 'string') ||
        !isRecord(candidate[1])
      )
        throw new Error('Execution checkpoint book budget identity is invalid.')
      const budget = candidate[1]
      assertKeys(budget, ['asks', 'bids'])
      for (const side of ['asks', 'bids']) {
        const levels = budget[side]
        if (compact) {
          // Compact budgets keep the exact identity-port shape: price -> remaining.
          if (!isRecord(levels))
            throw new Error(
              'Execution checkpoint book budget levels are invalid.',
            )
          for (const [price, quantity] of Object.entries(levels)) {
            canonicalDecimal(price, 'execution book budget price', 'positive')
            canonicalDecimal(
              quantity,
              'execution book budget quantity',
              'nonnegative',
            )
          }
          continue
        }
        if (!Array.isArray(levels))
          throw new Error(
            'Execution checkpoint book budget levels are invalid.',
          )
        const prices = new Set<string>()
        for (const level of levels) {
          if (
            !Array.isArray(level) ||
            level.length !== 2 ||
            typeof level[0] !== 'string' ||
            typeof level[1] !== 'string' ||
            prices.has(level[0])
          )
            throw new Error('Execution checkpoint book budget row is invalid.')
          canonicalDecimal(level[0], 'execution book budget price', 'positive')
          canonicalDecimal(
            level[1],
            'execution book budget quantity',
            'nonnegative',
          )
          prices.add(level[0])
        }
      }
    }
  }
  const position = execution.position
  assertKeys(position, ['side', 'quantity_btc'])
  const ledgerPosition = cp.ledger_position
  const expectedSide = isRecord(ledgerPosition) ? ledgerPosition.side : null
  const expectedQuantity = isRecord(ledgerPosition) ? ledgerPosition.qty : '0'
  if (
    position.side !== expectedSide ||
    position.quantity_btc !== expectedQuantity
  )
    throw new Error(
      'Execution checkpoint position differs from ledger checkpoint.',
    )
  canonicalDecimal(
    position.quantity_btc,
    'execution position quantity',
    position.side === null ? 'nonnegative' : 'positive',
  )
  if (
    position.side !== null &&
    position.side !== 'long' &&
    position.side !== 'short'
  )
    throw new Error('Execution checkpoint position side is invalid.')
  canonicalDecimal(
    execution.position_reduced,
    'execution reduced position',
    'nonnegative',
  )
  if (
    !Number.isSafeInteger(execution.sequence) ||
    Number(execution.sequence) < 0
  )
    throw new Error('Execution checkpoint event sequence is invalid.')
  if (execution.last_cutoff_ms !== null)
    normalizeTimestampMs(execution.last_cutoff_ms)
  const eventIds = new Set<string>()
  for (const event of compact ? [] : (execution.events as unknown[])) {
    if (
      !isRecord(event) ||
      typeof event.event_id !== 'string' ||
      !event.event_id ||
      eventIds.has(event.event_id) ||
      event.run_id !== cp.run_id ||
      event.instrument_id !== instrument.instrument_id ||
      typeof event.type !== 'string'
    )
      throw new Error('Execution checkpoint event identity is invalid.')
    eventIds.add(event.event_id)
    const common = ['event_id', 'type', 'run_id', 'instrument_id']
    const fields: Record<string, string[]> = {
      order_created: [
        'order_id',
        'order_type',
        'side',
        'quantity_btc',
        'decision_at_ms',
      ],
      order_accepted: [
        'order_id',
        'order_type',
        'side',
        'quantity_btc',
        'decision_at_ms',
        'eligible_at_ms',
        'model_version',
      ],
      fill: [
        'order_id',
        'fill_id',
        'quantity_btc',
        'price_usd',
        'fee_usd',
        'liquidity',
        'event_time_ms',
        'source_event_time_ms',
        'fee_rate',
        'notional_usd',
      ],
      order_filled: ['order_id', 'filled_quantity_btc', 'effective_at_ms'],
      cancelled: [
        'order_id',
        'reason',
        'effective_at_ms',
        'filled_quantity_btc',
      ],
      expired: ['order_id', 'effective_at_ms', 'filled_quantity_btc'],
      rejected: ['order_id', 'reason'],
      market_uncertainty: ['cutoff_ms', 'reason'],
      stop_triggered: [
        'order_id',
        'mark_price_usd',
        'stop_price_usd',
        'event_time_ms',
      ],
      queue_established: ['order_id', 'queue_ahead_btc', 'assumption'],
    }
    const eventFields = fields[event.type]
    if (!eventFields)
      throw new Error('Unsupported execution checkpoint event type.')
    assertKeys(event, [...common, ...eventFields])
    for (const key of [
      'decision_at_ms',
      'eligible_at_ms',
      'event_time_ms',
      'source_event_time_ms',
      'effective_at_ms',
      'cutoff_ms',
    ])
      if (key in event) normalizeTimestampMs(event[key])
    for (const key of [
      'quantity_btc',
      'filled_quantity_btc',
      'price_usd',
      'fee_usd',
      'fee_rate',
      'notional_usd',
      'mark_price_usd',
      'stop_price_usd',
      'queue_ahead_btc',
    ])
      if (key in event)
        canonicalDecimal(
          event[key],
          `execution event ${key}`,
          ['fee_usd', 'fee_rate', 'queue_ahead_btc'].includes(key)
            ? 'nonnegative'
            : 'positive',
        )
    if (
      event.type === 'fill' &&
      (!['maker', 'taker'].includes(String(event.liquidity)) ||
        typeof event.fill_id !== 'string' ||
        !event.fill_id)
    )
      throw new Error('Execution checkpoint fill fields are invalid.')
    if (
      'order_type' in event &&
      ![
        'market_ioc',
        'limit',
        'post_only',
        'stop_market',
        'reduce_only',
      ].includes(String(event.order_type))
    )
      throw new Error('Execution checkpoint order type is invalid.')
    if ('side' in event && !['buy', 'sell'].includes(String(event.side)))
      throw new Error('Execution checkpoint order side is invalid.')
  }
  for (const [orderId, candidate] of Object.entries(execution.orders)) {
    if (!isRecord(candidate))
      throw new Error('Execution order checkpoint is invalid.')
    assertKeys(candidate, [
      'intent',
      'remaining',
      'filled',
      'state',
      'eligible_at_ms',
      'expiry_ms',
      'triggered',
      'queue_ahead',
      'resting',
      'trade_seen',
      'receipt',
    ])
    const intent = candidate.intent
    if (!isRecord(intent))
      throw new Error('Execution intent checkpoint is invalid.')
    const kind = intent.order_type
    assertKeys(intent, [
      'run_id',
      'instrument_id',
      'order_id',
      'side',
      'order_type',
      'quantity_btc',
      'decision_at_ms',
      ...(kind === 'limit' || kind === 'post_only' ? ['limit_price_usd'] : []),
      ...(kind === 'stop_market' ? ['stop_price_usd'] : []),
      ...(intent.expire_at_ms === undefined ? [] : ['expire_at_ms']),
    ])
    if (
      intent.order_id !== orderId ||
      intent.run_id !== cp.run_id ||
      intent.instrument_id !== instrument.instrument_id ||
      !['buy', 'sell'].includes(String(intent.side)) ||
      ![
        'market_ioc',
        'limit',
        'post_only',
        'stop_market',
        'reduce_only',
      ].includes(String(kind)) ||
      ![
        'created',
        'accepted',
        'partially_filled',
        'filled',
        'cancelled',
        'rejected',
        'expired',
      ].includes(String(candidate.state)) ||
      !isRecord(candidate.receipt) ||
      !Array.isArray(candidate.trade_seen)
    )
      throw new Error(
        'Execution order checkpoint identity or state is invalid.',
      )
    canonicalDecimal(
      intent.quantity_btc,
      'execution intent quantity',
      'positive',
    )
    normalizeTimestampMs(intent.decision_at_ms)
    if (
      !Number.isSafeInteger(candidate.expiry_ms) &&
      candidate.expiry_ms !== null
    )
      throw new Error('Execution order expiry is invalid.')
    if (candidate.expiry_ms !== null) normalizeTimestampMs(candidate.expiry_ms)
    if (
      typeof candidate.triggered !== 'boolean' ||
      typeof candidate.resting !== 'boolean' ||
      !Array.isArray(candidate.trade_seen) ||
      candidate.trade_seen.some((tradeId) => typeof tradeId !== 'string')
    )
      throw new Error('Execution order state flags are invalid.')
    canonicalDecimal(
      candidate.remaining,
      'execution remaining quantity',
      'nonnegative',
    )
    canonicalDecimal(
      candidate.filled,
      'execution filled quantity',
      'nonnegative',
    )
    normalizeTimestampMs(candidate.eligible_at_ms)
  }
  if (!isRecord(cp.execution_metadata))
    throw new Error('Execution intent metadata is invalid.')
  for (const [orderId, metadata] of Object.entries(cp.execution_metadata)) {
    if (!isRecord(metadata) || !(orderId in execution.orders))
      throw new Error('Execution metadata has no associated order.')
    if (metadata.purpose === 'entry') {
      assertKeys(metadata, [
        'purpose',
        'side',
        'strategy_id',
        'signal_key',
        'stop',
        'target',
        'donchian_mid',
        'selected',
      ])
      if (
        !['long', 'short'].includes(String(metadata.side)) ||
        typeof metadata.strategy_id !== 'string' ||
        typeof metadata.signal_key !== 'string' ||
        (metadata.selected !== null && !isRecord(metadata.selected))
      )
        throw new Error('Invalid immutable entry intent metadata.')
      canonicalDecimal(metadata.stop, 'entry stop', 'positive')
      canonicalDecimal(metadata.target, 'entry target', 'positive')
      canonicalDecimal(metadata.donchian_mid, 'entry midline')
    } else if (metadata.purpose === 'close') {
      assertKeys(metadata, ['purpose', 'side', 'reason'])
      if (
        !['long', 'short'].includes(String(metadata.side)) ||
        typeof metadata.reason !== 'string'
      )
        throw new Error('Invalid immutable exit intent metadata.')
    } else throw new Error('Unknown execution intent purpose.')
  }
}

function validateRiskCheckpoint(
  value: unknown,
  output: JsonRecord,
  binding: JsonRecord,
  checkpoint: JsonRecord,
): void {
  if (!isRecord(value)) throw new Error('Missing daily risk checkpoint.')
  assertKeys(value, [
    'utc_day',
    'opening_equity_usd',
    'daily_loss_latched',
    'entry_paused',
    'user_paused',
    'system_paused',
    'mark_quality',
    'reduction_intent_id',
  ])
  if (
    typeof value.utc_day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.utc_day) ||
    ![
      'daily_loss_latched',
      'entry_paused',
      'user_paused',
      'system_paused',
    ].every((key) => typeof value[key] === 'boolean') ||
    !['unknown', 'valid', 'stale', 'gapped'].includes(
      String(value.mark_quality),
    ) ||
    (value.reduction_intent_id !== null &&
      typeof value.reduction_intent_id !== 'string')
  )
    throw new Error('Invalid daily risk checkpoint fields.')
  if (value.opening_equity_usd !== null)
    canonicalDecimal(
      value.opening_equity_usd,
      'risk opening equity',
      'positive',
    )
  if (value.daily_loss_latched === true && value.entry_paused !== true)
    throw new Error('Daily loss latch must keep entries paused.')
  if (value.reduction_intent_id !== null) {
    const execution = checkpoint.execution_checkpoint
    if (!isRecord(execution) || !isRecord(execution.orders))
      throw new Error(
        'Risk reduction intent has no execution order checkpoint.',
      )
    const order = execution.orders[value.reduction_intent_id]
    if (
      !isRecord(order) ||
      !isRecord(order.intent) ||
      order.intent.order_type !== 'reduce_only'
    )
      throw new Error(
        'Risk reduction intent does not bind to a reduce-only order.',
      )
  }
  if (
    canonicalJson(value) !==
    canonicalJson({
      utc_day: output.risk && (output.risk as JsonRecord).utc_day,
      opening_equity_usd: (output.risk as JsonRecord).opening_equity_usd,
      daily_loss_latched: (output.risk as JsonRecord).daily_loss_latched,
      entry_paused: (output.risk as JsonRecord).entry_paused,
      user_paused: (output.risk as JsonRecord).user_paused,
      system_paused: (output.risk as JsonRecord).system_paused,
      mark_quality: (output.risk as JsonRecord).mark_quality,
      reduction_intent_id: (output.risk as JsonRecord).reduction_intent_id,
    })
  )
    throw new Error('Risk output differs from the durable risk checkpoint.')
  const config = binding.runtime_config as JsonRecord
  if (config.daily_loss_fraction !== '0.01')
    throw new Error('Daily risk limit differs from frozen configuration.')
}

function validateFundingPolicy(
  outputValue: unknown,
  checkpointValue: unknown,
  output: JsonRecord,
  checkpoint: JsonRecord,
  decisionTime: number,
): void {
  if (!isRecord(outputValue) || !isRecord(checkpointValue))
    throw new Error('Funding-separation output and checkpoint are required.')
  const outputPolicy = outputValue
  const savedPolicy = checkpointValue
  const causes = outputPolicy.entry_block_causes
  const fundingCauses = savedPolicy.funding_entry_causes
  const obligations = outputPolicy.pending_financial_obligations
  const evidence = outputPolicy.evidence
  const allowedCauses = new Set([
    'funding_unavailable',
    'funding_accounting_incomplete',
    'user_paused',
    'daily_loss_latched',
    'legacy_system_paused',
    'risk_mark_unavailable',
    'unclassified_restored_pause',
  ])
  const obligationKinds = new Set([
    'open_position',
    'position_protection',
    'reduction_intent',
    'active_order',
  ])
  if (
    outputPolicy.contract_version !== 'funding-separation.v1' ||
    outputPolicy.version !== 'funding-separation.v1' ||
    savedPolicy.contract_version !== 'funding-separation.v1' ||
    savedPolicy.version !== 'funding-separation.v1' ||
    !['known', 'unknown'].includes(String(outputPolicy.availability)) ||
    savedPolicy.availability !== outputPolicy.availability ||
    !Array.isArray(causes) ||
    !causes.every(
      (cause) => typeof cause === 'string' && allowedCauses.has(cause),
    ) ||
    !Array.isArray(fundingCauses) ||
    !fundingCauses.every(
      (cause) => typeof cause === 'string' && allowedCauses.has(cause),
    ) ||
    !Array.isArray(obligations) ||
    !obligations.every(
      (item) => isRecord(item) && obligationKinds.has(String(item.kind)),
    ) ||
    (evidence !== null && !isFundingPolicyEvidence(evidence)) ||
    (outputPolicy.availability === 'known' &&
      (!isRecord(evidence) ||
        evidence.status !== 'known' ||
        evidence.applicable_at_decision !== true ||
        evidence.reason !== null ||
        Number(evidence.effective_start_ms) > decisionTime ||
        decisionTime >= Number(evidence.effective_end_ms))) ||
    (outputPolicy.availability === 'unknown' &&
      evidence !== null &&
      (!isRecord(evidence) || evidence.applicable_at_decision !== false)) ||
    typeof savedPolicy.funding_data_pause_active !== 'boolean' ||
    typeof savedPolicy.risk_mark_pause_active !== 'boolean' ||
    !('evidence' in outputPolicy) ||
    canonicalJson(causes) !== canonicalJson(savedPolicy.entry_block_causes) ||
    canonicalJson(obligations) !==
      canonicalJson(savedPolicy.pending_financial_obligations)
  )
    throw new Error('Funding-separation metadata is invalid or inconsistent.')
  const risk = output.risk as JsonRecord
  const ledgerPosition = checkpoint.ledger_position
  const openPosition = isRecord(ledgerPosition)
  const openObligations = obligations.filter(
    (item) => item.kind === 'open_position',
  )
  const protectionObligations = obligations.filter(
    (item) => item.kind === 'position_protection',
  )
  const reductionObligations = obligations.filter(
    (item) => item.kind === 'reduction_intent',
  )
  const activeOrderObligations = obligations.filter(
    (item) => item.kind === 'active_order',
  )
  const execution = checkpoint.execution_checkpoint
  const executionOrders =
    isRecord(execution) && isRecord(execution.orders)
      ? Object.entries(execution.orders).filter(
          ([, order]) =>
            isRecord(order) &&
            ['accepted', 'partially_filled'].includes(String(order.state)),
        )
      : []
  if (
    (outputPolicy.availability === 'unknown') !==
      fundingCauses.includes('funding_unavailable') ||
    (risk.entry_paused !== true && causes.length > 0) ||
    (risk.user_paused === true && !causes.includes('user_paused')) ||
    (risk.daily_loss_latched === true &&
      !causes.includes('daily_loss_latched')) ||
    (risk.system_paused === true && !causes.includes('legacy_system_paused')) ||
    (checkpoint.funding_complete === false &&
      !causes.includes('funding_accounting_incomplete')) ||
    canonicalJson(risk.entry_block_causes) !== canonicalJson(causes) ||
    risk.funding_availability !== outputPolicy.availability ||
    openObligations.length !== (openPosition ? 1 : 0) ||
    protectionObligations.length !==
      (checkpoint.position_protection === null ? 0 : 1) ||
    activeOrderObligations.length !== executionOrders.length ||
    new Set(activeOrderObligations.map((item) => item.order_id)).size !==
      activeOrderObligations.length ||
    activeOrderObligations.some(
      (item) =>
        !executionOrders.some(
          ([orderId, order]) =>
            item.order_id === orderId &&
            isRecord(order) &&
            item.state === order.state &&
            item.remaining_quantity_btc === order.remaining &&
            isRecord(order.intent) &&
            item.order_type === order.intent.order_type &&
            item.side === order.intent.side,
        ),
    ) ||
    (openPosition &&
      !openObligations.some(
        (item) =>
          item.side === ledgerPosition.side &&
          item.quantity_btc === ledgerPosition.qty &&
          item.owner_strategy_id === checkpoint.owner_strategy_id &&
          item.funding_cursor_ms === checkpoint.funding_cursor_ms &&
          item.opened_at_ms ===
            (isRecord(checkpoint.position_protection)
              ? checkpoint.position_protection.opened_at_ms
              : null) &&
          item.funding_clock ===
            (outputPolicy.availability === 'unknown' ||
            checkpoint.funding_complete === false
              ? 'unknown'
              : 'observation_available'),
      )) ||
    (checkpoint.position_protection !== null &&
      !protectionObligations.some(
        (item) =>
          item.signal_key ===
            (checkpoint.position_protection as JsonRecord).signal_key &&
          item.opened_at_ms ===
            (checkpoint.position_protection as JsonRecord).opened_at_ms,
      )) ||
    reductionObligations.length !==
      (isRecord(checkpoint.risk_checkpoint) &&
      typeof checkpoint.risk_checkpoint.reduction_intent_id === 'string'
        ? 1
        : 0) ||
    (reductionObligations.length === 1 &&
      reductionObligations[0]!.order_id !==
        (checkpoint.risk_checkpoint as JsonRecord).reduction_intent_id)
  )
    throw new Error(
      'Funding-separation causes disagree with ledger or risk state.',
    )
}

function validateStrategySelectionCheckpoint(
  checkpoint: JsonRecord,
  binding: JsonRecord,
  output: JsonRecord,
): void {
  const config = binding.runtime_config as JsonRecord
  const value = checkpoint.strategy_selection_checkpoint
  if (!isRecord(value))
    throw new Error('Missing strategy-selection checkpoint metadata.')
  assertKeys(value, [
    'policy_version',
    'interval_ms',
    'run_id',
    'instrument_id',
    'last_selection_ms',
    'next_selection_due_ms',
    'context',
  ])
  const last = value.last_selection_ms
  const next = value.next_selection_due_ms
  const execution = checkpoint.execution_checkpoint
  const lastExecution = isRecord(execution) ? execution.last_cutoff_ms : null
  const context = value.context
  if (
    config.strategy_selection_policy_version !==
      'strategy-selection-cadence.v1' ||
    config.strategy_selection_interval_ms !== 5000 ||
    value.policy_version !== 'strategy-selection-cadence.v1' ||
    value.interval_ms !== 5000 ||
    value.run_id !== checkpoint.run_id ||
    value.instrument_id !== checkpoint.instrument_id ||
    !Number.isSafeInteger(lastExecution) ||
    (last !== null &&
      (!Number.isSafeInteger(last) ||
        (last as number) < 0 ||
        (last as number) > Number.MAX_SAFE_INTEGER - 5000 ||
        (last as number) > (lastExecution as number) ||
        next !== (last as number) + 5000)) ||
    (last === null && (next !== null || context !== null)) ||
    (last !== null && !isRecord(context))
  )
    throw new Error(
      'Strategy-selection checkpoint identity or clock is invalid.',
    )
  if (last === null) return
  if (!isRecord(context))
    throw new Error('Strategy-selection checkpoint cache is invalid.')
  assertKeys(context, ['proposals', 'selector', 'regime', 'as_of_ms'])
  const manifest = binding.strategy_manifest
  const strategyIds = isRecord(manifest) ? manifest.strategy_ids : undefined
  if (
    !Array.isArray(strategyIds) ||
    strategyIds.length !== 4 ||
    !Array.isArray(context.proposals) ||
    context.proposals.length !== 4 ||
    !isRecord(context.selector) ||
    !['unknown', 'trend', 'range'].includes(String(context.regime)) ||
    context.as_of_ms !== last ||
    !isRecord(output.analysis) ||
    canonicalJson(context.proposals) !==
      canonicalJson(output.analysis.proposals) ||
    canonicalJson(context.selector) !==
      canonicalJson(output.analysis.selector) ||
    context.regime !== output.analysis.regime ||
    ('as_of_ms' in output.analysis && output.analysis.as_of_ms !== last)
  )
    throw new Error('Strategy-selection checkpoint cache is invalid.')
  for (let index = 0; index < strategyIds.length; index += 1) {
    const proposal = context.proposals[index]
    if (
      !isRecord(proposal) ||
      proposal.strategy_id !== strategyIds[index] ||
      !['LONG', 'SHORT', 'FLAT', 'WAIT', 'ABSTAIN'].includes(
        String(proposal.action),
      )
    )
      throw new Error('Strategy-selection proposal cache is invalid.')
  }
  const selector = context.selector
  if (
    !['LONG', 'SHORT', 'FLAT', 'WAIT', 'ABSTAIN'].includes(
      String(selector.action),
    )
  )
    throw new Error('Strategy-selection selector cache is invalid.')
  if (
    (selector.action === 'LONG' || selector.action === 'SHORT') &&
    !context.proposals.some(
      (candidate) =>
        isRecord(candidate) &&
        candidate.strategy_id === selector.strategy_id &&
        candidate.action === selector.action &&
        candidate.signal_key === selector.signal_key,
    )
  )
    throw new Error('Directional selector cache does not match a proposal.')
}

const EXECUTION_IDENTITY_KINDS = [
  'order',
  'cancel',
  'trade',
  'book_budget',
  'trade_budget',
  'order_trade',
  'signal',
]
const LEDGER_IDENTITY_KINDS = [
  'ledger_fill',
  'ledger_funding',
  'ledger_accrual',
]

/** Exact drained updates: required for opted-in runs, forbidden otherwise. */
function parseOperativeIdentityUpdates(
  value: unknown,
  operative: boolean,
): FuturesOperativeIdentityUpdate[] {
  if (!operative) {
    if (value !== undefined)
      throw new Error('Unexpected operative identity updates.')
    return []
  }
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'execution,ledger' ||
    !Array.isArray(value.execution) ||
    !Array.isArray(value.ledger)
  )
    throw new Error('Operative identity updates are required and exact.')
  const parse = (items: unknown[], kinds: string[]) =>
    items.map((item) => {
      if (
        !isRecord(item) ||
        Object.keys(item).sort().join(',') !== 'key,kind,provenance,value' ||
        typeof item.kind !== 'string' ||
        !kinds.includes(item.kind) ||
        typeof item.key !== 'string' ||
        typeof item.provenance !== 'string'
      )
        throw new Error('Malformed operative identity update.')
      return {
        kind: item.kind,
        key: item.key,
        value: item.value,
        provenance: item.provenance,
      } as FuturesOperativeIdentityUpdate
    })
  return [
    ...parse(value.execution, EXECUTION_IDENTITY_KINDS),
    ...parse(value.ledger, LEDGER_IDENTITY_KINDS),
  ]
}

function operativeSourceFrontier(checkpoint: unknown): number {
  if (!isRecord(checkpoint)) return 0
  const context = checkpoint.market_context_checkpoint
  if (context === undefined || context === null) return 0
  if (!isRecord(context) || !Number.isSafeInteger(context.frontier))
    throw new Error('Operative checkpoint has no valid source frontier.')
  return Number(context.frontier)
}

function validateRuntimeWork(
  value: JsonRecord,
  frozen: JsonRecord,
  runId: string,
  version: number,
): void {
  if (!('runtime' in frozen))
    throw new Error('Runtime work requires a frozen runtime binding.')
  validateRuntimeBinding(frozen.runtime, frozen)
  if (!isRecord(value.runtime_checkpoint) || !isRecord(value.runtime_output))
    throw new Error('Runtime work checkpoint and output are required.')
  const rawCp = value.runtime_checkpoint
  const output = value.runtime_output
  const compact = isOperativeRuntimeConfig(
    (frozen.runtime as JsonRecord).runtime_config,
  )
  // Compact operative state is validated through a legacy-shaped read view so
  // every ledger, order and risk invariant below still applies to it.
  const cp: JsonRecord = compact
    ? {
        ...operativeCheckpointView(rawCp),
        ledger_events: isRecord(value.result) ? value.result.events : undefined,
      }
    : rawCp
  if (
    isRecord(output.ledger) &&
    output.ledger.mark_usd_per_btc === null &&
    (!isRecord(cp.market_context_checkpoint) ||
      cp.market_context_checkpoint.source_identity !== null ||
      cp.market_context_checkpoint.frontier !== 0)
  )
    throw new Error(
      'Unmarked account valuation is restricted to cold unbound state.',
    )
  const binding = frozen.runtime as JsonRecord
  const strategyRuntime =
    binding.schema_version === 'futures-runtime-binding.v2' ||
    binding.schema_version === 'futures-runtime-binding.v4' ||
    binding.schema_version === 'futures-runtime-binding.v5'
  const executionRuntime =
    binding.schema_version === 'futures-runtime-binding.v3' ||
    binding.schema_version === 'futures-runtime-binding.v4' ||
    binding.schema_version === 'futures-runtime-binding.v5'
  const riskRuntime =
    binding.schema_version === 'futures-runtime-binding.v4' ||
    binding.schema_version === 'futures-runtime-binding.v5'
  if (compact && !riskRuntime)
    throw new Error('Operative checkpoints require the risk runtime.')
  assertKeys(
    rawCp,
    compact
      ? [
          'schema_version',
          'runtime_version',
          'run_id',
          'instrument_id',
          'runtime_config',
          'instrument_spec',
          'operative_checkpoint_policy_version',
          'execution_operative_checkpoint',
          'ledger_operative_checkpoint',
          'funding_cursor_ms',
          'owner_strategy_id',
          'position_protection',
          'signal_keys',
          'regime',
          'execution_metadata',
          'risk_checkpoint',
        ]
      : [
          'schema_version',
          'runtime_version',
          'run_id',
          'instrument_id',
          'runtime_config',
          'instrument_spec',
          'cash_usd',
          'leverage',
          'realized_gross_usd',
          'fees_usd',
          'funding_paid',
          'funding_complete',
          'funding_cursor_ms',
          'ledger_last_accrual_ms',
          'ledger_position',
          'funding_rates',
          'accrued',
          'ledger_events',
          'owner_strategy_id',
          'position_protection',
          'signal_keys',
          'consumed_depth',
          ...(strategyRuntime || executionRuntime ? ['regime'] : []),
          ...(executionRuntime
            ? ['execution_checkpoint', 'execution_metadata']
            : []),
          ...(riskRuntime ? ['risk_checkpoint'] : []),
        ],
    [
      ...((binding.runtime_config as JsonRecord).funding_policy_version ===
      'funding-separation.v1'
        ? ['funding_policy_checkpoint']
        : []),
      ...((binding.runtime_config as JsonRecord)
        .strategy_selection_policy_version === 'strategy-selection-cadence.v1'
        ? ['strategy_selection_checkpoint']
        : []),
      ...((binding.runtime_config as JsonRecord)
        .market_context_policy_version === 'market-context-transport.v1'
        ? ['market_context_checkpoint']
        : []),
    ],
  )
  if (
    compact &&
    rawCp.operative_checkpoint_policy_version !==
      OPERATIVE_CHECKPOINT_POLICY_VERSION
  )
    throw new Error('Operative checkpoint policy marker drifted.')
  if (
    cp.schema_version !==
      (riskRuntime ? 4 : executionRuntime ? 3 : strategyRuntime ? 2 : 1) ||
    cp.runtime_version !==
      (riskRuntime
        ? 'futures-runtime-risk.v1'
        : executionRuntime
          ? 'futures-runtime-execution.v1'
          : strategyRuntime
            ? 'futures-strategy-baseline-perp-v1'
            : 'c27-breakout-perp-v1') ||
    cp.run_id !== runId ||
    cp.runtime_config === undefined ||
    cp.instrument_spec === undefined ||
    cp.runtime_config === null ||
    cp.instrument_spec === null
  )
    throw new Error('Unsupported or mismatched runtime checkpoint identity.')
  if (
    canonicalJson(cp.runtime_config) !==
      canonicalJson(binding.runtime_config) ||
    canonicalJson(cp.instrument_spec) !==
      canonicalJson(binding.instrument_spec) ||
    cp.instrument_id !== (binding.instrument_spec as JsonRecord).instrument_id
  )
    throw new Error('Runtime checkpoint configuration or instrument drifted.')
  const marketContextCheckpoint = cp.market_context_checkpoint
  const marketContextAnchors = isRecord(marketContextCheckpoint)
    ? marketContextCheckpoint.anchors
    : undefined
  const marketContextUnbound =
    isRecord(marketContextCheckpoint) &&
    marketContextCheckpoint.source_identity === null &&
    marketContextCheckpoint.frontier === 0 &&
    isRecord(marketContextAnchors) &&
    Object.keys(marketContextAnchors).length === 0 &&
    cp.ledger_position === null &&
    cp.position_protection === null &&
    isRecord(cp.execution_checkpoint) &&
    isRecord(cp.execution_checkpoint.orders) &&
    Object.values(cp.execution_checkpoint.orders).every(
      (order) =>
        isRecord(order) &&
        !['accepted', 'partially_filled'].includes(String(order.state)),
    ) &&
    (isRecord(cp.risk_checkpoint)
      ? cp.risk_checkpoint.reduction_intent_id === null
      : false) &&
    (isRecord(cp.funding_policy_checkpoint)
      ? Array.isArray(
          cp.funding_policy_checkpoint.pending_financial_obligations,
        ) &&
        cp.funding_policy_checkpoint.pending_financial_obligations.length === 0
      : true)
  if (
    (binding.runtime_config as JsonRecord).market_context_policy_version ===
    'market-context-transport.v1'
      ? !isRecord(marketContextCheckpoint) ||
        Object.keys(marketContextCheckpoint).sort().join(',') !==
          'anchors,frontier,instrument_id,knowledge_cutoff_ms,policy_version,source_identity' ||
        marketContextCheckpoint.policy_version !==
          'market-context-transport.v1' ||
        (marketContextCheckpoint.source_identity !== null &&
          (typeof marketContextCheckpoint.source_identity !== 'string' ||
            !/^[a-f0-9]{64}$/.test(marketContextCheckpoint.source_identity))) ||
        (marketContextCheckpoint.source_identity === null &&
          !marketContextUnbound) ||
        marketContextCheckpoint.instrument_id !==
          (binding.instrument_spec as JsonRecord).instrument_id ||
        !Number.isSafeInteger(marketContextCheckpoint.frontier) ||
        Number(marketContextCheckpoint.frontier) < 0 ||
        !Number.isSafeInteger(marketContextCheckpoint.knowledge_cutoff_ms) ||
        !isRecord(marketContextAnchors) ||
        Object.keys(marketContextAnchors).some(
          (key) =>
            !['book_snapshot', 'ticker'].includes(key) ||
            !isRecord(marketContextAnchors[key]) ||
            marketContextAnchors[key].context_anchor !== true ||
            marketContextAnchors[key].type !== key,
        )
      : cp.market_context_checkpoint !== undefined
  )
    throw new Error('Runtime market-context checkpoint policy drifted.')
  if (
    value.applied_state_version !== version ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    value.protocol_version !== 1 ||
    value.schema_version !==
      (riskRuntime
        ? 'futures-runtime-work.v3'
        : executionRuntime
          ? 'futures-runtime-work.v2'
          : 'futures-runtime-work.v1')
  )
    throw new Error('Invalid versioned runtime work identity.')
  assertKeys(
    output,
    [
      'schema_version',
      'run_id',
      'runtime_version',
      'analysis',
      'risk',
      'orders',
      'fills',
      'position',
      'ledger',
      'valuation_source',
      ...(executionRuntime ? ['execution_events'] : []),
    ],
    [
      ...((binding.runtime_config as JsonRecord).funding_policy_version ===
      'funding-separation.v1'
        ? ['funding_policy']
        : []),
    ],
  )
  if (
    output.schema_version !== 'futures-runtime-result.v1' ||
    output.run_id !== runId ||
    output.runtime_version !== cp.runtime_version ||
    !isRecord(output.analysis) ||
    !isRecord(output.risk) ||
    !Array.isArray(output.orders) ||
    !Array.isArray(output.fills) ||
    !isRecord(output.position) ||
    !isRecord(output.ledger) ||
    (output.valuation_source !== 'ticker_mark' &&
      output.valuation_source !== 'observed_book_midpoint' &&
      output.valuation_source !== 'unavailable')
  )
    throw new Error('Invalid C27 runtime output shape.')
  const cadenceEnabled =
    (binding.runtime_config as JsonRecord).strategy_selection_policy_version ===
    'strategy-selection-cadence.v1'
  if (cadenceEnabled) {
    validateStrategySelectionCheckpoint(cp, binding, output)
  } else if ('strategy_selection_checkpoint' in cp) {
    throw new Error('Unexpected strategy-selection checkpoint metadata.')
  }
  if (executionRuntime) validateExecutionCheckpoint(cp, binding, compact)
  if (riskRuntime)
    validateRiskCheckpoint(cp.risk_checkpoint, output, binding, cp)
  if (
    (binding.runtime_config as JsonRecord).funding_policy_version ===
    'funding-separation.v1'
  )
    validateFundingPolicy(
      output.funding_policy,
      cp.funding_policy_checkpoint,
      output,
      cp,
      Number(value.runtime_event_time_ms),
    )
  assertKeys(
    output.analysis,
    [
      'strategy_id',
      'selected_strategy_id',
      'action',
      'reason_codes',
      'features',
      'strategy_status',
      ...(strategyRuntime ? ['proposals', 'selector', 'regime'] : []),
    ],
    cadenceEnabled ? ['as_of_ms'] : [],
  )
  if (
    typeof output.analysis.action !== 'string' ||
    !Array.isArray(output.analysis.reason_codes) ||
    output.analysis.reason_codes.some((code) => typeof code !== 'string') ||
    !isRecord(output.analysis.features) ||
    typeof output.analysis.strategy_status !== 'string'
  )
    throw new Error('Invalid runtime analysis evidence.')
  if (
    cadenceEnabled &&
    'as_of_ms' in output.analysis &&
    output.analysis.as_of_ms !==
      (cp.strategy_selection_checkpoint as JsonRecord).last_selection_ms
  )
    throw new Error('Cached strategy-selection display time is inconsistent.')
  if (strategyRuntime) {
    if (
      !['unknown', 'trend', 'range'].includes(String(output.analysis.regime)) ||
      cp.regime !== output.analysis.regime ||
      !Array.isArray(output.analysis.proposals) ||
      output.analysis.proposals.length !== 4 ||
      !isRecord(output.analysis.selector)
    )
      throw new Error('Invalid versioned strategy analysis state.')
    const strategyIds = [
      'c25-pullback-perp-v1',
      'c26-reversion-perp-v1',
      'c27-breakout-perp-v1',
      'c28-adapter-perp-v1',
    ]
    output.analysis.proposals.forEach((proposal, index) => {
      if (!isRecord(proposal)) throw new Error('Invalid strategy proposal.')
      assertKeys(
        proposal,
        [
          'strategy_id',
          'strategy_version',
          'action',
          'reason_code',
          'conditions',
          'feature_age_ms',
          'supported_direction',
          'invalidation',
          'proposed_stop',
          'proposed_target',
          'horizon_minutes',
          'estimated_round_trip_cost_bps',
          'status',
          'delegated_strategy_id',
          'signal_key',
        ],
        ['stop_distance', 'target_distance'],
      )
      if (
        proposal.strategy_id !== strategyIds[index] ||
        !strategyIds.includes(String(proposal.strategy_version)) ||
        !['LONG', 'SHORT', 'FLAT', 'WAIT', 'ABSTAIN'].includes(
          String(proposal.action),
        ) ||
        typeof proposal.reason_code !== 'string' ||
        !Array.isArray(proposal.conditions) ||
        !Array.isArray(proposal.supported_direction) ||
        proposal.supported_direction.some(
          (side) => side !== 'LONG' && side !== 'SHORT',
        ) ||
        !['ready', 'warming_up', 'invalid'].includes(String(proposal.status)) ||
        (proposal.delegated_strategy_id !== null &&
          proposal.delegated_strategy_id !== 'c25-pullback-perp-v1' &&
          proposal.delegated_strategy_id !== 'c26-reversion-perp-v1')
      )
        throw new Error('Invalid strategy proposal identity or diagnostics.')
      for (const key of [
        'proposed_stop',
        'proposed_target',
        'stop_distance',
        'target_distance',
      ])
        if (proposal[key] !== null && proposal[key] !== undefined)
          canonicalDecimal(proposal[key], `proposal ${key}`, 'nonnegative')
      for (const condition of proposal.conditions) {
        if (!isRecord(condition)) throw new Error('Invalid strategy condition.')
        assertKeys(condition, [
          'code',
          'value',
          'operator',
          'threshold',
          'passed',
        ])
        if (
          typeof condition.code !== 'string' ||
          typeof condition.operator !== 'string' ||
          typeof condition.passed !== 'boolean'
        )
          throw new Error('Invalid strategy condition fields.')
      }
    })
    const selector = output.analysis.selector
    assertKeys(
      selector,
      ['action', 'reason_code'],
      [
        'strategy_id',
        'strategy_version',
        'conditions',
        'feature_age_ms',
        'supported_direction',
        'invalidation',
        'proposed_stop',
        'proposed_target',
        'horizon_minutes',
        'estimated_round_trip_cost_bps',
        'status',
        'delegated_strategy_id',
        'signal_key',
        'stop_distance',
        'target_distance',
      ],
    )
    if (
      !['LONG', 'SHORT', 'FLAT', 'WAIT', 'ABSTAIN'].includes(
        String(selector.action),
      ) ||
      typeof selector.reason_code !== 'string'
    )
      throw new Error('Invalid strategy selector result.')
  }
  if (
    output.analysis.action !== 'long' &&
    output.analysis.action !== 'short' &&
    output.analysis.action !== 'WAIT' &&
    output.analysis.action !== 'FLAT'
  )
    throw new Error('Unsupported runtime action.')
  if (
    output.analysis.selected_strategy_id !== null &&
    !(strategyRuntime
      ? [
          'c25-pullback-perp-v1',
          'c26-reversion-perp-v1',
          'c27-breakout-perp-v1',
          'c28-adapter-perp-v1',
        ].includes(String(output.analysis.selected_strategy_id))
      : output.analysis.selected_strategy_id === 'c27-breakout-perp-v1')
  )
    throw new Error('Unsupported selected runtime strategy.')
  if (
    output.analysis.strategy_id !== null &&
    output.analysis.strategy_id !==
      (riskRuntime
        ? 'futures-runtime-risk.v1'
        : strategyRuntime
          ? 'futures-strategy-baseline-perp-v1'
          : executionRuntime
            ? 'futures-runtime-execution.v1'
            : 'c27-breakout-perp-v1')
  )
    throw new Error('Unsupported runtime strategy identity.')
  assertKeys(
    output.analysis.features,
    [
      'schema_version',
      'ready',
      'reason_codes',
      'candidate_close',
      'ema9',
      'ema21',
      'sma50',
      'rsi14',
      'atr14',
      'bollinger_mid20',
      'bollinger_variance20',
      'bollinger_stddev20',
      'bollinger_lower20',
      'bollinger_upper20',
      'bollinger_ddof',
      'donchian_high20',
      'donchian_low20',
      'prior_volume_mean20',
      'candidate_volume',
      'smoothing',
      'candidate_bucket_start_ms',
    ],
    strategyRuntime ? ['candidate_low', 'candidate_high'] : [],
  )
  if (
    output.analysis.features.schema_version !== 'c27-features.v1' ||
    typeof output.analysis.features.ready !== 'boolean' ||
    !Array.isArray(output.analysis.features.reason_codes) ||
    output.analysis.features.reason_codes.some(
      (code) => typeof code !== 'string',
    ) ||
    output.analysis.features.smoothing !== 'wilder' ||
    output.analysis.features.bollinger_ddof !== 0
  )
    throw new Error('Invalid C27 feature result.')
  if (
    !['accepted', 'not_applicable', 'not_evaluated', 'rejected'].includes(
      String(output.risk.status),
    ) ||
    !Array.isArray(output.risk.reason_codes) ||
    output.risk.reason_codes.some((code) => typeof code !== 'string')
  )
    throw new Error('Invalid runtime risk result.')
  if (output.risk.status === 'accepted') {
    assertKeys(
      output.risk,
      [
        'status',
        'quantity_btc',
        'risk_budget_usd',
        'estimated_round_trip_cost_usd',
        'stop_price_usd_per_btc',
        'target_price_usd_per_btc',
        'reason_codes',
      ],
      riskRuntime
        ? [
            ...RISK_RESULT_FIELDS,
            ...((binding.runtime_config as JsonRecord)
              .funding_policy_version === 'funding-separation.v1'
              ? ['entry_block_causes', 'funding_availability']
              : []),
          ]
        : [],
    )
    for (const field of [
      'quantity_btc',
      'risk_budget_usd',
      'estimated_round_trip_cost_usd',
      'stop_price_usd_per_btc',
      'target_price_usd_per_btc',
    ])
      canonicalDecimal(
        output.risk[field],
        `runtime risk ${field}`,
        'nonnegative',
      )
  } else
    assertKeys(
      output.risk,
      ['status', 'reason_codes'],
      riskRuntime
        ? [
            ...RISK_RESULT_FIELDS,
            ...((binding.runtime_config as JsonRecord)
              .funding_policy_version === 'funding-separation.v1'
              ? ['entry_block_causes', 'funding_availability']
              : []),
          ]
        : [],
    )
  if (riskRuntime) {
    for (const key of [
      'daily_loss_latched',
      'entry_paused',
      'user_paused',
      'system_paused',
    ])
      if (typeof output.risk[key] !== 'boolean')
        throw new Error(`Invalid risk result flag ${key}.`)
    if (
      typeof output.risk.utc_day !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(output.risk.utc_day) ||
      typeof output.risk.mark_quality !== 'string' ||
      !['unknown', 'valid', 'stale', 'gapped'].includes(
        output.risk.mark_quality,
      ) ||
      (output.risk.opening_equity_usd !== null &&
        typeof output.risk.opening_equity_usd !== 'string') ||
      (output.risk.reduction_intent_id !== null &&
        typeof output.risk.reduction_intent_id !== 'string') ||
      (output.risk.estimated_close_net_usd !== null &&
        typeof output.risk.estimated_close_net_usd !== 'string') ||
      typeof output.risk.estimated_close_complete !== 'boolean' ||
      output.risk.estimated_close_complete !==
        (output.risk.estimated_close_net_usd !== null)
    )
      throw new Error('Invalid daily risk result fields.')
    if (output.risk.opening_equity_usd !== null)
      canonicalDecimal(
        output.risk.opening_equity_usd,
        'risk opening equity',
        'positive',
      )
    if (output.risk.estimated_close_net_usd !== null)
      canonicalDecimal(
        output.risk.estimated_close_net_usd,
        'estimated close net',
      )
  }
  if (output.position.side === null)
    assertKeys(output.position, ['side', 'quantity_btc', 'owner_strategy_id'])
  else
    assertKeys(output.position, [
      'side',
      'quantity_btc',
      'entry_price_usd_per_btc',
      'owner_strategy_id',
      'stop_price_usd_per_btc',
      'target_price_usd_per_btc',
      'mark_usd_per_btc',
    ])
  if (output.position.side === null) {
    if (
      output.position.quantity_btc !== '0' ||
      output.position.owner_strategy_id !== null
    )
      throw new Error('Invalid flat runtime position.')
  } else {
    if (output.position.side !== 'long' && output.position.side !== 'short')
      throw new Error('Invalid runtime position side.')
    canonicalDecimal(
      output.position.quantity_btc,
      'runtime position quantity',
      'positive',
    )
    canonicalDecimal(
      output.position.entry_price_usd_per_btc,
      'runtime position entry',
      'positive',
    )
    canonicalDecimal(
      output.position.stop_price_usd_per_btc,
      'runtime position stop',
      'positive',
    )
    canonicalDecimal(
      output.position.target_price_usd_per_btc,
      'runtime position target',
      'positive',
    )
    canonicalDecimal(
      output.position.mark_usd_per_btc,
      'runtime position mark',
      'positive',
    )
  }
  for (const order of output.orders) {
    if (!isRecord(order)) throw new Error('Invalid runtime order evidence.')
    if (executionRuntime) {
      assertKeys(
        order,
        [
          'event_id',
          'type',
          'run_id',
          'instrument_id',
          'order_id',
          'order_type',
          'side',
          'quantity_btc',
        ],
        [
          'decision_at_ms',
          'eligible_at_ms',
          'model_version',
          'filled_quantity_btc',
          'effective_at_ms',
          'reason',
        ],
      )
      if (
        ![
          'order_created',
          'order_accepted',
          'order_filled',
          'cancelled',
          'rejected',
          'expired',
        ].includes(String(order.type)) ||
        order.run_id !== runId ||
        order.instrument_id !==
          (binding.instrument_spec as JsonRecord).instrument_id ||
        typeof order.order_id !== 'string' ||
        ![
          'market_ioc',
          'limit',
          'post_only',
          'stop_market',
          'reduce_only',
        ].includes(String(order.order_type)) ||
        !['buy', 'sell'].includes(String(order.side)) ||
        (order.type === 'order_accepted' &&
          order.model_version !== 'paper-execution.v1')
      )
        throw new Error('Invalid versioned execution order evidence.')
      canonicalDecimal(
        order.quantity_btc,
        'execution order quantity',
        'positive',
      )
      if (order.decision_at_ms !== undefined)
        normalizeTimestampMs(order.decision_at_ms)
      else if (
        order.type !== 'order_filled' &&
        order.type !== 'cancelled' &&
        order.type !== 'expired' &&
        order.type !== 'rejected'
      )
        throw new Error('Execution order decision time is missing.')
      if (order.filled_quantity_btc !== undefined)
        canonicalDecimal(
          order.filled_quantity_btc,
          'execution filled quantity',
          'nonnegative',
        )
      if (order.eligible_at_ms !== undefined)
        normalizeTimestampMs(order.eligible_at_ms)
      if (order.effective_at_ms !== undefined)
        normalizeTimestampMs(order.effective_at_ms)
      continue
    }
    assertKeys(
      order,
      [
        'order_id',
        'status',
        'time_in_force',
        'purpose',
        'requested_quantity_btc',
        'filled_quantity_btc',
        'cancelled_quantity_btc',
        'eligible_at_ms',
      ],
      order.purpose === 'close' ? ['reason'] : [],
    )
    for (const field of [
      'requested_quantity_btc',
      'filled_quantity_btc',
      'cancelled_quantity_btc',
    ])
      canonicalDecimal(order[field], `runtime order ${field}`, 'nonnegative')
    if (
      typeof order.order_id !== 'string' ||
      (order.status !== 'filled' && order.status !== 'cancelled') ||
      order.time_in_force !== 'IOC' ||
      (order.purpose !== 'entry' && order.purpose !== 'close') ||
      !Number.isSafeInteger(order.eligible_at_ms)
    )
      throw new Error('Invalid runtime order fields.')
  }
  for (const fill of output.fills) {
    if (!isRecord(fill)) throw new Error('Invalid runtime fill evidence.')
    assertKeys(
      fill,
      [
        'fill_id',
        'side',
        'action',
        'quantity_btc',
        'price_usd_per_btc',
        'fee_usd',
        'liquidity',
        'event_time_ms',
      ],
      executionRuntime ? ['order_id'] : [],
    )
    if (
      typeof fill.fill_id !== 'string' ||
      (fill.side !== 'long' && fill.side !== 'short') ||
      (fill.action !== 'buy' && fill.action !== 'sell') ||
      !(executionRuntime
        ? ['maker', 'taker'].includes(String(fill.liquidity))
        : fill.liquidity === 'taker') ||
      !Number.isSafeInteger(fill.event_time_ms)
    )
      throw new Error('Invalid runtime fill fields.')
    canonicalDecimal(fill.quantity_btc, 'runtime fill quantity', 'positive')
    canonicalDecimal(fill.price_usd_per_btc, 'runtime fill price', 'positive')
    canonicalDecimal(fill.fee_usd, 'runtime fill fee', 'nonnegative')
  }
  const ledger = value.result
  if (
    !isRecord(ledger) ||
    output.ledger === null ||
    canonicalJson(output.ledger) !== canonicalJson(ledger) ||
    !Array.isArray(cp.ledger_events) ||
    canonicalJson(cp.ledger_events) !== canonicalJson(ledger.events)
  )
    throw new Error('Runtime ledger evidence is inconsistent.')
  for (const [field, checkpointField] of [
    ['cash_usd', 'cash_usd'],
    ['leverage', 'leverage'],
    ['realized_gross_usd', 'realized_gross_usd'],
    ['fees_usd', 'fees_usd'],
    ['funding_paid', 'funding_paid'],
    ['funding_complete', 'funding_complete'],
  ] as const)
    if (ledger[field] !== cp[checkpointField])
      throw new Error(`Runtime checkpoint ${field} differs from ledger result.`)
  const position = cp.ledger_position
  if (position !== null) {
    if (
      !isRecord(position) ||
      (position.side !== 'long' && position.side !== 'short')
    )
      throw new Error('Invalid runtime checkpoint position.')
    assertKeys(position, [
      'side',
      'qty',
      'entry',
      'entry_fee_remaining',
      'funding_remaining',
      'opened_at',
      'funding_cursor_ms',
    ])
    canonicalDecimal(position.qty, 'checkpoint position quantity', 'positive')
    canonicalDecimal(position.entry, 'checkpoint entry price', 'positive')
    canonicalDecimal(
      position.entry_fee_remaining,
      'checkpoint entry fee',
      'nonnegative',
    )
    canonicalDecimal(position.funding_remaining, 'checkpoint remaining funding')
    if (
      ledger.side !== position.side ||
      ledger.quantity_btc !== position.qty ||
      !(strategyRuntime
        ? [
            'c25-pullback-perp-v1',
            'c26-reversion-perp-v1',
            'c27-breakout-perp-v1',
            'c28-adapter-perp-v1',
          ].includes(String(cp.owner_strategy_id))
        : cp.owner_strategy_id === 'c27-breakout-perp-v1') ||
      output.position.side !== position.side ||
      output.position.quantity_btc !== position.qty ||
      output.position.owner_strategy_id !== cp.owner_strategy_id ||
      (strategyRuntime &&
        output.analysis.selected_strategy_id !== cp.owner_strategy_id) ||
      output.position.entry_price_usd_per_btc !== position.entry ||
      !isRecord(cp.position_protection) ||
      output.position.stop_price_usd_per_btc !== cp.position_protection.stop ||
      output.position.target_price_usd_per_btc !== cp.position_protection.target
    )
      throw new Error('Runtime position ownership/accounting mismatch.')
    if (!isRecord(cp.position_protection))
      throw new Error('Open runtime position requires protection state.')
    assertKeys(cp.position_protection, [
      'stop',
      'target',
      'donchian_mid',
      'opened_at_ms',
      'signal_key',
      ...(strategyRuntime ? ['strategy_target', 'strategy_invalidation'] : []),
    ])
    for (const key of ['stop', 'target', 'donchian_mid'])
      canonicalDecimal(
        cp.position_protection[key],
        `position protection ${key}`,
        'positive',
      )
    if (
      !Number.isSafeInteger(cp.position_protection.opened_at_ms) ||
      typeof cp.position_protection.signal_key !== 'string'
    )
      throw new Error('Invalid position protection state.')
    if (
      strategyRuntime &&
      cp.position_protection.strategy_target !== null &&
      cp.position_protection.strategy_target !== undefined
    )
      canonicalDecimal(
        cp.position_protection.strategy_target,
        'strategy target',
        'positive',
      )
  } else if (
    ledger.side !== null ||
    ledger.quantity_btc !== '0' ||
    cp.owner_strategy_id !== null
  )
    throw new Error('Flat checkpoint does not match ledger position.')
  for (const key of [
    'cash_usd',
    'leverage',
    'realized_gross_usd',
    'fees_usd',
    'funding_paid',
  ])
    canonicalDecimal(
      cp[key],
      `checkpoint ${key}`,
      key === 'cash_usd' || key === 'fees_usd' ? 'nonnegative' : 'any',
    )
  if (
    cp.funding_complete !== ledger.funding_complete ||
    typeof cp.funding_complete !== 'boolean' ||
    !Array.isArray(cp.funding_rates) ||
    !Array.isArray(cp.accrued) ||
    !Array.isArray(cp.signal_keys) ||
    cp.signal_keys.some((item) => typeof item !== 'string') ||
    !isRecord(cp.consumed_depth)
  )
    throw new Error('Invalid runtime checkpoint funding or signal state.')
  if (
    cp.funding_cursor_ms !== null &&
    (!Number.isSafeInteger(cp.funding_cursor_ms) ||
      (cp.funding_cursor_ms as number) < 0)
  )
    throw new Error('Invalid runtime funding cursor.')
  if (
    cp.ledger_last_accrual_ms !== null &&
    (!Number.isSafeInteger(cp.ledger_last_accrual_ms) ||
      (cp.ledger_last_accrual_ms as number) < 0)
  )
    throw new Error('Invalid runtime accrual timestamp.')
  if (
    cp.ledger_position !== null &&
    (!isRecord(cp.ledger_position) ||
      !Number.isSafeInteger(cp.ledger_position.opened_at) ||
      !Number.isSafeInteger(cp.ledger_position.funding_cursor_ms))
  )
    throw new Error('Invalid runtime position timestamps.')
  if (cp.position_protection !== null && !isRecord(cp.position_protection))
    throw new Error('Invalid runtime position protection.')
  for (const rate of cp.funding_rates) {
    if (
      !Array.isArray(rate) ||
      rate.length !== 4 ||
      typeof rate[0] !== 'string' ||
      !Number.isSafeInteger(rate[1]) ||
      !Number.isSafeInteger(rate[2]) ||
      (rate[2] as number) <= (rate[1] as number)
    )
      throw new Error('Invalid checkpoint funding rate interval.')
    canonicalDecimal(rate[3], 'checkpoint funding rate')
  }
  for (const accrued of cp.accrued) {
    if (
      !Array.isArray(accrued) ||
      accrued.length !== 4 ||
      typeof accrued[0] !== 'string' ||
      !Number.isSafeInteger(accrued[1]) ||
      !Number.isSafeInteger(accrued[2]) ||
      (accrued[2] as number) <= (accrued[1] as number)
    )
      throw new Error('Invalid checkpoint accrued interval.')
    canonicalDecimal(accrued[3], 'checkpoint accrued quantity', 'positive')
  }
  for (const levels of Object.values(cp.consumed_depth)) {
    if (!isRecord(levels)) throw new Error('Invalid consumed-depth checkpoint.')
    for (const quantity of Object.values(levels))
      canonicalDecimal(quantity, 'consumed depth', 'nonnegative')
  }
  if (!Array.isArray(value.events))
    throw new Error('Runtime audit events must be an array.')
}

function validateLedgerSnapshot(value: JsonRecord, frozen: JsonRecord): void {
  assertKeys(value, [
    'ledger_version',
    'decimal_precision',
    'fee_rates',
    'cash_usd',
    'side',
    'quantity_btc',
    'mark_usd_per_btc',
    'unrealized_gross_usd',
    'reserved_margin_usd',
    'available_margin_usd',
    'equity_usd',
    'realized_gross_usd',
    'fees_usd',
    'funding_paid',
    'net_complete',
    'realized_net_complete',
    'funding_complete',
    'cost_version',
    'leverage',
    'events',
  ])
  const config = frozen.config as JsonRecord
  const seed = frozen.seed as JsonRecord
  const costs = frozen.costs as JsonRecord
  if (
    value.ledger_version !== LEDGER_VERSION ||
    value.cost_version !== COST_VERSION ||
    value.cost_version !== costs.version ||
    value.decimal_precision !== config.decimal_precision
  )
    throw new Error('Futures result version does not match its frozen run.')
  if (value.leverage !== config.leverage || value.cash_usd !== seed.cash_usd)
    throw new Error(
      'Futures result does not match its frozen seed/configuration.',
    )
  if (!isRecord(value.fee_rates))
    throw new Error('Futures fee-rate map is required.')
  assertKeys(value.fee_rates, ['maker', 'taker'])
  if (
    value.fee_rates.maker !== costs.maker ||
    value.fee_rates.taker !== costs.taker
  )
    throw new Error(
      'Futures result fee rates do not match the frozen cost identity.',
    )
  canonicalDecimal(value.cash_usd, 'cash_usd', 'nonnegative')
  canonicalDecimal(value.leverage, 'leverage', 'positive')
  canonicalDecimal(value.quantity_btc, 'quantity_btc', 'nonnegative')
  if (value.mark_usd_per_btc !== null)
    canonicalDecimal(value.mark_usd_per_btc, 'mark_usd_per_btc', 'positive')
  canonicalDecimal(value.unrealized_gross_usd, 'unrealized_gross_usd')
  canonicalDecimal(
    value.reserved_margin_usd,
    'reserved_margin_usd',
    'nonnegative',
  )
  canonicalDecimal(value.available_margin_usd, 'available_margin_usd')
  canonicalDecimal(value.equity_usd, 'equity_usd')
  canonicalDecimal(value.realized_gross_usd, 'realized_gross_usd')
  canonicalDecimal(value.fees_usd, 'fees_usd', 'nonnegative')
  canonicalDecimal(value.funding_paid, 'funding_paid')
  canonicalDecimal(value.fee_rates.maker, 'maker fee', 'nonnegative')
  canonicalDecimal(value.fee_rates.taker, 'taker fee', 'nonnegative')
  if (compareDecimal(String(value.leverage), '1') > 0)
    throw new Error('Futures result leverage exceeds 1x.')
  if (value.side !== null && value.side !== 'long' && value.side !== 'short')
    throw new Error('Invalid futures position side.')
  const isFlat = value.side === null
  if (value.mark_usd_per_btc === null && !isFlat)
    throw new Error('An unmarked futures account must be flat.')
  const quantity = canonicalDecimal(
    value.quantity_btc,
    'quantity_btc',
    isFlat ? 'nonnegative' : 'positive',
  )
  if (
    isFlat &&
    (quantity !== '0' ||
      value.unrealized_gross_usd !== '0' ||
      value.reserved_margin_usd !== '0')
  )
    throw new Error(
      'Flat futures state must have zero quantity, unrealized PnL, and reserved margin.',
    )
  if (
    !isFlat &&
    (value.net_complete !== null || value.realized_net_complete !== null)
  )
    throw new Error(
      'Open futures positions cannot claim complete realized net PnL.',
    )
  if (typeof value.funding_complete !== 'boolean')
    throw new Error('Funding completeness must be explicit.')
  const complete = isFlat && value.funding_complete
  if (complete) {
    canonicalDecimal(value.net_complete, 'net_complete')
    canonicalDecimal(value.realized_net_complete, 'realized_net_complete')
    if (value.net_complete !== value.realized_net_complete)
      throw new Error('Complete net fields must agree.')
  } else if (
    value.net_complete !== null ||
    value.realized_net_complete !== null
  ) {
    throw new Error(
      'Incomplete/open futures results must not claim complete net PnL.',
    )
  }
  const precision = config.decimal_precision as number
  const expectedNet = subtractAtPrecision(
    subtractAtPrecision(
      String(value.realized_gross_usd),
      String(value.fees_usd),
      precision,
    ),
    String(value.funding_paid),
    precision,
  )
  const expectedEquity = subtractAtPrecision(
    subtractAtPrecision(
      addAtPrecision(
        addAtPrecision(
          String(value.cash_usd),
          String(value.realized_gross_usd),
          precision,
        ),
        String(value.unrealized_gross_usd),
        precision,
      ),
      String(value.fees_usd),
      precision,
    ),
    String(value.funding_paid),
    precision,
  )
  const expectedAvailable = subtractAtPrecision(
    String(value.equity_usd),
    String(value.reserved_margin_usd),
    precision,
  )
  if (complete && value.net_complete !== expectedNet)
    throw new Error(
      'Futures net PnL is inconsistent with realized gross, fees, and funding.',
    )
  if (value.equity_usd !== expectedEquity)
    throw new Error(
      'Futures equity is inconsistent with cash, PnL, fees, or funding.',
    )
  if (value.available_margin_usd !== expectedAvailable)
    throw new Error(
      'Available margin is inconsistent with equity and reserved margin.',
    )
  if (!Array.isArray(value.events))
    throw new Error('Ledger audit events must be an array.')
  for (const event of value.events) validateLedgerAuditEvent(event)
}

function addAtPrecision(
  left: string,
  right: string,
  precision: number,
): string {
  const a = parseDecimalInteger(left)
  const b = parseDecimalInteger(right)
  const scale = Math.max(a.scale, b.scale)
  const sum =
    a.coefficient * 10n ** BigInt(scale - a.scale) +
    b.coefficient * 10n ** BigInt(scale - b.scale)
  return normalizeDecimal(roundDecimal(sum, scale, precision))
}

function subtractAtPrecision(
  left: string,
  right: string,
  precision: number,
): string {
  const negative = right.startsWith('-') ? right.slice(1) : `-${right}`
  return addAtPrecision(left, negative, precision)
}

function parseDecimalInteger(value: string): {
  coefficient: bigint
  scale: number
} {
  const negative = value.startsWith('-')
  const unsigned = value.replace(/^[+-]/, '')
  const [whole, fraction = ''] = unsigned.split('.')
  const magnitude = BigInt(`${whole}${fraction}` || '0')
  return {
    coefficient: negative ? -magnitude : magnitude,
    scale: fraction.length,
  }
}

function roundDecimal(
  coefficient: bigint,
  scale: number,
  precision: number,
): string {
  if (coefficient === 0n) return '0'
  const negative = coefficient < 0n
  let digits = (negative ? -coefficient : coefficient).toString()
  let resultScale = scale
  if (digits.length > precision) {
    const removed = digits.length - precision
    const kept = digits.slice(0, precision)
    const discarded = digits.slice(precision)
    let rounded = BigInt(kept)
    const first = discarded[0]!
    const restNonzero = /[1-9]/.test(discarded.slice(1))
    if (first > '5' || (first === '5' && (restNonzero || rounded % 2n === 1n)))
      rounded += 1n
    digits = rounded.toString()
    resultScale -= removed
  }
  const normalized =
    resultScale <= 0
      ? `${digits}${'0'.repeat(-resultScale)}`
      : digits.length > resultScale
        ? `${digits.slice(0, -resultScale)}.${digits.slice(-resultScale)}`
        : `0.${'0'.repeat(resultScale - digits.length)}${digits}`
  return `${negative ? '-' : ''}${normalized}`
}

function validateLedgerAuditEvent(value: unknown): void {
  if (!isRecord(value) || typeof value.type !== 'string')
    throw new Error('Invalid ledger audit event.')
  if (value.type === 'open') {
    assertKeys(value, ['type', 'side', 'qty', 'price', 'fee'])
    if (value.side !== 'long' && value.side !== 'short')
      throw new Error('Invalid ledger opening side.')
    canonicalDecimal(value.qty, 'opening quantity', 'positive')
    canonicalDecimal(value.price, 'opening price', 'positive')
    canonicalDecimal(value.fee, 'opening fee', 'nonnegative')
  } else if (value.type === 'close') {
    assertKeys(value, [
      'type',
      'qty',
      'gross',
      'allocated_entry_fee',
      'exit_fee',
      'allocated_funding',
    ])
    canonicalDecimal(value.qty, 'closing quantity', 'positive')
    canonicalDecimal(value.gross, 'closing gross PnL')
    canonicalDecimal(
      value.allocated_entry_fee,
      'allocated entry fee',
      'nonnegative',
    )
    canonicalDecimal(value.exit_fee, 'exit fee', 'nonnegative')
    canonicalDecimal(value.allocated_funding, 'allocated funding')
  } else throw new Error('Unsupported ledger audit event type.')
}

function validateFuturesEvents(
  events: unknown[],
  runId: string,
  workId: string,
  frozen: JsonRecord,
): void {
  const instrument = (frozen.instrument as JsonRecord).instrument_id
  const costVersion = (frozen.costs as JsonRecord).version
  const ids = new Set<string>()
  const fillIds = new Set<string>()
  for (const event of events) {
    if (!isRecord(event)) throw new Error('Invalid futures event object.')
    if (event.type === 'fill') {
      assertKeys(event, [
        'event_version',
        'id',
        'fill_id',
        'run_id',
        'work_id',
        'type',
        'instrument_id',
        'side',
        'quantity_btc',
        'price_usd_per_btc',
        'fee_usd',
        'liquidity',
        'cost_version',
      ])
      canonicalDecimal(event.quantity_btc, 'fill quantity', 'positive')
      canonicalDecimal(event.price_usd_per_btc, 'fill price', 'positive')
      canonicalDecimal(event.fee_usd, 'fill fee', 'nonnegative')
      if (event.side !== 'long' && event.side !== 'short')
        throw new Error('Invalid fill side.')
      if (event.liquidity !== 'maker' && event.liquidity !== 'taker')
        throw new Error('Invalid fill liquidity.')
    } else if (event.type === 'funding') {
      assertKeys(event, [
        'event_version',
        'id',
        'run_id',
        'work_id',
        'type',
        'instrument_id',
        'interval_id',
        'start_time_ms',
        'end_time_ms',
        'rate_usd_per_btc_hour',
        'amount_usd',
        'position_side',
        'quantity_btc',
        'cost_version',
      ])
      canonicalDecimal(event.rate_usd_per_btc_hour, 'funding rate')
      canonicalDecimal(event.amount_usd, 'funding amount')
      canonicalDecimal(event.quantity_btc, 'funding quantity', 'positive')
      normalizeTimestampMs(event.start_time_ms)
      normalizeTimestampMs(event.end_time_ms)
      if (
        (event.end_time_ms as number) <= (event.start_time_ms as number) ||
        typeof event.interval_id !== 'string' ||
        !event.interval_id
      )
        throw new Error('Invalid funding interval identity.')
      if (event.position_side !== 'long' && event.position_side !== 'short')
        throw new Error('Invalid funding position side.')
    } else if (event.type === 'position') {
      assertKeys(event, [
        'event_version',
        'id',
        'run_id',
        'work_id',
        'type',
        'instrument_id',
        'event_time_ms',
        'side',
        'quantity_btc',
        'cost_version',
      ])
      normalizeTimestampMs(event.event_time_ms)
      canonicalDecimal(
        event.quantity_btc,
        'position quantity',
        event.side === null ? 'nonnegative' : 'positive',
      )
      if (
        event.side !== null &&
        event.side !== 'long' &&
        event.side !== 'short'
      )
        throw new Error('Invalid position event side.')
      if (event.side === null && event.quantity_btc !== '0')
        throw new Error('Flat position event must have zero quantity.')
    } else if (event.type === 'order') {
      assertKeys(event, [
        'event_version',
        'id',
        'run_id',
        'work_id',
        'type',
        'instrument_id',
        'order_id',
        'status',
        'order_type',
        'side',
        'quantity_btc',
        'event_time_ms',
        'cost_version',
      ])
      if (
        typeof event.order_id !== 'string' ||
        !event.order_id ||
        ![
          'order_created',
          'order_accepted',
          'order_filled',
          'cancelled',
          'rejected',
          'expired',
        ].includes(String(event.status)) ||
        ![
          'market_ioc',
          'limit',
          'post_only',
          'stop_market',
          'reduce_only',
        ].includes(String(event.order_type)) ||
        !['buy', 'sell'].includes(String(event.side))
      )
        throw new Error('Invalid paper execution order event.')
      canonicalDecimal(event.quantity_btc, 'order quantity', 'positive')
      normalizeTimestampMs(event.event_time_ms)
    } else if (event.type === 'account') {
      assertKeys(event, [
        'event_version',
        'id',
        'run_id',
        'work_id',
        'type',
        'instrument_id',
        'event_time_ms',
        'equity_usd',
        'available_margin_usd',
        'reserved_margin_usd',
        'fees_usd',
        'funding_paid',
        'cost_version',
      ])
      normalizeTimestampMs(event.event_time_ms)
      canonicalDecimal(event.equity_usd, 'account equity')
      canonicalDecimal(event.available_margin_usd, 'available margin')
      canonicalDecimal(
        event.reserved_margin_usd,
        'reserved margin',
        'nonnegative',
      )
      canonicalDecimal(event.fees_usd, 'account fees', 'nonnegative')
      canonicalDecimal(event.funding_paid, 'account funding')
    } else throw new Error('Unsupported futures event type.')
    if (
      event.event_version !== 1 ||
      event.run_id !== runId ||
      event.work_id !== workId ||
      event.instrument_id !== instrument ||
      event.cost_version !== costVersion ||
      typeof event.id !== 'string' ||
      !event.id
    )
      throw new Error(
        'Futures event identity/version does not match its frozen work.',
      )
    if (ids.has(event.id)) throw new Error('Duplicate futures event identity.')
    ids.add(event.id)
    if (event.type === 'fill') {
      if (
        typeof event.fill_id !== 'string' ||
        !event.fill_id ||
        fillIds.has(event.fill_id)
      )
        throw new Error('Duplicate or missing immutable fill identity.')
      fillIds.add(event.fill_id)
    }
  }
}
