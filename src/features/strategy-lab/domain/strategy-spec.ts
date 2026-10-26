/**
 * Front-side types of `balancita-strategy.v1`, the spec the strategy registry
 * S validates and runs (`futures_spec_strategy.py`). The registry is the
 * authority: these helpers only read and patch a spec for the editor.
 */

export const STRATEGY_SCHEMA = 'balancita-strategy.v1'

export type Side = 'LONG' | 'SHORT'
export type Comparator = '<' | '<=' | '>' | '>='
export type Regime = 'unknown' | 'trend' | 'range'

/** A feature (`1m.rsi14`), a `$param`, a decimal string or a product. */
export type Operand = string | { mul: [Operand, Operand] }

export type CmpNode = {
  cmp: string
  left: Operand
  op: Comparator
  right: Operand
}

export type SpecNode =
  | CmpNode
  | { available: string; operand: Operand }
  | { regime_in: Regime[]; code?: string }
  | { not: SpecNode }
  | { and: SpecNode[] }
  | { all: SpecNode[] }
  | { any: SpecNode[] }

export type SideEntry = {
  requires: string[]
  reason: string
  invalidation: string
  target?: Operand
  target_condition?: string
}

export type Rules = {
  gates?: Array<{
    require: 'previous' | 'trend'
    reason: string
    condition?: string
  }>
  checks: Array<{ name?: string; node: SpecNode }>
  sides: Partial<Record<Side, SideEntry>>
  exit: Record<Side, SpecNode>
  /**
   * `stop_atr` and `target_stop_ratio` scale the 1m ATR(14) by default. With `vol`
   * (a `logvol<period>` feature of the 1m or 5m series) and its series' `vol_minutes`,
   * they scale one standard deviation of the horizon's move instead.
   */
  risk: {
    stop_atr: string
    target_stop_ratio: string
    vol?: string
    vol_minutes?: number
  }
  horizon_minutes: number
}

export type StrategySpec = {
  schema: typeof STRATEGY_SCHEMA
  id: string
  version: number
  name: string
  description?: string
  params: Record<string, string>
  kind?: 'rules' | 'regime_adapter'
  /** Extra indicator periods the rules read (kind -> periods), on top of the default set. */
  indicators?: Partial<Record<string, number[]>>
  rules?: Rules
  branches?: Partial<Record<'trend' | 'range', { id: string; rules: Rules }>>
}

/** Index path from a check's node down to one comparison. */
export type CmpPath = { check: number; steps: number[] }

export type EditableCondition = { path: CmpPath; node: CmpNode }

export const COMPARATOR_LABELS: Record<Comparator, string> = {
  '>': '>',
  '>=': '≥',
  '<': '<',
  '<=': '≤',
}

const SCOPE_LABELS: Record<string, string> = {
  '1m': '',
  '1m_previous': 'Previa · ',
  '5m': '5m · ',
  position: 'Posición · ',
}

const FIELD_LABELS: Record<string, string> = {
  candidate_close: 'Cierre',
  candidate_low: 'Mínimo',
  candidate_high: 'Máximo',
  candidate_volume: 'Volumen',
  ema9: 'EMA 9',
  ema21: 'EMA 21',
  sma50: 'SMA 50',
  rsi14: 'RSI 14',
  atr14: 'ATR 14',
  bollinger_lower20: 'Bollinger inf. 20',
  bollinger_mid20: 'Bollinger media 20',
  bollinger_upper20: 'Bollinger sup. 20',
  bollinger_stddev20: 'Bollinger desvío 20',
  donchian_high20: 'Donchian máx. 20',
  donchian_low20: 'Donchian mín. 20',
  donchian_mid20: 'Donchian media 20',
  prior_volume_mean20: 'Volumen medio 20',
  frozen_target: 'objetivo congelado',
  frozen_invalidation: 'invalidación congelada',
}

const DECIMAL = /^-?\d+(?:\.\d+)?$/

export function isParam(operand: Operand): operand is string {
  return typeof operand === 'string' && operand.startsWith('$')
}

export function isFeature(operand: Operand): operand is string {
  return typeof operand === 'string' && operand.includes('.')
}

export function featureLabel(ref: string): string {
  const [scope = '', field = ''] = ref.split('.', 2)
  return `${SCOPE_LABELS[scope] ?? `${scope} · `}${FIELD_LABELS[field] ?? field}`
}

export function operandLabel(
  operand: Operand,
  params: Record<string, string> = {},
): string {
  if (typeof operand !== 'string')
    return operand.mul.map((factor) => operandLabel(factor, params)).join(' × ')
  if (isParam(operand)) {
    const value = params[operand.slice(1)]
    return value === undefined
      ? operand
      : `${operand} · ${formatDecimal(value)}`
  }
  if (isFeature(operand)) return featureLabel(operand)
  return formatDecimal(operand)
}

