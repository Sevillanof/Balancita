import { appendFileSync } from 'node:fs'

/** One thing the capture did (or failed to do) about a connection. */
export interface ResilienceEvent {
  readonly at: number
  readonly component: string
  readonly product: string | null
  readonly reason: string
  readonly action: string
  readonly result: 'recovering' | 'recovered' | 'failed' | 'info'
  readonly detail?: string
}

export interface ConnectionHealthOptions {
  readonly clock?: () => number
  /** JSON-lines file for the resilience log; omitted means the console only. */
  readonly logFile?: string
  readonly log?: (line: string) => void
  /** Incidents of this many distinct sources inside the window mean a general problem. */
  readonly generalThreshold?: number
  readonly generalWindowMs?: number
  /** After a general problem, HTTP requests ask for new connections for this long. */
  readonly freshConnectionsMs?: number
  /** Minimum time between two forced recoveries of the same source. */
  readonly minRecoveryGapMs?: number
}

/**
 * Shared record of connection incidents. It does not own any connection: each
 * poller and socket keeps recovering itself, this only (1) writes the log,
 * (2) tells when several independent sources failed together (a connectivity
 * change, whatever caused it) and (3) keeps recoveries from stampeding Kraken.
 */
export class ConnectionHealth {
  private readonly clock: () => number
  private readonly o: Required<
    Omit<ConnectionHealthOptions, 'clock' | 'logFile' | 'log'>
  >
  private readonly logFile: string | undefined
  private readonly out: (line: string) => void
  private readonly incidents = new Map<string, number>()
  private readonly lastRecovery = new Map<string, number>()
  private generalAt = Number.NEGATIVE_INFINITY

  constructor(options: ConnectionHealthOptions = {}) {
    this.clock = options.clock ?? Date.now
    this.logFile = options.logFile
    this.out = options.log ?? (() => undefined)
    this.o = {
      generalThreshold: options.generalThreshold ?? 2,
      generalWindowMs: options.generalWindowMs ?? 60_000,
      freshConnectionsMs: options.freshConnectionsMs ?? 120_000,
      minRecoveryGapMs: options.minRecoveryGapMs ?? 5_000,
    }
  }

  report(event: Omit<ResilienceEvent, 'at'>): void {
    const now = this.clock()
    const full: ResilienceEvent = { at: now, ...event }
    const line = JSON.stringify(full)
    this.out(`resilience ${line}`)
    if (this.logFile !== undefined) {
      try {
        appendFileSync(this.logFile, `${line}\n`)
      } catch {
        // The log must never take the capture down.
      }
    }
    if (event.result !== 'recovering' && event.result !== 'failed') return
    this.incidents.set(event.component, now)
    for (const [key, at] of this.incidents)
      if (now - at > this.o.generalWindowMs) this.incidents.delete(key)
    if (this.incidents.size >= this.o.generalThreshold) this.generalAt = now
  }

  /** True while at least `generalThreshold` distinct sources failed together recently. */
  general(): boolean {
    return this.clock() - this.generalAt <= this.o.generalWindowMs
  }

  /** HTTP clients send `connection: close` while this holds, so no dead pooled socket is reused. */
  freshConnections(): boolean {
    return this.clock() - this.generalAt <= this.o.freshConnectionsMs
  }

  /** Rate limit for forced recoveries: true at most once per `minRecoveryGapMs` per source. */
  allowRecovery(source: string): boolean {
    const now = this.clock()
    const last = this.lastRecovery.get(source)
    if (last !== undefined && now - last < this.o.minRecoveryGapMs) return false
    this.lastRecovery.set(source, now)
    return true
  }
}
