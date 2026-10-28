import type {
  AnalyzerCell,
  AnalyzerEvent,
  AnalyzerEvents,
} from '../infrastructure/analyzer-api.ts'

/**
 * DATOS DE EJEMPLO inventados para pruebas y capturas (nunca se muestran en la
 * app). Los reales salen de `GET /analyzer/events`.
 */
const HORIZONS = [5, 15, 30, 60]
const COSTS: Record<string, number> = {
  PF_XBTUSD: 10.8,
  PF_ETHUSD: 11.5,
  PF_SOLUSD: 13.2,
}

const cellOf = (patch: Partial<AnalyzerCell>): AnalyzerCell => {
  const full = {
    kind: 'move' as const,
    product: 'PF_XBTUSD',
    window: 5,
    direction: 'follow' as const,
    horizon: 5,
    events: 0,
    events_exported: 0,
    gross_bp: 0,
    excess_bp: 0,
    ic90_low_bp: null,
    p_holm: 1,
    ...patch,
  }
  return {
    ...full,
    id: `${full.kind}|${full.product}|${full.window}|${full.direction}|${full.horizon}`,
  }
}

const meta = (events: AnalyzerEvents['events']): AnalyzerEvents => ({
  schema: 'balancita.analyzer-events.v1',
  family: 'analyzer',
  generated_at: '2026-10-20T10:00:00Z',
  window: { from: '2026-01-01', to: '2026-04-19' },
  horizons: HORIZONS,
  round_trip_cost_bp: COSTS,
  cells: [],
  events,
})

/** Pequeño y a mano: dos productos, tres combinaciones. */
export function smallAnalyzerData(): AnalyzerEvents {
  const mk = (t: number, s: 1 | -1, r: number, up: number, dn: number) => ({
    t,
    s,
    h: { '5': { r, up, dn, f: 0.5 } },
  })
  const data = meta({
    'PF_XBTUSD|move|5': [
      mk(1000, 1, 40, 55, -8),
      mk(2000, 1, -20, 10, -35),
      mk(3000, -1, -30, 5, -45),
      mk(4000, 1, 15, 25, -400),
    ],
    'PF_ETHUSD|move|5': [mk(1000, 1, 12, 20, -9), mk(2000, -1, 18, 40, -5)],
  })
  data.horizons = [5]
  data.cells = [
    cellOf({
      product: 'PF_XBTUSD',
      direction: 'follow',
      events: 4,
      events_exported: 4,
    }),
    cellOf({
      product: 'PF_XBTUSD',
      direction: 'fade',
      events: 4,
      events_exported: 4,
    }),
    cellOf({
      product: 'PF_ETHUSD',
      direction: 'follow',
      events: 2,
      events_exported: 2,
    }),
  ]
  return data
}

function prng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Las 78 combinaciones con eventos sintéticos y deterministas: 3 productos x
 * 3 ventanas x seguir/revertir x 4 horizontes (72) + «BTC avisa» para ETH y SOL
 * (seguir, 15/30/60 min: 6).
 */
export function fullAnalyzerData(eventsPerKey = 60): AnalyzerEvents {
  const products = ['PF_XBTUSD', 'PF_ETHUSD', 'PF_SOLUSD']
  const events: AnalyzerEvents['events'] = {}
  const cells: AnalyzerCell[] = []
  let seed = 11
  const make = (product: string, kind: 'move' | 'leader', window: number) => {
    const rand = prng(seed++)
    const normal = () => (rand() + rand() + rand() + rand() - 2) * 1.7 // ~ N(0, 1)
    const edge = kind === 'leader' ? 4 : (seed % 5) - 1.5
    const list: AnalyzerEvent[] = []
    for (let i = 0; i < eventsPerKey; i++) {
      const s: 1 | -1 = rand() < 0.5 ? 1 : -1
      const h: AnalyzerEvent['h'] = {}
      for (const horizon of HORIZONS) {
        const scale = 9 * Math.sqrt(horizon)
        const r = s * edge * Math.sqrt(horizon) + scale * normal()
        const up =
          Math.max(0, r, scale * (0.6 + rand())) + (rand() < 0.04 ? 280 : 0)
        const dn =
          Math.min(0, r, -scale * (0.6 + rand())) - (rand() < 0.04 ? 280 : 0)
        h[String(horizon)] = {
          r: Math.round(r * 10) / 10,
          up: Math.round(up * 10) / 10,
          dn: Math.round(dn * 10) / 10,
          f: Math.round(horizon * 0.02 * 10) / 10,
        }
      }
      list.push({ t: 1_767_225_600_000 + i * 3_600_000 + seed * 1000, s, h })
    }
    events[`${product}|${kind}|${window}`] = list
  }
  for (const product of products)
    for (const window of [5, 15, 60]) {
      make(product, 'move', window)
      for (const direction of ['follow', 'fade'] as const)
        for (const horizon of HORIZONS)
          cells.push(
            cellOf({
              kind: 'move',
              product,
              window,
              direction,
              horizon,
              events: eventsPerKey,
              events_exported: eventsPerKey,
            }),
          )
    }
  for (const product of ['PF_ETHUSD', 'PF_SOLUSD']) {
    make(product, 'leader', 15)
    for (const horizon of [15, 30, 60])
      cells.push(
        cellOf({
          kind: 'leader',
          product,
          window: 15,
          direction: 'follow',
          horizon,
          events: eventsPerKey,
          events_exported: eventsPerKey,
        }),
      )
  }
  const data = meta(events)
  data.cells = cells
  return data
}
