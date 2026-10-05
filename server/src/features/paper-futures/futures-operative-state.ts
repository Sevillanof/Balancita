import { DatabaseSync } from 'node:sqlite'
import {
  canonicalHash,
  canonicalJson,
  normalizeDecimal,
} from './futures-canonical.ts'

const KINDS = [
  'order',
  'cancel',
  'trade',
  'book_budget',
  'trade_budget',
  'order_trade',
] as const
const MAX_BATCH = 128
const MAX_BATCH_BYTES = 1_048_576
const MAX_KEY_BYTES = 4096
const MAX_VALUE_BYTES = 256 * 1024
const ZERO_HASH = '0'.repeat(64)

export type FuturesOperativeIdentityKind = (typeof KINDS)[number]
export type FuturesOperativeJson =
  | null
  | boolean
  | number
  | string
  | FuturesOperativeJson[]
  | { [key: string]: FuturesOperativeJson }

export type FuturesOperativeIdentityValue = {
  order: {
    intent: { [key: string]: FuturesOperativeJson }
    receipt: { [key: string]: FuturesOperativeJson }
    state?: string
    filled?: string
  }
  cancel: [[string, number], FuturesOperativeJson[]]
  trade: [string, string, 'buy' | 'sell']
  book_budget: { asks: Record<string, string>; bids: Record<string, string> }
  trade_budget: string
  order_trade: true
}

export type FuturesOperativeIdentityUpdate = {
  [K in FuturesOperativeIdentityKind]: {
    kind: K
    key: string
    value: FuturesOperativeIdentityValue[K]
    provenance: string
  }
}[FuturesOperativeIdentityKind]

export type FuturesOperativeApplyInput = {
  runId: string
  workId: string
  expectedStateVersion: number
  sourceFrontier: number
  confirmedSourceFrontier: number
  updates: readonly FuturesOperativeIdentityUpdate[]
}

type HistoryRow = {
  run_id: string
  kind: FuturesOperativeIdentityKind
  identity_key: string
  revision: number
  value_json: string
  value_hash: string
  previous_hash: string
  record_hash: string
  provenance: string
  source_frontier: number
  work_id: string
  expected_version: number
}

export type FuturesOperativeIdentityTransaction = {
  readonly database: DatabaseSync
  readonly active: true
}

export function ensureFuturesOperativeIdentitySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS futures_operative_identity_history(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES paper_futures_runs(run_id),
      kind TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      value_json TEXT NOT NULL,
      value_hash TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      record_hash TEXT NOT NULL UNIQUE,
      provenance TEXT NOT NULL,
      source_frontier INTEGER NOT NULL CHECK(source_frontier >= 0),
      work_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
      UNIQUE(run_id,kind,identity_key,revision)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS futures_operative_identity_lookup
      ON futures_operative_identity_history(run_id,kind,identity_key,revision DESC);
    CREATE TRIGGER IF NOT EXISTS futures_operative_identity_history_no_update
      BEFORE UPDATE ON futures_operative_identity_history
      BEGIN SELECT RAISE(ABORT,'append-only operative identity history'); END;
    CREATE TRIGGER IF NOT EXISTS futures_operative_identity_history_no_delete
      BEFORE DELETE ON futures_operative_identity_history
      BEGIN SELECT RAISE(ABORT,'append-only operative identity history'); END;
    CREATE TABLE IF NOT EXISTS futures_operative_identity_current(
      run_id TEXT NOT NULL REFERENCES paper_futures_runs(run_id),
      kind TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      value_json TEXT NOT NULL,
      value_hash TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      provenance TEXT NOT NULL,
      source_frontier INTEGER NOT NULL CHECK(source_frontier >= 0),
      work_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL CHECK(expected_version >= 0),
      PRIMARY KEY(run_id,kind,identity_key),
      FOREIGN KEY(run_id,kind,identity_key,revision)
        REFERENCES futures_operative_identity_history(run_id,kind,identity_key,revision)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS futures_operative_identity_work(
      run_id TEXT NOT NULL REFERENCES paper_futures_runs(run_id),
      work_id TEXT NOT NULL,
      expected_version INTEGER NOT NULL,
      source_frontier INTEGER NOT NULL,
      batch_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      record_hash TEXT NOT NULL,
      PRIMARY KEY(run_id,work_id),
      FOREIGN KEY(work_id) REFERENCES paper_futures_work(work_id)
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS futures_operative_identity_work_no_update
      BEFORE UPDATE ON futures_operative_identity_work
      BEGIN SELECT RAISE(ABORT,'immutable operative identity work'); END;
    CREATE TRIGGER IF NOT EXISTS futures_operative_identity_work_no_delete
      BEFORE DELETE ON futures_operative_identity_work
      BEGIN SELECT RAISE(ABORT,'immutable operative identity work'); END;
  `)
}

export class FuturesOperativeIdentityStore {
  private readonly activeTransactions = new WeakSet<object>()
  private readonly db: DatabaseSync

  constructor(db: DatabaseSync) {
    this.db = db
    ensureFuturesOperativeIdentitySchema(db)
  }

  withTransaction<T>(
    operation: (transaction: FuturesOperativeIdentityTransaction) => T,
  ): T {
    if (this.db.isTransaction)
      throw new Error(
        'Operative identity transaction must be the outer owner transaction.',
      )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = this.withOwnerTransaction(operation)
      if (isPromiseLike(result))
        throw new Error(
          'Operative identity transaction callbacks must be synchronous.',
        )
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  withOwnerTransaction<T>(
    operation: (transaction: FuturesOperativeIdentityTransaction) => T,
  ): T {
    if (!this.db.isTransaction)
      throw new Error(
        'FuturesStore must begin its SQLite transaction before identity apply.',
      )
    const transaction = { database: this.db, active: true as const }
    this.activeTransactions.add(transaction)
    try {
      const result = operation(transaction)
      if (isPromiseLike(result))
        throw new Error(
          'Operative identity transaction callbacks must be synchronous.',
        )
      return result
    } finally {
      this.activeTransactions.delete(transaction)
    }
  }

  lookup<K extends FuturesOperativeIdentityKind>(
    runId: string,
    kind: K,
    key: string,
  ): FuturesOperativeIdentityValue[K] | null {
    validateRunId(runId)
    validateKey(kind, key)
    const run = this.db
      .prepare('SELECT 1 AS present FROM paper_futures_runs WHERE run_id=?')
      .get(runId) as { present: number } | undefined
    if (!run) throw new Error('Unknown operative identity run.')
    const row = this.db
      .prepare(
        `SELECT value_json,value_hash FROM futures_operative_identity_current
         WHERE run_id=? AND kind=? AND identity_key=?`,
      )
      .get(runId, kind, key) as
      { value_json: string; value_hash: string } | undefined
    if (!row) return null
    return decodeValue(
      kind,
      row.value_json,
      row.value_hash,
    ) as FuturesOperativeIdentityValue[K]
  }

  lookupMany<K extends FuturesOperativeIdentityKind>(
    runId: string,
    kind: K,
    keys: readonly string[],
  ): Map<string, FuturesOperativeIdentityValue[K] | null> {
    validateRunId(runId)
    if (!Array.isArray(keys) || keys.length > MAX_BATCH)
      throw new Error(
        `Operative identity lookup batch must contain at most ${MAX_BATCH} keys.`,
      )
    const result = new Map<string, FuturesOperativeIdentityValue[K] | null>()
    let keyBytes = 0
    for (const key of keys) {
      validateKey(kind, key)
      keyBytes += Buffer.byteLength(key, 'utf8')
      if (keyBytes > MAX_BATCH_BYTES)
        throw new Error(
          'Operative identity lookup batch exceeds the byte limit.',
        )
      if (result.has(key))
        throw new Error('Operative identity lookup keys must be unique.')
      result.set(key, this.lookup(runId, kind, key))
    }
    return result
  }

  apply(
    transaction: FuturesOperativeIdentityTransaction,
    input: FuturesOperativeApplyInput,
  ): readonly {
    kind: FuturesOperativeIdentityKind
    key: string
    revision: number
  }[] {
    this.assertTransaction(transaction)
    validateApplyInput(input)
    const batchHash = canonicalHash(input.updates)
    const priorWork = this.db
      .prepare(
        `SELECT expected_version,source_frontier,batch_hash,result_json,record_hash
         FROM futures_operative_identity_work WHERE run_id=? AND work_id=?`,
      )
      .get(input.runId, input.workId) as
      | {
          expected_version: number
          source_frontier: number
          batch_hash: string
          result_json: string
          record_hash: string
        }
      | undefined
    if (priorWork) {
      const priorRecord = {
        run_id: input.runId,
        work_id: input.workId,
        expected_version: Number(priorWork.expected_version),
        source_frontier: Number(priorWork.source_frontier),
        batch_hash: priorWork.batch_hash,
        result_json: priorWork.result_json,
      }
      if (
        canonicalJson(JSON.parse(priorWork.result_json)) !==
          priorWork.result_json ||
        canonicalHash(priorRecord) !== priorWork.record_hash ||
        priorWork.expected_version !== input.expectedStateVersion ||
        priorWork.source_frontier !== input.sourceFrontier ||
        priorWork.batch_hash !== batchHash
      )
        throw new Error(
          'Operative identity work ID conflicts with its applied payload.',
        )
      return JSON.parse(priorWork.result_json) as {
        kind: FuturesOperativeIdentityKind
        key: string
        revision: number
      }[]
    }

    const run = this.db
      .prepare('SELECT state_version FROM paper_futures_runs WHERE run_id=?')
      .get(input.runId) as { state_version: number } | undefined
    if (!run) throw new Error('Unknown operative identity run.')
    if (Number(run.state_version) !== input.expectedStateVersion)
      throw new Error(
        'Operative identity work has a stale expected state version.',
      )
    const work = this.db
      .prepare(
        'SELECT run_id,expected_version FROM paper_futures_work WHERE work_id=?',
      )
      .get(input.workId) as
      { run_id: string; expected_version: number } | undefined
    if (
      !work ||
      work.run_id !== input.runId ||
      Number(work.expected_version) !== input.expectedStateVersion
    )
      throw new Error(
        'Operative identity work is not bound to this run and expected version.',
      )

    let batchBytes = 0
    const prepared = input.updates.map((update) => {
      validateUpdate(update)
      const encoded = canonicalJson(update.value)
      batchBytes +=
        Buffer.byteLength(update.key, 'utf8') +
        Buffer.byteLength(update.provenance, 'utf8') +
        Buffer.byteLength(encoded, 'utf8')
      if (batchBytes > MAX_BATCH_BYTES)
        throw new Error(
          'Operative identity update batch exceeds the byte limit.',
        )
      return {
        ...update,
        encoded,
        hash: canonicalHash(update.value),
      }
    })
    const output: {
      kind: FuturesOperativeIdentityKind
      key: string
      revision: number
    }[] = []
    for (const update of prepared) {
      const current = this.db
        .prepare(
          `SELECT revision,value_json,record_hash FROM futures_operative_identity_current
           WHERE run_id=? AND kind=? AND identity_key=?`,
        )
        .get(input.runId, update.kind, update.key) as
        | { revision: number; value_json: string; record_hash: string }
        | undefined
      const priorValue = current
        ? decodeValue(update.kind, current.value_json, undefined)
        : null
      validateTransition(update.kind, priorValue, update.value)
      const revision = Number(current?.revision ?? 0) + 1
      const previousHash = current?.record_hash ?? ZERO_HASH
      const record = {
        run_id: input.runId,
        kind: update.kind,
        identity_key: update.key,
        revision,
        value_json: update.encoded,
        value_hash: update.hash,
        previous_hash: previousHash,
        provenance: update.provenance,
        source_frontier: input.sourceFrontier,
        work_id: input.workId,
        expected_version: input.expectedStateVersion,
      }
      const recordHash = canonicalHash(record)
      this.db
        .prepare(
          `INSERT INTO futures_operative_identity_history
           (run_id,kind,identity_key,revision,value_json,value_hash,previous_hash,record_hash,
            provenance,source_frontier,work_id,expected_version)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          record.run_id,
          record.kind,
          record.identity_key,
          record.revision,
          record.value_json,
          record.value_hash,
          record.previous_hash,
          recordHash,
          record.provenance,
          record.source_frontier,
          record.work_id,
          record.expected_version,
        )
      this.db
        .prepare(
          `INSERT INTO futures_operative_identity_current
           (run_id,kind,identity_key,revision,value_json,value_hash,record_hash,provenance,
            source_frontier,work_id,expected_version)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(run_id,kind,identity_key) DO UPDATE SET
             revision=excluded.revision,value_json=excluded.value_json,value_hash=excluded.value_hash,
             record_hash=excluded.record_hash,provenance=excluded.provenance,
             source_frontier=excluded.source_frontier,work_id=excluded.work_id,
             expected_version=excluded.expected_version`,
        )
        .run(
          record.run_id,
          record.kind,
          record.identity_key,
          revision,
          record.value_json,
          record.value_hash,
          recordHash,
          record.provenance,
          record.source_frontier,
          record.work_id,
          record.expected_version,
        )
      output.push({ kind: update.kind, key: update.key, revision })
    }
    const resultJson = canonicalJson(output)
    const workRecord = {
      run_id: input.runId,
      work_id: input.workId,
      expected_version: input.expectedStateVersion,
      source_frontier: input.sourceFrontier,
      batch_hash: batchHash,
      result_json: resultJson,
    }
    this.db
      .prepare(
        `INSERT INTO futures_operative_identity_work
         (run_id,work_id,expected_version,source_frontier,batch_hash,result_json,record_hash)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(
        input.runId,
        input.workId,
        input.expectedStateVersion,
        input.sourceFrontier,
        batchHash,
        resultJson,
        canonicalHash(workRecord),
      )
    return output
  }

  verifyRun(runId: string): { records: number; identities: number } {
    validateRunId(runId)
    const rows = this.db
      .prepare(
        `SELECT run_id,kind,identity_key,revision,value_json,value_hash,previous_hash,record_hash,
                provenance,source_frontier,work_id,expected_version
         FROM futures_operative_identity_history WHERE run_id=?
         ORDER BY kind,identity_key,revision`,
      )
      .all(runId) as HistoryRow[]
    const heads = new Map<string, HistoryRow>()
    const revisions = new Map<string, number>()
    for (const row of rows) {
      const kind = row.kind
      if (!isKind(kind))
        throw new Error('Operative identity history contains an unknown kind.')
      validateKey(kind, row.identity_key)
      const value = decodeValue(kind, row.value_json, row.value_hash)
      const identity = `${kind}\u0000${row.identity_key}`
      const expectedRevision = (revisions.get(identity) ?? 0) + 1
      const previous = heads.get(identity)
      if (Number(row.revision) !== expectedRevision)
        throw new Error(
          'Operative identity history revision sequence is corrupt.',
        )
      const expectedPreviousHash = previous?.record_hash ?? ZERO_HASH
      const record = {
        run_id: row.run_id,
        kind: row.kind,
        identity_key: row.identity_key,
        revision: Number(row.revision),
        value_json: row.value_json,
        value_hash: row.value_hash,
        previous_hash: row.previous_hash,
        provenance: row.provenance,
        source_frontier: Number(row.source_frontier),
        work_id: row.work_id,
        expected_version: Number(row.expected_version),
      }
      if (
        row.previous_hash !== expectedPreviousHash ||
        canonicalHash(value) !== row.value_hash ||
        canonicalHash(record) !== row.record_hash
      )
        throw new Error(
          'Operative identity history hash integrity verification failed.',
        )
      revisions.set(identity, expectedRevision)
      heads.set(identity, row)
    }
    const currentRows = this.db
      .prepare(
        `SELECT run_id,kind,identity_key,revision,value_json,value_hash,record_hash,provenance,
                source_frontier,work_id,expected_version
         FROM futures_operative_identity_current WHERE run_id=?`,
      )
      .all(runId) as Omit<HistoryRow, 'previous_hash'>[]
    if (currentRows.length !== heads.size)
      throw new Error(
        'Operative identity current projection does not match history.',
      )
    for (const row of currentRows) {
      const kind = row.kind
      if (!isKind(kind))
        throw new Error(
          'Operative identity projection contains an unknown kind.',
        )
      const identity = `${kind}\u0000${row.identity_key}`
      const head = heads.get(identity)
      if (!head || !sameHead(row, head))
        throw new Error(
          'Operative identity current projection disagrees with history head.',
        )
    }
    const workRows = this.db
      .prepare(
        `SELECT work_id,expected_version,source_frontier,batch_hash,result_json,record_hash
         FROM futures_operative_identity_work WHERE run_id=? ORDER BY work_id`,
      )
      .all(runId) as {
      work_id: string
      expected_version: number
      source_frontier: number
      batch_hash: string
      result_json: string
      record_hash: string
    }[]
    for (const work of workRows) {
      const workRecord = {
        run_id: runId,
        work_id: work.work_id,
        expected_version: Number(work.expected_version),
        source_frontier: Number(work.source_frontier),
        batch_hash: work.batch_hash,
        result_json: work.result_json,
      }
      let result: {
        kind: FuturesOperativeIdentityKind
        key: string
        revision: number
      }[]
      try {
        result = JSON.parse(work.result_json) as typeof result
      } catch {
        throw new Error('Operative identity work result JSON is malformed.')
      }
      if (
        canonicalJson(result) !== work.result_json ||
        canonicalHash(workRecord) !== work.record_hash
      )
        throw new Error(
          'Operative identity work record hash verification failed.',
        )
      const workHistory = this.db
        .prepare(
          `SELECT kind,identity_key,revision,value_json,provenance,source_frontier,expected_version
           FROM futures_operative_identity_history WHERE run_id=? AND work_id=? ORDER BY seq`,
        )
        .all(runId, work.work_id) as {
        kind: FuturesOperativeIdentityKind
        identity_key: string
        revision: number
        value_json: string
        provenance: string
        source_frontier: number
        expected_version: number
      }[]
      const updates = workHistory.map((identity) => ({
        kind: identity.kind,
        key: identity.identity_key,
        value: JSON.parse(identity.value_json) as FuturesOperativeJson,
        provenance: identity.provenance,
      }))
      const expectedResult = workHistory.map((identity) => ({
        kind: identity.kind,
        key: identity.identity_key,
        revision: Number(identity.revision),
      }))
      if (
        canonicalHash(updates) !== work.batch_hash ||
        canonicalJson(result) !== canonicalJson(expectedResult) ||
        workHistory.some(
          (identity) =>
            Number(identity.source_frontier) !== Number(work.source_frontier) ||
            Number(identity.expected_version) !== Number(work.expected_version),
        )
      )
        throw new Error(
          'Operative identity work does not match its complete history batch.',
        )
    }
    return { records: rows.length, identities: heads.size }
  }

  private assertTransaction(
    transaction: FuturesOperativeIdentityTransaction,
  ): void {
    if (
      !transaction ||
      transaction.database !== this.db ||
      !this.activeTransactions.has(transaction) ||
      !this.db.isTransaction
    )
      throw new Error(
        'Operative identity apply requires this store owner transaction.',
      )
  }
}

function validateApplyInput(input: FuturesOperativeApplyInput): void {
  validateRunId(input.runId)
  if (!isNonEmpty(input.workId, 512))
    throw new Error('Operative identity work ID is invalid.')
  for (const [name, value] of [
    ['expected state version', input.expectedStateVersion],
    ['source frontier', input.sourceFrontier],
    ['confirmed source frontier', input.confirmedSourceFrontier],
  ] as const)
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error(`Operative identity ${name} is invalid.`)
  if (input.sourceFrontier > input.confirmedSourceFrontier)
    throw new Error(
      'Operative identity source frontier is ahead of confirmed source state.',
    )
  if (!Array.isArray(input.updates) || input.updates.length > MAX_BATCH)
    throw new Error(
      `Operative identity update batch must contain at most ${MAX_BATCH} records.`,
    )
}

function validateUpdate(update: FuturesOperativeIdentityUpdate): void {
  if (!isRecord(update) || !isKind(update.kind))
    throw new Error('Unsupported operative identity kind.')
  validateKey(update.kind, update.key)
  if (!isNonEmpty(update.provenance, 4096))
    throw new Error('Operative identity provenance is required and bounded.')
  const encoded = canonicalJson(update.value)
  if (Buffer.byteLength(encoded, 'utf8') > MAX_VALUE_BYTES)
    throw new Error('Operative identity value exceeds the storage limit.')
  validateValue(update.kind, update.value)
  if (
    update.kind === 'order' &&
    (update.value.intent.order_id !== update.key ||
      update.value.receipt.order_id !== update.key)
  )
    throw new Error(
      'Operative order identity key must match the Python order payload.',
    )
  if (update.kind === 'order_trade') {
    const [orderId, tradeUid] = JSON.parse(update.key) as [string, string]
    if (!orderId || !tradeUid)
      throw new Error('Malformed per-order trade-seen identity key.')
  }
}

function validateValue<K extends FuturesOperativeIdentityKind>(
  kind: K,
  value: FuturesOperativeIdentityValue[K],
): void {
  const candidate: unknown = value
  if (kind === 'order') {
    if (
      !isRecord(candidate) ||
      !isRecord(candidate.intent) ||
      !isRecord(candidate.receipt) ||
      (candidate.state !== undefined &&
        ![
          'accepted',
          'partially_filled',
          'filled',
          'cancelled',
          'expired',
          'rejected',
        ].includes(String(candidate.state))) ||
      (candidate.filled !== undefined && !isDecimalString(candidate.filled))
    )
      throw new Error('Malformed operative order identity payload.')
    return
  }
  if (kind === 'cancel') {
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !Array.isArray(value[0]) ||
      value[0].length !== 2 ||
      !isNonEmpty(value[0][0], 4096) ||
      !Number.isSafeInteger(value[0][1]) ||
      !Array.isArray(value[1])
    )
      throw new Error('Malformed operative cancellation identity payload.')
    return
  }
  if (kind === 'trade') {
    if (
      !Array.isArray(value) ||
      value.length !== 3 ||
      !isDecimalString(value[0]) ||
      !isDecimalString(value[1]) ||
      (value[2] !== 'buy' && value[2] !== 'sell')
    )
      throw new Error('Malformed operative trade identity payload.')
    return
  }
  if (kind === 'book_budget') {
    if (
      !isRecord(candidate) ||
      !isBudgetSide(candidate.asks) ||
      !isBudgetSide(candidate.bids)
    )
      throw new Error('Malformed operative book-budget payload.')
    return
  }
  if (kind === 'trade_budget') {
    if (!isDecimalString(value))
      throw new Error('Malformed operative trade-budget payload.')
    return
  }
  if (value !== true)
    throw new Error('Malformed per-order trade-seen identity payload.')
}

function validateTransition(
  kind: FuturesOperativeIdentityKind,
  prior: FuturesOperativeIdentityValue[FuturesOperativeIdentityKind] | null,
  next: FuturesOperativeIdentityValue[FuturesOperativeIdentityKind],
): void {
  if (prior === null) return
  if (kind === 'cancel' || kind === 'trade' || kind === 'order_trade') {
    if (canonicalJson(prior) !== canonicalJson(next))
      throw new Error(`Conflicting immutable operative ${kind} identity.`)
    return
  }
  if (kind === 'order') {
    const before = prior as FuturesOperativeIdentityValue['order']
    const after = next as FuturesOperativeIdentityValue['order']
    if (
      canonicalJson(before.intent) !== canonicalJson(after.intent) ||
      canonicalJson(before.receipt) !== canonicalJson(after.receipt)
    )
      throw new Error('Conflicting operative order identity reuse.')
    if (
      before.state &&
      ['filled', 'cancelled', 'expired', 'rejected'].includes(before.state) &&
      canonicalJson(before) !== canonicalJson(after)
    )
      throw new Error(
        'Conflicting update to terminal operative order identity.',
      )
    const ranks: Record<string, number> = {
      accepted: 0,
      partially_filled: 1,
      filled: 2,
      cancelled: 2,
      expired: 2,
      rejected: 2,
    }
    if (
      before.state &&
      after.state &&
      ranks[after.state]! < ranks[before.state]!
    )
      throw new Error('Operative order state cannot move backwards.')
  }
}

function validateKey(kind: FuturesOperativeIdentityKind, key: string): void {
  if (!isNonEmpty(key, MAX_KEY_BYTES))
    throw new Error('Operative identity key is invalid or oversized.')
  if (kind !== 'book_budget' && kind !== 'order_trade') return
  let parts: unknown
  try {
    parts = JSON.parse(key)
  } catch {
    throw new Error('Operative composite identity key is malformed.')
  }
  const count = kind === 'book_budget' ? 5 : 2
  if (
    !Array.isArray(parts) ||
    parts.length !== count ||
    parts.some((part) => !isNonEmpty(part, MAX_KEY_BYTES)) ||
    canonicalJson(parts) !== key
  )
    throw new Error(
      'Operative composite identity key has invalid shape or encoding.',
    )
}

function decodeValue<K extends FuturesOperativeIdentityKind>(
  kind: K,
  encoded: string,
  expectedHash: string | undefined,
): FuturesOperativeIdentityValue[K] {
  let value: unknown
  try {
    value = JSON.parse(encoded)
  } catch {
    throw new Error('Operative identity value JSON is malformed.')
  }
  if (
    canonicalJson(value) !== encoded ||
    (expectedHash && canonicalHash(value) !== expectedHash)
  )
    throw new Error(
      'Operative identity value canonical hash verification failed.',
    )
  validateValue(kind, value as FuturesOperativeIdentityValue[K])
  return value as FuturesOperativeIdentityValue[K]
}

function sameHead(
  current: Omit<HistoryRow, 'previous_hash'>,
  history: HistoryRow,
): boolean {
  return (
    Number(current.revision) === Number(history.revision) &&
    current.value_json === history.value_json &&
    current.value_hash === history.value_hash &&
    current.record_hash === history.record_hash &&
    current.provenance === history.provenance &&
    Number(current.source_frontier) === Number(history.source_frontier) &&
    current.work_id === history.work_id &&
    Number(current.expected_version) === Number(history.expected_version)
  )
}

function isKind(value: unknown): value is FuturesOperativeIdentityKind {
  return (
    typeof value === 'string' && (KINDS as readonly string[]).includes(value)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBudgetSide(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([price, quantity]) =>
        isDecimalString(price) && isDecimalString(quantity),
    )
  )
}

function isDecimalString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return normalizeDecimal(value) === value
  } catch {
    return false
  }
}

function isNonEmpty(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= maximum
  )
}

function validateRunId(runId: string): void {
  if (!isNonEmpty(runId, 512))
    throw new Error('Operative identity run ID is invalid.')
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === 'object' && value !== null) ||
      typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  )
}
