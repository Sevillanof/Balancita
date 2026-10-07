import {
  cloneSpec,
  rulesOf,
  rulesScopes,
  sideConditions,
  type StrategySpec,
} from '../domain/strategy-spec.ts'
import type { LabCandle } from './lab-candles.ts'
import c25 from './fixtures/c25-pullback-perp-v1.json'
import c26 from './fixtures/c26-reversion-perp-v1.json'
import c27 from './fixtures/c27-breakout-perp-v1.json'
import c28 from './fixtures/c28-adapter-perp-v1.json'
import {
  StrategyApiError,
  type Backtest,
  type BacktestSummary,
  type BacktestTrade,
  type Gate,
  type PeriodDays,
  type RankingRow,
  type StrategyApi,
  type StrategyEntry,
  type StrategyEvent,
  type StrategyState,
} from './strategy-api.ts'

/** C25-C28 exactly as the registry seeds them from `config/strategies/`. */
export const BUILTIN_SPECS = [c25, c26, c27, c28] as unknown as StrategySpec[]

const INITIAL_CASH = 10_000
const MIN_TRADES = 30

function hash(text: string): number {
  let value = 2_166_136_261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16_777_619)
  }
  return value >>> 0
}

function seeded(seed: number) {
  let state = seed || 1
  return () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0
    return state / 4_294_967_296
  }
}

function summary(trades: BacktestTrade[]): BacktestSummary {
  const wins = trades.filter((trade) => trade.pnl_usd > 0)
  const losses = trades.filter((trade) => trade.pnl_usd <= 0)
  const pnl = trades.reduce((sum, trade) => sum + trade.pnl_usd, 0)
  const mean = (values: number[]) =>
    values.length === 0
      ? null
      : values.reduce((a, b) => a + b, 0) / values.length
  return {
    trades: trades.length,
    wins: wins.length,
    hit_rate: trades.length === 0 ? null : wins.length / trades.length,
    mean_net_bp: mean(trades.map((trade) => trade.net_bp)),
    pnl_usd: pnl,
    return_pct: (pnl / INITIAL_CASH) * 100,
    avg_win_usd: mean(wins.map((trade) => trade.pnl_usd)),
    avg_loss_usd: mean(losses.map((trade) => trade.pnl_usd)),
  }
}

/**
 * Stable made-up trades over the candles: same spec, same result. They only
 * keep the screen working without the registry; nothing here is a backtest.
 */
export function exampleBacktest(
  spec: StrategySpec,
  candles: readonly LabCandle[],
): Backtest {
  // Same rules and parameters, same trades, whatever the name or version.
  const rules = { ...spec, id: '', version: 0, name: '', description: '' }
  const random = seeded(hash(JSON.stringify(rules)))
  const trades: BacktestTrade[] = []
  const notional = INITIAL_CASH * 0.5
  let index = 30 + Math.floor(random() * 20)
  while (index < candles.length - 5) {
    const hold = 3 + Math.floor(random() * 20)
    const exitIndex = Math.min(index + hold, candles.length - 1)
    const entry = candles[index]!
    const exit = candles[exitIndex]!
    const side = random() > 0.5 ? 'LONG' : 'SHORT'
    const move = (exit.close - entry.close) / entry.close
    const net = (side === 'LONG' ? move : -move) - 0.0002
    trades.push({
      side,
      entry_time_ms: entry.time * 1000,
      entry_price: entry.close.toFixed(1),
      exit_time_ms: exit.time * 1000,
      exit_price: exit.close.toFixed(1),
      exit_reason: ['stop', 'target', 'strategy_exit', 'time_stop'][
        Math.floor(random() * 4)
      ]!,
      net_bp: net * 10_000,
      pnl_usd: net * notional,
    })
    index = exitIndex + 5 + Math.floor(random() * 40)
  }
  const split = Math.floor(trades.length * 0.7)
  let equity = INITIAL_CASH
  let peak = INITIAL_CASH
  let worst = 0
  for (const trade of trades) {
    equity += trade.pnl_usd
    peak = Math.max(peak, equity)
    worst = Math.min(worst, ((equity - peak) / peak) * 100)
  }
  const first = candles[0]
  const last = candles.at(-1)
  const buyAndHold =
    first && last ? ((last.close - first.close) / first.close) * 100 : null
  const all = summary(trades)
  return {
    period: {
      first_bucket_ms: first ? first.time * 1000 : null,
      last_bucket_ms: last ? last.time * 1000 : null,
      verdicts: candles.length,
    },
    all,
    in_sample: summary(trades.slice(0, split)),
    out_of_sample: summary(trades.slice(split)),
    max_drawdown: { pct: worst, at_ms: null },
    buy_and_hold_pct: buyAndHold,
    vs_buy_and_hold_pts:
      buyAndHold === null ? null : all.return_pct - buyAndHold,
    deflated_sharpe_probability: null,
    trials: 1,
    min_trades: MIN_TRADES,
    trades,
  }
}

