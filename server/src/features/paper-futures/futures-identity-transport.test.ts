import { describe, expect, it } from 'vitest'
import { validateFuturesIdentityQuery } from './futures-identity-transport.ts'

describe('futures identity transport protocol schema', () => {
  const query = {
    type: 'identity_query',
    protocol_version: 1,
    request_id: 'r',
    run_id: 'run',
    work_id: 'w',
    expected_state_version: 0,
    checkpoint_hash: 'a'.repeat(64),
    source_frontier: 4,
    query_sequence: 1,
    knowledge_cutoff_ms: 100,
    operation: 'lookup',
    kind: 'order',
    keys: ['o1'],
  }
  it('accepts a bound, typed lookup query', () =>
    expect(validateFuturesIdentityQuery(query)).toBe(true))
  it('rejects foreign shape, excess keys, and invalid funding horizon', () => {
    expect(validateFuturesIdentityQuery({ ...query, surprise: true })).toBe(
      false,
    )
    expect(
      validateFuturesIdentityQuery({ ...query, keys: Array(129).fill('x') }),
    ).toBe(false)
    expect(
      validateFuturesIdentityQuery({
        ...query,
        operation: 'funding_range',
        kind: 'ledger_funding',
        from_ms: 10,
        to_ms: 20,
        knowledge_cutoff_ms: 19,
      }),
    ).toBe(false)
  })
})
