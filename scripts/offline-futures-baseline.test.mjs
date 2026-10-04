import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('scripts/offline-futures-baseline.mjs')

describe('offline futures baseline source pending lag report', () => {
  it('preserves source watermark lag provenance without calling it wall-clock age', () => {
    const snapshot = {
      source_pending_lag_ms: 10,
      source_pending_lag_clock_domain: 'source_received_time',
      source_pending_lag_cutoff_received_at: 30,
      source_pending_lag_watermark_sequence: 3,
      source_pending_lag_watermark_received_at: 30,
      source_pending_lag_oldest_sequence: 2,
      source_pending_lag_oldest_received_at: 20,
      source_pending_lag_unavailable_reason: null,
      oldest_job_age_ms: 9876,
    }
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [script, '--source-pending-lag-fixture', JSON.stringify(snapshot)],
        { encoding: 'utf8' },
      ),
    )

    expect(result).toMatchObject({
      source_pending_lag_ms: 10,
      source_pending_lag_clock_domain: 'source_received_time',
      source_pending_lag_cutoff_received_at: 30,
      source_pending_lag_watermark_sequence: 3,
      source_pending_lag_watermark_received_at: 30,
      source_pending_lag_oldest_sequence: 2,
      source_pending_lag_oldest_received_at: 20,
      source_pending_lag_unavailable_reason: null,
      source_oldest_pending_age_ms: null,
      source_oldest_pending_age_unavailable_reason:
        'No mapping from source received time to wall clock is established.',
    })
    expect(result.source_oldest_pending_age_ms).not.toBe(
      snapshot.oldest_job_age_ms,
    )
  })

  it('keeps legacy queue snapshots unknown rather than inventing zero lag', () => {
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [script, '--source-pending-lag-fixture', '{}'],
        {
          encoding: 'utf8',
        },
      ),
    )
    expect(result.source_pending_lag_ms).toBeNull()
    expect(result.source_pending_lag_unavailable_reason).toBe(
      'source_pending_lag_unavailable',
    )
    expect(result.source_oldest_pending_age_ms).toBeNull()
  })
})
