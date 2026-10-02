import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { canonicalHash, canonicalJson } from './futures-canonical.ts'

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
  }): void {
    const frozen = {
      config: input.config,
      seed: input.seed,
      instrument: input.instrument,
      costs: input.costs,
    }
    const json = canonicalJson(frozen)
    const hash = canonicalHash(frozen)
    const prior = this.db
      .prepare('SELECT frozen_hash FROM paper_futures_runs WHERE run_id=?')
      .get(input.runId) as { frozen_hash: string } | undefined
    if (prior) {
      if (prior.frozen_hash !== hash)
        throw new Error('Run identity conflicts with frozen inputs.')
      return
    }
    this.db
      .prepare(
        'INSERT INTO paper_futures_runs(run_id,frozen_json,frozen_hash,state_version,head_hash) VALUES(?,?,?,0,?)',
      )
      .run(input.runId, json, hash, '0'.repeat(64))
    this.db
      .prepare('INSERT INTO paper_futures_projections VALUES(?,?)')
      .run(input.runId, canonicalJson({ state_version: 0 }))
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
    if (
      !isRecord(value) ||
      value.protocol_version !== 1 ||
      typeof value.run_id !== 'string' ||
      typeof value.work_id !== 'string' ||
      !Number.isSafeInteger(value.applied_state_version) ||
      !isRecord(value.result) ||
      !Array.isArray(value.events)
    )
      throw new Error('Invalid futures result schema.')
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
    const work = this.db
      .prepare('SELECT * FROM paper_futures_work WHERE work_id=?')
      .get(value.work_id) as JsonRecord | undefined
    if (!work || work.run_id !== value.run_id)
      throw new Error('Unknown work/run identity.')
    const run = this.db
      .prepare('SELECT * FROM paper_futures_runs WHERE run_id=?')
      .get(value.run_id) as JsonRecord
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

  acceptCommand(commandId: string, payload: unknown): JsonRecord {
    const hash = canonicalHash(payload)
    const old = this.db
      .prepare(
        'SELECT payload_hash,acceptance_json FROM paper_futures_commands WHERE command_id=?',
      )
      .get(commandId) as
      { payload_hash: string; acceptance_json: string } | undefined
    if (old) {
      if (old.payload_hash !== hash)
        throw new Error('Command identity conflicts with accepted payload.')
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
        .prepare('INSERT INTO paper_futures_outbox VALUES(?,?,?,?)')
        .run(`command:${commandId}`, '', commandId, canonicalJson(receipt))
      this.db.exec('COMMIT')
      return receipt
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
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
    const records = this.db
      .prepare(
        'SELECT payload_json,payload_hash,previous_hash,record_hash FROM paper_futures_records WHERE run_id=? ORDER BY seq',
      )
      .all(runId) as JsonRecord[]
    let previous = '0'.repeat(64)
    for (const row of records) {
      const payload = JSON.parse(String(row.payload_json)) as unknown
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
      previous = chain
    }
    return true
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
