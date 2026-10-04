export type MarketSourceProjectionSnapshot = Readonly<{
  sourceSequence: number
  book?: Readonly<{
    epoch: number
    sequence: number
    receivedAt: number
    valid: boolean
    contiguous: boolean
  }>
  ticker?: Readonly<{
    epoch: number
    sequence: number
    receivedAt: number
    suspended: boolean | undefined
  }>
  gapStatusKnown: boolean
  gapFree?: boolean
  eligible: boolean
}>

type GapStatus = Readonly<{ knownAtMs: number; gapFree: boolean }>

/** Compact, receipt-ordered admission metadata; never a financial event log. */
export class IncrementalMarketProjection {
  private sourceSequence: number
  private latestReceivedAt: number
  private latestRowSupportsAdmission = false
  private book: MarketSourceProjectionSnapshot['book']
  private ticker: MarketSourceProjectionSnapshot['ticker']
  private gapStatus: GapStatus | undefined
  private appliedRows = 0

  constructor(input: {
    baselineReceivedSequence: number
    baselineKnownAtMs: number
  }) {
    this.assertTime(input.baselineReceivedSequence, 'baseline sequence')
    this.assertTime(input.baselineKnownAtMs, 'baseline known time')
    this.sourceSequence = input.baselineReceivedSequence
    this.latestReceivedAt = input.baselineKnownAtMs
  }

  get rowsApplied(): number {
    return this.appliedRows
  }

  get lastReceivedSequence(): number {
    return this.sourceSequence
  }

  applySourceRow(
    source: Record<string, unknown>,
    receivedCutoff: number,
  ): void {
    this.assertTime(receivedCutoff, 'received cutoff')
    const sequence = this.numberField(source.receivedSequence)
    const receivedAt = this.numberField(source.receivedAt)
    if (sequence <= this.sourceSequence)
      throw new Error(
        'Market projection source rows must advance in receipt order.',
      )
    if (receivedAt > receivedCutoff)
      throw new Error(
        'Market projection source row is not known at the cutoff.',
      )

    this.sourceSequence = sequence
    this.latestReceivedAt = Math.max(this.latestReceivedAt, receivedAt)
    this.appliedRows += 1
    if (source.type === 'book') {
      const epoch = this.numberField(source.epoch)
      const bookSequence = this.numberField(source.seq)
      const attestation = source.marketQuality
      const attestedContiguous =
        typeof attestation === 'object' &&
        attestation !== null &&
        !Array.isArray(attestation) &&
        (attestation as Record<string, unknown>).schema_version ===
          'futures-market-quality-attestation.v1' &&
        (attestation as Record<string, unknown>).policy_version ===
          'snapshot-contiguous-observed.v1' &&
        (attestation as Record<string, unknown>).source_guarantee ===
          'undocumented' &&
        (attestation as Record<string, unknown>).book_sequence_integrity ===
          'observed_contiguous'
      const snapshot = source.snapshot === true
      const contiguous =
        snapshot && (source.contiguous === true || attestedContiguous)
      const valid =
        snapshot &&
        source.valid !== false &&
        (attestation === undefined ||
          (typeof attestation === 'object' &&
            attestation !== null &&
            !Array.isArray(attestation) &&
            (attestation as Record<string, unknown>).book_valid === true))
      this.book = {
        epoch,
        sequence: bookSequence,
        receivedAt,
        valid,
        contiguous,
      }
      this.latestRowSupportsAdmission = valid && contiguous
    } else if (source.type === 'ticker') {
      this.ticker = {
        epoch: this.numberField(source.epoch),
        sequence: this.numberField(source.seq),
        receivedAt,
        suspended:
          typeof source.suspended === 'boolean' ? source.suspended : undefined,
      }
      this.latestRowSupportsAdmission = typeof source.suspended === 'boolean'
    } else this.latestRowSupportsAdmission = false
  }

  updateGapStatus(input: { knownAtMs: number; gapFree: boolean }): void {
    this.assertTime(input.knownAtMs, 'gap status known time')
    if (typeof input.gapFree !== 'boolean')
      throw new TypeError(
        'Gap status must explicitly state whether the interval is gap-free.',
      )
    if (!this.gapStatus || input.knownAtMs >= this.gapStatus.knownAtMs)
      this.gapStatus = { ...input }
  }

  snapshotAt(cutoff: number): MarketSourceProjectionSnapshot {
    this.assertTime(cutoff, 'projection cutoff')
    const gapStatusKnown =
      this.gapStatus !== undefined &&
      this.gapStatus.knownAtMs === cutoff &&
      this.gapStatus.knownAtMs >= this.latestReceivedAt
    const gapFree = gapStatusKnown ? this.gapStatus!.gapFree : undefined
    const book =
      this.book && this.book.receivedAt <= cutoff ? this.book : undefined
    const ticker =
      this.ticker && this.ticker.receivedAt <= cutoff ? this.ticker : undefined
    return {
      sourceSequence: this.sourceSequence,
      ...(book ? { book } : {}),
      ...(ticker ? { ticker } : {}),
      gapStatusKnown,
      ...(gapFree === undefined ? {} : { gapFree }),
      eligible:
        gapFree === true &&
        this.latestRowSupportsAdmission &&
        book?.valid === true &&
        book.contiguous === true &&
        ticker !== undefined &&
        ticker.suspended === false &&
        book.epoch === ticker.epoch,
    }
  }

  private numberField(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new TypeError('Market projection source metadata is invalid.')
    return value
  }

  private assertTime(value: unknown, label: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new TypeError(`Market projection ${label} is invalid.`)
  }
}
