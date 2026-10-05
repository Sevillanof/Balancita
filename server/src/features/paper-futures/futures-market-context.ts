export const MARKET_CONTEXT_SCHEMA_VERSION = 'market-context-transport.v1'
export const MAX_MARKET_CONTEXT_DELTAS = 128
export const MAX_MARKET_CONTEXT_BOOTSTRAP_EVENTS = 1002

export type MarketContextTransport = Readonly<{
  schema_version: typeof MARKET_CONTEXT_SCHEMA_VERSION
  source_identity: string | null
  instrument_id: string
  previous_frontier: number
  current_frontier: number
  knowledge_cutoff_ms: number
  bootstrap_events: readonly Record<string, unknown>[]
  delta_events: readonly Record<string, unknown>[]
}>

export function validateMarketContextTransport(
  value: unknown,
): value is MarketContextTransport {
  if (!isRecord(value)) return false
  const expected = [
    'schema_version',
    'source_identity',
    'instrument_id',
    'previous_frontier',
    'current_frontier',
    'knowledge_cutoff_ms',
    'bootstrap_events',
    'delta_events',
  ]
  if (
    Object.keys(value).sort().join(',') !== expected.sort().join(',') ||
    value.schema_version !== MARKET_CONTEXT_SCHEMA_VERSION ||
    (value.source_identity !== null &&
      (typeof value.source_identity !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.source_identity))) ||
    typeof value.instrument_id !== 'string' ||
    !Number.isSafeInteger(value.previous_frontier) ||
    Number(value.previous_frontier) < 0 ||
    !Number.isSafeInteger(value.current_frontier) ||
    Number(value.current_frontier) < Number(value.previous_frontier) ||
    !Number.isSafeInteger(value.knowledge_cutoff_ms) ||
    Number(value.knowledge_cutoff_ms) < 0 ||
    !Array.isArray(value.bootstrap_events) ||
    value.bootstrap_events.length > MAX_MARKET_CONTEXT_BOOTSTRAP_EVENTS ||
    !Array.isArray(value.delta_events) ||
    (value.current_frontier === value.previous_frontier
      ? value.delta_events.length !== 0
      : value.delta_events.length < 1) ||
    value.delta_events.length > MAX_MARKET_CONTEXT_DELTAS ||
    !value.bootstrap_events.every(isRecord) ||
    !value.delta_events.every(isRecord)
  )
    return false
  if (
    value.source_identity === null &&
    (value.previous_frontier !== 0 ||
      value.current_frontier !== 0 ||
      value.bootstrap_events.length !== 0 ||
      value.delta_events.length !== 0)
  )
    return false
  if (
    !value.bootstrap_events.every(
      (event) =>
        (event.source_receipt_sequence === undefined ||
          (Number.isSafeInteger(event.source_receipt_sequence) &&
            Number(event.source_receipt_sequence) >= 0 &&
            Number(event.source_receipt_sequence) <=
              Number(value.current_frontier))) &&
        (event.type !== 'book_snapshot' && event.type !== 'ticker'
          ? true
          : Number.isSafeInteger(event.source_receipt_sequence) &&
            Number(event.source_receipt_sequence) <=
              Number(value.current_frontier) &&
            Number.isSafeInteger(event.known_at_ms) &&
            Number(event.known_at_ms) <= Number(value.knowledge_cutoff_ms) &&
            Number.isSafeInteger(event.received_at_ms) &&
            Number(event.received_at_ms) <= Number(value.knowledge_cutoff_ms)),
    )
  )
    return false
  const sequences = value.delta_events.map((event) =>
    Number(event.source_receipt_sequence),
  )
  return (
    sequences.every(Number.isSafeInteger) &&
    sequences.every(
      (sequence, index) =>
        sequence > Number(value.previous_frontier) &&
        sequence <= Number(value.current_frontier) &&
        (index === 0 || sequence >= sequences[index - 1]!),
    ) &&
    (value.current_frontier === value.previous_frontier
      ? sequences.length === 0
      : sequences.at(-1) === Number(value.current_frontier))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
