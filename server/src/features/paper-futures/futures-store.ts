import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  canonicalHash,
  canonicalJson,
  normalizeDecimal,
  normalizeTimestampMs,
} from './futures-canonical.ts'

type JsonRecord = Record<string, unknown>

export class FuturesStore {
  private readonly db: DatabaseSync

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
    `)
  }

  close(): void {
    this.db.close()
  }

  createRun(input: {
    runId: string
    config: unknown
    seed: unknown
    instrument: unknown
    costs: unknown
    runtime?: unknown
  }): void {
    validateFrozenRun(input)
    const frozen = {
      config: input.config,
      seed: input.seed,
      instrument: input.instrument,
      costs: input.costs,
      ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
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
      this.db.exec('COMMIT')
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

  applyResult(value: unknown, injectFailureAt?: 'before-commit'): JsonRecord {
    if (!isRecord(value)) throw new Error('Invalid futures result schema.')
    const runtimeWork = value.schema_version === 'futures-runtime-work.v1'
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
      this.db.exec('BEGIN IMMEDIATE')
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
        this.db.exec('COMMIT')
        return receipt
      } catch (error) {
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
    this.db.exec('BEGIN IMMEDIATE')
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
      if (injectFailureAt === 'before-commit')
        throw new Error('Injected pre-commit failure.')
      this.db.exec('COMMIT')
      return receipt
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  acceptCommand(
    commandId: string,
    payload: unknown,
    injectFailureAt?: 'before-commit',
    checkpoint?: unknown,
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
    const hash = canonicalHash(payload)
    const queuedJson = canonicalJson(
      checkpoint === undefined ? payload : { request: payload, checkpoint },
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
      if (injectFailureAt === 'before-commit')
        throw new Error('Injected command acceptance pre-commit failure.')
      this.db.exec('COMMIT')
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
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare('INSERT INTO paper_futures_outbox VALUES(?,?,?,?)')
        .run(id, '', commandId, canonicalJson(stored))
      this.db.exec('COMMIT')
      return stored
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  exportRun(runId: string): JsonRecord {
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
    return {
      receipt: receipt ? JSON.parse(receipt.receipt_json) : null,
      events: events.map((row) => JSON.parse(row.payload_json)),
      projection: projection ? JSON.parse(projection.state_json) : null,
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
        if (payload.schema_version === 'futures-runtime-work.v1') {
          if (!('runtime' in frozen)) return false
          validateRuntimeWork(
            payload,
            frozen,
            runId,
            Number(payload.applied_state_version),
          )
          latestRuntimeCheckpoint = payload.runtime_checkpoint
          hasRuntimeCheckpoint = true
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

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const LEDGER_VERSION = 'linear-usd-ledger.v1'
const COST_VERSION = 'kraken-futures-eea-btcusd-base.v1'

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
  assertKeys(input.config, ['ledger_version', 'decimal_precision', 'leverage'])
  assertKeys(input.seed, ['cash_usd'])
  assertKeys(input.instrument, ['instrument_id'])
  assertKeys(input.costs, ['version', 'maker', 'taker'])
  if (
    input.config.ledger_version !== LEDGER_VERSION ||
    !Number.isSafeInteger(input.config.decimal_precision) ||
    (input.config.decimal_precision as number) < 28 ||
    (input.config.decimal_precision as number) > 100
  )
    throw new Error('Unsupported frozen ledger configuration.')
  const leverage = canonicalDecimal(
    input.config.leverage,
    'leverage',
    'positive',
  )
  if (compareDecimal(leverage, '1') > 0)
    throw new Error('Futures laboratory leverage cannot exceed 1x.')
  canonicalDecimal(input.seed.cash_usd, 'seed cash', 'nonnegative')
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

function validateRuntimeBinding(value: unknown, frozen: JsonRecord): void {
  if (!isRecord(value)) throw new Error('Runtime binding must be an object.')
  assertKeys(value, ['schema_version', 'runtime_config', 'instrument_spec'])
  if (
    value.schema_version !== 'futures-runtime-binding.v1' ||
    !isRecord(value.runtime_config) ||
    !isRecord(value.instrument_spec)
  )
    throw new Error('Unsupported futures runtime binding.')
  const config = value.runtime_config
  assertKeys(config, [
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
  ])
  if (
    config.version !== 'futures-runtime-lab.v1' ||
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
  const cp = value.runtime_checkpoint
  const output = value.runtime_output
  assertKeys(cp, [
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
  ])
  if (
    cp.schema_version !== 1 ||
    cp.runtime_version !== 'c27-breakout-perp-v1' ||
    cp.run_id !== runId ||
    cp.runtime_config === undefined ||
    cp.instrument_spec === undefined ||
    cp.runtime_config === null ||
    cp.instrument_spec === null
  )
    throw new Error('Unsupported or mismatched runtime checkpoint identity.')
  const binding = frozen.runtime as JsonRecord
  if (
    canonicalJson(cp.runtime_config) !==
      canonicalJson(binding.runtime_config) ||
    canonicalJson(cp.instrument_spec) !==
      canonicalJson(binding.instrument_spec) ||
    cp.instrument_id !== (binding.instrument_spec as JsonRecord).instrument_id
  )
    throw new Error('Runtime checkpoint configuration or instrument drifted.')
  if (
    value.applied_state_version !== version ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    value.protocol_version !== 1 ||
    value.schema_version !== 'futures-runtime-work.v1'
  )
    throw new Error('Invalid versioned runtime work identity.')
  assertKeys(output, [
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
  ])
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
      output.valuation_source !== 'observed_book_midpoint')
  )
    throw new Error('Invalid C27 runtime output shape.')
  assertKeys(output.analysis, [
    'strategy_id',
    'selected_strategy_id',
    'action',
    'reason_codes',
    'features',
    'strategy_status',
  ])
  if (
    typeof output.analysis.action !== 'string' ||
    !Array.isArray(output.analysis.reason_codes) ||
    output.analysis.reason_codes.some((code) => typeof code !== 'string') ||
    !isRecord(output.analysis.features) ||
    typeof output.analysis.strategy_status !== 'string'
  )
    throw new Error('Invalid runtime analysis evidence.')
  if (
    output.analysis.action !== 'long' &&
    output.analysis.action !== 'short' &&
    output.analysis.action !== 'WAIT' &&
    output.analysis.action !== 'FLAT'
  )
    throw new Error('Unsupported runtime action.')
  if (
    output.analysis.selected_strategy_id !== null &&
    output.analysis.selected_strategy_id !== 'c27-breakout-perp-v1'
  )
    throw new Error('Unsupported selected runtime strategy.')
  if (
    output.analysis.strategy_id !== null &&
    output.analysis.strategy_id !== 'c27-breakout-perp-v1'
  )
    throw new Error('Unsupported runtime strategy identity.')
  assertKeys(output.analysis.features, [
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
  ])
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
    assertKeys(output.risk, [
      'status',
      'quantity_btc',
      'risk_budget_usd',
      'estimated_round_trip_cost_usd',
      'stop_price_usd_per_btc',
      'target_price_usd_per_btc',
      'reason_codes',
    ])
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
  } else assertKeys(output.risk, ['status', 'reason_codes'])
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
    assertKeys(fill, [
      'fill_id',
      'side',
      'action',
      'quantity_btc',
      'price_usd_per_btc',
      'fee_usd',
      'liquidity',
      'event_time_ms',
    ])
    if (
      typeof fill.fill_id !== 'string' ||
      (fill.side !== 'long' && fill.side !== 'short') ||
      (fill.action !== 'buy' && fill.action !== 'sell') ||
      fill.liquidity !== 'taker' ||
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
      cp.owner_strategy_id !== 'c27-breakout-perp-v1' ||
      output.position.side !== position.side ||
      output.position.quantity_btc !== position.qty ||
      output.position.owner_strategy_id !== cp.owner_strategy_id ||
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
