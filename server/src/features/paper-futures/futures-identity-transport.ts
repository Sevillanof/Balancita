export const FUTURES_IDENTITY_KINDS = [
  'order',
  'cancel',
  'trade',
  'book_budget',
  'trade_budget',
  'order_trade',
  'ledger_fill',
  'ledger_funding',
  'ledger_accrual',
  'signal',
] as const

export type FuturesIdentityKind = (typeof FUTURES_IDENTITY_KINDS)[number]
export const MAX_IDENTITY_KEYS = 128
export const MAX_IDENTITY_BYTES = 1_048_576
export const MAX_IDENTITY_QUERIES_PER_JOB = 1024

export interface FuturesIdentityQuery {
  readonly type: 'identity_query'
  readonly protocol_version: 1
  readonly request_id: string
  readonly run_id: string
  readonly work_id: string
  readonly expected_state_version: number
  readonly checkpoint_hash: string
  readonly source_frontier: number
  readonly query_sequence: number
  readonly knowledge_cutoff_ms: number
  readonly operation: 'lookup' | 'funding_range'
  readonly kind: FuturesIdentityKind
  readonly keys: readonly string[]
  readonly from_ms?: number | null
  readonly to_ms?: number | null
}

export function validateFuturesIdentityQuery(
  value: unknown,
): value is FuturesIdentityQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const query = value as Record<string, unknown>
  const keys = Object.keys(query).sort().join(',')
  const base = [
    'checkpoint_hash',
    'expected_state_version',
    'keys',
    'kind',
    'knowledge_cutoff_ms',
    'operation',
    'protocol_version',
    'query_sequence',
    'request_id',
    'run_id',
    'source_frontier',
    'type',
    'work_id',
  ]
    .sort()
    .join(',')
  const range = [...base.split(','), 'from_ms', 'to_ms'].sort().join(',')
  if (keys !== base && keys !== range) return false
  if (
    query.type !== 'identity_query' ||
    query.protocol_version !== 1 ||
    !FUTURES_IDENTITY_KINDS.includes(query.kind as FuturesIdentityKind) ||
    !['lookup', 'funding_range'].includes(String(query.operation)) ||
    ![query.request_id, query.run_id, query.work_id].every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 128,
    ) ||
    !Number.isSafeInteger(query.expected_state_version) ||
    Number(query.expected_state_version) < 0 ||
    !Number.isSafeInteger(query.source_frontier) ||
    Number(query.source_frontier) < 0 ||
    !Number.isSafeInteger(query.knowledge_cutoff_ms) ||
    Number(query.knowledge_cutoff_ms) < 0 ||
    !Number.isSafeInteger(query.query_sequence) ||
    Number(query.query_sequence) < 1 ||
    Number(query.query_sequence) > MAX_IDENTITY_QUERIES_PER_JOB ||
    typeof query.checkpoint_hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(query.checkpoint_hash) ||
    !Array.isArray(query.keys) ||
    query.keys.length > MAX_IDENTITY_KEYS ||
    query.keys.some(
      (key) =>
        typeof key !== 'string' ||
        !key ||
        Buffer.byteLength(key, 'utf8') > 4096,
    ) ||
    new Set(query.keys).size !== query.keys.length
  )
    return false
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') + 1 > MAX_IDENTITY_BYTES)
    return false
  if (query.operation === 'funding_range')
    return (
      query.kind === 'ledger_funding' &&
      query.keys.length === 0 &&
      [query.from_ms, query.to_ms].every(Number.isSafeInteger) &&
      Number(query.from_ms) <= Number(query.to_ms) &&
      Number(query.to_ms) <= Number(query.knowledge_cutoff_ms)
    )
  return (
    keys === base ||
    (keys === range && query.from_ms === null && query.to_ms === null)
  )
}
