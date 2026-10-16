import { describe, expect, it } from 'vitest'
import blocks from '../../../../docs/mission-control/b3/bloques-publicador-real.json'
import { decodeIntervalsBlock, decodePositionsBlock } from './session-blocks.ts'

// The blocks come from the REAL publisher (python/tests/session_blocks_187.py) fed with invented
// events: this is the check that the decoders read what Python emits, not what a fixture imagines.
describe('decoders against blocks the real publisher emitted', () => {
  it('positions: threshold not approved is unknown and not verified', () => {
    const block = decodePositionsBlock(blocks.positions)
    expect(block.verification).toMatchObject({
      verified: false,
      freshness: 'unknown',
      thresholds: { status: 'hypothesis' },
    })
    expect(block.verification.reasons).toContain(
      'freshness_threshold_not_approved',
    )
    expect(block.positions).toHaveLength(1)
  })

  it('positions: the position stays unverified until its stop is observed', () => {
    const block = decodePositionsBlock(blocks.positions_threshold_approved)
    expect(block.verification).toMatchObject({
      verified: true,
      freshness: 'fresh',
    })
    expect(block.positions[0]).toMatchObject({
      productId: 'PF_XBTUSD',
      side: 'LONG',
      stopProtection: 'not_yet_observed',
      accountingVerified: true,
      verified: false,
    })
  })

  it('intervals: every stage is filled and a signal without decision is a row of its own', () => {
    const block = decodeIntervalsBlock(blocks.intervals)
    expect(block.contract).toEqual({ complete: true, stagesMissing: [] })
    const byProduct = new Map(block.intervals.map((i) => [i.productId, i]))
    const buy = byProduct.get('PF_XBTUSD')
    const wait = byProduct.get('PF_ETHUSD')
    expect(buy?.signal.state).toBe('recorded')
    expect(buy?.decision.state).toBe('recorded')
    expect(buy?.order.state).toBe('opened')
    expect(wait?.signal.state).toBe('recorded')
    expect(wait?.side).toBe('none')
    expect(wait?.decision.state).toBe('none')
    expect(wait?.order.state).toBe('none')
    expect(wait?.trade.state).toBe('none')
  })

  it('intervals: a reference that does not match the log makes the contract incomplete', () => {
    const block = decodeIntervalsBlock(
      blocks.intervals_with_unverified_reference,
    )
    expect(block.contract.complete).toBe(false)
    expect(block.intervals.map((i) => i.productId)).toEqual(['PF_XBTUSD'])
  })
})