const BAR_MINUTES: Record<string, number> = {
  '1m': 1,
  '1m_previous': 1,
  '5m': 5,
}

const SCOPE_SUFFIX: Record<string, string> = {
  '1m': '',
  '1m_previous': ' de la vela previa',
  '5m': ' (5 m)',
}

/** `72` bars of 5 m → `6 h`; minutes below an hour, hours up to two days. */
function barsDuration(bars: number, minutes: number): string {
  const total = bars * minutes
  if (total < 60) return `${total} min`
  if (total <= 48 * 60 && total % 60 === 0) return `${total / 60} h`
  if (total % 1440 === 0) return `${total / 1440} d`
  return `${(total / 60).toLocaleString('es-ES', { maximumFractionDigits: 1 })} h`
}

/** A feature as a reader says it: `5m.logret72` → `Retorno 6 h`. */
export function featurePhrase(ref: string): string {
  const [scope = '', field = ''] = ref.split('.', 2)
  const minutes = BAR_MINUTES[scope]
  const windowed = /^(logret|logvol)(\d+)$/.exec(field)
  if (windowed && minutes !== undefined)
    return `${windowed[1] === 'logret' ? 'Retorno' : 'Volatilidad'} ${barsDuration(Number(windowed[2]), minutes)}`
  const base = FIELD_LABELS[field] ?? field
  if (scope === 'position') return `${base} de la posición`
  return `${base}${SCOPE_SUFFIX[scope] ?? ` (${scope})`}`
}

function factors(operand: Operand): Operand[] {
  return typeof operand === 'string'
    ? [operand]
    : operand.mul.flatMap((factor) => factors(factor))
}

/** Constants first, then features: `2,5 × Volatilidad 24 h`. */
function productPhrase(
  operand: Operand,
  params: Record<string, string>,
): { text: string; negative: boolean } {
  let negative = false
  const numbers: string[] = []
  const features: string[] = []
  for (const factor of factors(operand)) {
    if (typeof factor !== 'string') continue
    const value = factor.startsWith('$')
      ? params[factor.slice(1)]
      : DECIMAL.test(factor)
        ? factor
        : null
    if (value === null) features.push(featurePhrase(factor))
    else if (value === undefined) numbers.push(factor)
    else if (Number(value) === -1) negative = !negative
    else if (Number(value) !== 1)
      numbers.push(
        Number(value).toLocaleString('es-ES', { maximumFractionDigits: 2 }),
      )
  }
  const parts = [...numbers, ...features]
  return { text: parts.length > 0 ? parts.join(' × ') : '1', negative }
}

const FLIPPED: Record<Comparator, Comparator> = {
  '>': '<',
  '>=': '<=',
  '<': '>',
  '<=': '>=',
}

/**
 * A condition as a sentence: `Retorno 6 h > 2,5 × 8,49 × Volatilidad 24 h`.
 * A negated left side moves to the right (`−R > x` reads `R < −x`).
 */
export function conditionSentence(
  node: Pick<CmpNode, 'left' | 'op' | 'right'>,
  params: Record<string, string> = {},
): string {
  const left = productPhrase(node.left, params)
  const right = productPhrase(node.right, params)
  const op = left.negative ? FLIPPED[node.op] : node.op
  const negateRight = left.negative !== right.negative
  return `${left.text} ${COMPARATOR_LABELS[op]} ${negateRight ? '−' : ''}${right.text}`
}

/** `1.5` → `1,5` for display; specs always store dot decimals. */
export function formatDecimal(value: string): string {
  return value.replace('.', ',')
}

/** Parsed JSON or a readable error, for the import box. */
export function parseSpecText(text: string): {
  spec: StrategySpec | null
  error: string | null
} {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Text copied from markdown or chat often carries `\_` and HTML entities.
    const cleaned = text
      .replace(/\\_/g, '_')
      .replace(/&gt;/g, '>')
      .replace(/&lt;/g, '<')
      .replace(/&amp;/g, '&')
    try {
      value = JSON.parse(cleaned)
    } catch (failure) {
      const detail = failure instanceof Error ? ` ${failure.message}` : ''
      return { spec: null, error: `No es un JSON válido.${detail}` }
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { spec: null, error: 'El JSON debe ser un objeto.' }
  const record = value as Record<string, unknown>
  const spec = (
    typeof record.spec === 'object' && record.spec !== null
      ? record.spec
      : record
  ) as StrategySpec
  if (spec.schema !== STRATEGY_SCHEMA)
    return { spec: null, error: `schema debe ser "${STRATEGY_SCHEMA}".` }
  return { spec, error: null }
}
