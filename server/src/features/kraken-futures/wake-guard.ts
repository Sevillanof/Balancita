import type { WakeEvent } from '../../platform/wake-detector.ts'

export interface WakeGuardOptions {
  readonly retention: { pauseFor(ms: number): void }
  readonly dbHealth: { afterWake(event: WakeEvent): Promise<void> }
  /** The shared connection log (`resilience.jsonl`) and the "fresh connections" switch. */
  readonly connections: {
    report(event: {
      component: string
      product: string | null
      reason: string
      action: string
      result: 'info'
      detail?: string
    }): void
    markGeneral(): void
  }
  readonly log: (line: string) => void
  /** Cleanup stays off this long after a wake-up (default 10 min). */
  readonly pauseMs?: number
}

/**
 * What the capture does when the machine wakes up from sleep (or a long stall):
 * (a) the retention cleanup pauses for `pauseMs` and then resumes by itself;
 * (b) the WAL is truncated and a `quick_check` runs before heavy writes resume
 *     (the cleanup also stays off while that check says the database is damaged);
 * (c) a «despertar» event goes to `resilience.jsonl` and the HTTP clients open
 *     fresh connections for a while (sockets pooled before sleeping are dead),
 *     so the Kraken queries retry on new connections with their own backoff.
 */
export function createWakeGuard(options: WakeGuardOptions) {
  const pauseMs = options.pauseMs ?? 10 * 60_000
  return {
    async onWake(event: WakeEvent): Promise<void> {
      const minutes = Math.round(event.gapMs / 60_000)
      options.log(
        `wake-up detected (${event.kind}, ${minutes} min without running): cleanup paused ${Math.round(pauseMs / 60_000)} min, checking the database`,
      )
      options.retention.pauseFor(pauseMs)
      options.connections.markGeneral()
      options.connections.report({
        component: 'sistema',
        product: null,
        reason: 'despertar',
        action: 'pausar limpieza, truncar WAL y revisar la base',
        result: 'info',
        detail: `${event.kind}: ${Math.round(event.gapMs / 1000)} s sin correr, ${Math.round(event.sleptMs / 1000)} s dormida`,
      })
      try {
        await options.dbHealth.afterWake(event)
      } catch (error) {
        options.log(
          `wake-up check failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    },
  }
}