type Stored = {
  spec: StrategySpec
  origin: string
  parent: StrategyEntry['parent']
  created_at: number
}

/** In-memory stand-in for the registry, used only when it does not answer. */
export function exampleStrategyApi(
  candles: readonly LabCandle[],
  now: () => number = Date.now,
): StrategyApi {
  const versions: Stored[] = BUILTIN_SPECS.map((spec) => ({
    spec: cloneSpec(spec),
    origin: 'builtin',
    parent: null,
    created_at: 0,
  }))
  const events: Array<StrategyEvent & { id: string }> = BUILTIN_SPECS.map(
    (spec) => ({
      id: spec.id,
      version: 1,
      state: 'active',
      reason: 'builtin',
      known_at: 0,
    }),
  )
  const backtested = new Set<string>()

  const stateOf = (id: string, version: number): StrategyState =>
    events
      .filter((event) => event.id === id && event.version === version)
      .at(-1)?.state ?? 'draft'
  const activeVersion = (id: string) =>
    versions
      .filter(
        (row) =>
          row.spec.id === id && stateOf(id, row.spec.version) === 'active',
      )
      .at(-1)?.spec.version ?? null
  const entry = (row: Stored): StrategyEntry => ({
    id: row.spec.id,
    version: row.spec.version,
    name: row.spec.name,
    description: row.spec.description ?? '',
    kind: row.spec.kind ?? 'rules',
    state: stateOf(row.spec.id, row.spec.version),
    active_version: activeVersion(row.spec.id),
    origin: row.origin,
    parent: row.parent,
    created_at: row.created_at,
  })
  const find = (id: string, version?: number) => {
    const rows = versions.filter((row) => row.spec.id === id)
    const row =
      version === undefined
        ? rows.at(-1)
        : rows.find((r) => r.spec.version === version)
    if (!row) throw new StrategyApiError('not_found', `No existe ${id}`, 404)
    return row
  }
  const latest = () => {
    const ids = [...new Set(versions.map((row) => row.spec.id))]
    return ids.map((id) => find(id))
  }
  const insert = (
    spec: StrategySpec,
    origin: string,
    parent: StrategyEntry['parent'],
  ) => {
    if (rulesScopes(spec).every((scope) => !rulesOf(spec, scope)))
      throw new StrategyApiError(
        'invalid_spec',
        'La estrategia no tiene reglas.',
        400,
      )
    if (
      sideConditions(rulesOf(spec, rulesScopes(spec)[0]!), 'LONG').length ===
        0 &&
      sideConditions(rulesOf(spec, rulesScopes(spec)[0]!), 'SHORT').length === 0
    )
      throw new StrategyApiError(
        'invalid_spec',
        'La estrategia no tiene condiciones de entrada.',
        400,
      )
    const row = { spec, origin, parent, created_at: now() }
    versions.push(row)
    events.push({
      id: spec.id,
      version: spec.version,
      state: 'draft',
      reason: origin,
      known_at: now(),
    })
    return entry(row)
  }
  const freshId = (name: string) => {
    const custom = new Set(
      versions
        .filter((row) => row.origin !== 'builtin')
        .map((row) => row.spec.id),
    )
    const slug =
      name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'estrategia'
    let candidate = `c${29 + custom.size}-${slug}`.slice(0, 64)
    for (
      let suffix = 2;
      versions.some((row) => row.spec.id === candidate);
      suffix += 1
    )
      candidate = `c${29 + custom.size}-${slug}-${suffix}`.slice(0, 64)
    return candidate
  }
  const save = (
    spec: StrategySpec,
    mode: 'modify' | 'new',
    newName?: string,
    origin = 'editor',
    newId?: string,
  ) => {
    const next = cloneSpec(spec)
    if (mode === 'modify') {
      const base = find(next.id)
      next.version = base.spec.version + 1
      return insert(next, origin, {
        id: base.spec.id,
        version: base.spec.version,
      })
    }
    const parent = versions.some((row) => row.spec.id === next.id)
      ? find(next.id)
      : null
    if (newName) next.name = newName
    next.id = newId ?? freshId(next.name)
    next.version = 1
    return insert(
      next,
      origin,
      parent && { id: parent.spec.id, version: parent.spec.version },
    )
  }
  const resolve = (
    ref: { id: string; version?: number } | { spec: StrategySpec },
  ) => ('spec' in ref ? ref.spec : find(ref.id, ref.version).spec)

  return {
    mode: 'example',
    async ranking(days: PeriodDays) {
      const rows: RankingRow[] = latest().map((row) => {
        const result = exampleBacktest(row.spec, candles)
        return {
          ...entry(row),
          return_pct: result.all.return_pct,
          pnl_usd: result.all.pnl_usd,
          hit_rate: result.all.hit_rate,
          trades: result.all.trades,
          wins: result.all.wins,
          few_trades: result.all.trades < MIN_TRADES,
          deflated_sharpe_probability: null,
        }
      })
      rows.sort((a, b) => (b.return_pct ?? 0) - (a.return_pct ?? 0))
      const first = candles[0]
      const last = candles.at(-1)
      return {
        product_id: 'PF_XBTUSD',
        days,
        buy_and_hold_pct:
          first && last
            ? ((last.close - first.close) / first.close) * 100
            : null,
        min_trades: MIN_TRADES,
        verdicts_available: true,
        strategies: rows,
      }
    },
    async detail(id, version) {
      const row = find(id, version)
      return {
        ...entry(row),
        spec: cloneSpec(row.spec),
        versions: versions.filter((r) => r.spec.id === id).map(entry),
        events: events
          .filter((event) => event.id === id)
          .map((event) => ({
            version: event.version,
            state: event.state,
            reason: event.reason,
            known_at: event.known_at,
          })),
      }
    },
    async backtest(ref) {
      const spec = resolve(ref)
      backtested.add(`${spec.id}@${spec.version}`)
      return exampleBacktest(spec, candles)
    },
    async evaluate(ref) {
      const spec = resolve(ref)
      const random = seeded(
        hash(JSON.stringify(spec)) ^ (candles.at(-1)?.time ?? 0),
      )
      const conditions = rulesScopes(spec).flatMap((scope) =>
        (['LONG', 'SHORT'] as const).flatMap((side) =>
          sideConditions(rulesOf(spec, scope), side).map(({ node }) => ({
            code: node.cmp,
            passed: random() > 0.45,
          })),
        ),
      )
      return {
        bucket_start_ms: (candles.at(-1)?.time ?? 0) * 1000,
        regime: null,
        proposal: { action: 'WAIT', reason_code: 'example', conditions },
      }
    },
    async save(spec, mode, newName) {
      return save(spec, mode, newName)
    },
    async variants(id, version, param, values) {
      const base = find(id, version).spec
      if (!(param in base.params))
        throw new StrategyApiError(
          'unknown_param',
          `${id} no tiene el parámetro ${param}`,
          400,
        )
      return values
        .filter((value) => value !== base.params[param])
        .map((value) => {
          const variant = cloneSpec(base)
          variant.params[param] = value
          return save(
            variant,
            'new',
            `${base.name} · ${param} ${value}`,
            'variant',
            `${id}-${param.replace(/_/g, '-')}-${value.replace('.', '-')}`.slice(
              0,
              64,
            ),
          )
        })
    },
    async importSpec(spec) {
      const taken = versions.some((row) => row.spec.id === spec.id)
      return save(spec, 'new', undefined, 'import', taken ? undefined : spec.id)
    },
    async translate() {
      throw new StrategyApiError(
        'model_unavailable',
        'Traducir Pine o freqtrade necesita el registro y el modelo local.',
        503,
      )
    },
    async setState(id, version, state) {
      const row = find(id, version)
      const gates: Gate[] =
        state === 'shadow'
          ? [
              {
                code: 'backtested',
                passed: backtested.has(`${id}@${version}`),
                value: null,
                threshold: true,
              },
            ]
          : state === 'active'
            ? [
                {
                  code: 'was_in_shadow',
                  passed: stateOf(id, version) === 'shadow',
                  value: stateOf(id, version),
                  threshold: 'shadow',
                },
                {
                  code: 'deflated_sharpe',
                  passed: false,
                  value: null,
                  threshold: 0.95,
                },
              ]
            : []
      if (!gates.every((gate) => gate.passed))
        throw new StrategyApiError(
          'gate_failed',
          `No se cumple el paso a ${state}.`,
          409,
          gates,
        )
      events.push({ id, version, state, reason: 'manual', known_at: now() })
      return { ...entry(row), gates }
    },
  }
}
