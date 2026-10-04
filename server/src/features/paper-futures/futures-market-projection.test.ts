import { describe, expect, it } from 'vitest'
import { IncrementalMarketProjection } from './futures-market-projection.js'

describe('incremental receipt-order market projection', () => {
  it('tracks each normalized row once and requires acknowledged gap status', () => {
    const projection = new IncrementalMarketProjection({
      baselineReceivedSequence: 40,
      baselineKnownAtMs: 1_000,
    })
    const visited: number[] = []
    const apply = projection.applySourceRow.bind(projection)
    projection.applySourceRow = (source, cutoff) => {
      visited.push(Number(source.receivedSequence))
      return apply(source, cutoff)
    }
    const book = (
      receivedSequence: number,
      receivedAt: number,
      valid = true,
    ) => ({
      type: 'book',
      snapshot: true,
      receivedSequence,
      receivedAt,
      eventTime: receivedAt,
      epoch: 7,
      seq: receivedSequence,
      valid,
      contiguous: true,
      bids: [{ price: '100000', quantity: '1' }],
      asks: [{ price: '100001', quantity: '1' }],
    })
    const ticker = (
      receivedSequence: number,
      receivedAt: number,
      suspended = false,
    ) => ({
      type: 'ticker',
      receivedSequence,
      receivedAt,
      eventTime: receivedAt,
      epoch: 7,
      seq: receivedSequence,
      mark: '100000',
      suspended,
    })

    projection.applySourceRow(book(41, 1_001), 2_000)
    projection.applySourceRow(ticker(42, 1_002), 2_000)
    expect(projection.snapshotAt(2_000)).toMatchObject({
      sourceSequence: 42,
      book: { epoch: 7, sequence: 41, valid: true, contiguous: true },
      ticker: { epoch: 7, sequence: 42, suspended: false },
      gapStatusKnown: false,
      eligible: false,
    })

    projection.updateGapStatus({ knownAtMs: 1_003, gapFree: true })
    expect(projection.snapshotAt(1_002).gapStatusKnown).toBe(false)
    expect(projection.snapshotAt(1_003)).toMatchObject({
      gapStatusKnown: true,
      gapFree: true,
      eligible: true,
    })
    expect(projection.snapshotAt(2_000).gapStatusKnown).toBe(false)

    projection.applySourceRow(
      {
        type: 'trade',
        receivedSequence: 43,
        receivedAt: 1_003,
        eventTime: 1_003,
        epoch: 7,
        uid: 'trade-43',
        priceUsd: '100000',
        quantityBtc: '0.01',
      },
      2_000,
    )
    expect(projection.snapshotAt(2_000).eligible).toBe(false)
    projection.applySourceRow(book(44, 1_004, false), 2_000)
    expect(projection.snapshotAt(2_000)).toMatchObject({
      sourceSequence: 44,
      book: { valid: false, contiguous: true },
      gapStatusKnown: false,
      eligible: false,
    })
    projection.applySourceRow(book(47, 1_005), 2_000)
    expect(projection.snapshotAt(2_000).gapStatusKnown).toBe(false)
    projection.updateGapStatus({ knownAtMs: 1_005, gapFree: true })
    expect(projection.snapshotAt(1_005)).toMatchObject({
      sourceSequence: 47,
      book: { sequence: 47, valid: true, contiguous: true },
      gapStatusKnown: true,
      gapFree: true,
      eligible: true,
    })
    expect(projection.snapshotAt(2_000).gapStatusKnown).toBe(false)
    expect(visited).toEqual([41, 42, 43, 44, 47])
    expect(projection.rowsApplied).toBe(5)
    expect(() => projection.applySourceRow(ticker(47, 1_006), 2_000)).toThrow(
      'Market projection source rows must advance in receipt order.',
    )
  })
})
