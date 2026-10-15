/**
 * SYNTHETIC fixtures for the session blocks (Issue #187). They follow the
 * shape `python/balancita_engine/paper_live_publish.py` (PR #192) emits; they
 * come from no real session, no capture and no database, and every numeric
 * limit in them is a test value, not an approved threshold.
 */
type Json = Record<string, unknown>

export function position(overrides: Json = {}): Json {
  return {
    intent_id: 'syn-intent-1',
    product_id: 'PF_XBTUSD',
    side: 'LONG',
    strategy_id: 'SYN-1',
    strategy_version: '1',
    entry_ms: 1_800_000_000_000,
    entry_price: '100000',
    stop: '99000',
    target: '102000',
    quantity: '0.001',
    stop_protection: 'observed',
    coverage: {
      quotes_watched: 40,
      last_watched_ms: 1_800_000_060_000,
      last_quote_ms: 1_800_000_060_000,
      silent_now_ms: null,
      gaps: [],
    },
    accounting_verified: true,
    protection_evidence: 'observed',
    verified: true,
    classes: { position: 'simulated', price: 'observed', pnl: 'estimated' },
    ...overrides,
  }
}

export function positionsBlock(
  verification: Json = {},
  positions: Json[] = [position()],
): Json {
  return {
    schema: 'balancita-paper-session-positions.v1',
    mode: 'integration',
    evidence_class: 'not_forward_evidence',
    execution_class: 'observed_quotes',
    clock_ms: 1_800_000_060_000,
    verification: {
      verified: true,
      reasons: [],
      freshness: 'fresh',
      thresholds: { report_max_age_ms: 60_000, status: 'hypothesis' },
      ...verification,
    },
    unrealized_usd: '1.25',
    unrealized_class: 'estimated',
    positions,
  }
}

/** Family 1 · verification of positions. */
export const verification = {
  /** Publisher says verified, on a limit that is only a hypothesis. */
  hypothesisFresh: () => positionsBlock(),
  /** No limit in the block: publisher says unknown and not verified. */
  notApproved: () =>
    positionsBlock(
      {
        verified: false,
        reasons: ['freshness_threshold_not_approved'],
        freshness: 'unknown',
        thresholds: { report_max_age_ms: null, status: 'not_approved' },
      },
      [position({ accounting_verified: false, verified: false })],
    ),
  /** Approved limit, report inside it: the only case allowed to be current. */
  approvedFresh: () =>
    positionsBlock({
      thresholds: { report_max_age_ms: 60_000, status: 'approved' },
    }),
  approvedStale: () =>
    positionsBlock({
      verified: false,
      reasons: ['report_stale'],
      freshness: 'stale',
      thresholds: { report_max_age_ms: 60_000, status: 'approved' },
    }),
  sourceStale: () =>
    positionsBlock({ verified: false, reasons: ['source_stale'] }, [
      position({ accounting_verified: false, verified: false }),
    ]),
  /** Accounting verified but the stop was never watched. */
  stopUnwatched: () =>
    positionsBlock({}, [
      position({
        stop_protection: 'not_yet_observed',
        protection_evidence: 'not_yet_observed',
        verified: false,
      }),
    ]),
}

/** Family 2 · coverage of the positions (funding is not in these blocks). */
export const coverage = {
  gaps: () =>
    positionsBlock({}, [
      position({
        coverage: {
          quotes_watched: 12,
          last_watched_ms: 1_800_000_000_000,
          last_quote_ms: 1_800_000_000_000,
          silent_now_ms: 45_000,
          gaps: [
            { from_ms: 1_800_000_010_000, to_ms: 1_800_000_050_000 },
            { from_ms: 1_800_000_052_000, to_ms: 1_800_000_058_000 },
          ],
        },
        verified: false,
      }),
    ]),
  noStopEvidence: () =>
    positionsBlock({}, [
      position({
        stop_protection: null,
        protection_evidence: null,
        verified: false,
      }),
    ]),
}

/** Family 3 · incomplete trace (B3 of the session). */
export const trace = {
  signalMissing: (): Json => ({
    schema: 'balancita-paper-session-intervals.v1',
    mode: 'integration',
    evidence_class: 'not_forward_evidence',
    execution_class: 'observed_quotes',
    clock_ms: 1_800_000_060_000,
    from_ms: null,
    to_ms: null,
    product: null,
    contract: {
      complete: false,
      stages_present: ['decision', 'order', 'trade'],
      stages_missing: ['signal'],
    },
    intervals: [
      {
        key: 'syn-signal-1',
        product_id: 'PF_XBTUSD',
        strategy_id: 'SYN-1',
        decided_ms: 1_800_000_000_000,
        side: 'LONG',
        stages: {
          signal: { state: 'not_available', signal_key: 'syn-signal-1' },
          decision: { state: 'recorded', decided_ms: 1_800_000_000_000 },
          order: { state: 'filled', reasons: [], entry_ms: 1_800_000_001_000 },
          trade: { state: 'open', trade_id: null, exit_reason: null },
        },
      },
      {
        key: null,
        product_id: 'PF_ETHUSD',
        strategy_id: 'SYN-1',
        decided_ms: null,
        side: 'SHORT',
        stages: {
          signal: { state: 'not_available', signal_key: null },
          decision: { state: 'none', decided_ms: null },
          order: { state: 'rejected', reasons: ['risk_limit'], entry_ms: null },
          trade: { state: 'none', trade_id: null, exit_reason: null },
        },
      },
    ],
  }),
}
