/**
 * Front-side mirror of the declarative `balancita-strategy.v1` spec proposed
 * for PS-08a. The Python interpreter and the registry S own the canonical
 * shape; this module only keeps the Laboratorio editor and its in-browser
 * preview on the same vocabulary so swapping the data source is mechanical.
 */

export const STRATEGY_SCHEMA = 'balancita-strategy.v1'

export type Side = 'LONG' | 'SHORT'
export type Comparator = '<' | '<=' | '>' | '>='

/** `left op right`, where an operand is a feature, a `$param` or a decimal. */
export type Condition = {
  left: string
  op: Comparator
  right: string
  /** Optional `$param` or decimal the right operand is multiplied by. */
  scale?: string
}

export type RuleNode =
  Condition | { all: RuleNode[] } | { any: RuleNode[] } | { not: RuleNode }

export type Regime = 'trend' | 'range'

export type StrategySpec = {
  schema: typeof STRATEGY_SCHEMA
  id: string
  version: number
  name: string
  description?: string
  products: string[]
  regime: Regime[]
  params: Record<string, string>
  entry: Record<Side, RuleNode | null>
  /** Exit rule per open side; stop and target always apply on top. */
  exit: Record<Side, RuleNode | null>
  risk: { stop_atr: string; target_atr: string }
  horizon_minutes: number
  /** C28-style adapter: delegates to another strategy per regime. */
  delegate?: Partial<Record<Regime, string>>
}

export const COMPARATORS: readonly Comparator[] = ['>', '>=', '<', '<=']

export const COMPARATOR_LABELS: Record<Comparator, string> = {
  '>': '>',
  '>=': '≥',
  '<': '<',
  '<=': '≤',
}

/** Closed operand vocabulary: the indicator catalog of futures_indicators.py. */
export const FEATURE_LABELS: Record<string, string> = {
  '1m.candidate_close': 'Cierre',
  '1m.candidate_open': 'Apertura',
  '1m.candidate_high': 'Máximo',
  '1m.candidate_low': 'Mínimo',
  '1m.ema9': 'EMA 9',
  '1m.ema21': 'EMA 21',
  '1m.sma50': 'SMA 50',
  '1m.rsi14': 'RSI 14',
  '1m.atr14': 'ATR 14',
  '1m.bollinger_upper20': 'Bollinger sup. 20',
  '1m.bollinger_mid20': 'Bollinger media 20',
  '1m.bollinger_lower20': 'Bollinger inf. 20',
  '1m.donchian_high20': 'Donchian máx. 20',
  '1m.donchian_low20': 'Donchian mín. 20',
  '1m.donchian_mid20': 'Donchian media 20',
  '1m.volume': 'Volumen',
  '1m.prior_volume_mean20': 'Volumen medio 20',
  'prev.candidate_close': 'Vela previa · cierre',
  'prev.candidate_high': 'Vela previa · máximo',
  'prev.candidate_low': 'Vela previa · mínimo',
  'prev.ema9': 'Vela previa · EMA 9',
  'prev.ema21': 'Vela previa · EMA 21',
  'prev.rsi14': 'Vela previa · RSI 14',
  '5m.ema9': 'Tendencia 5m · EMA 9',
  '5m.ema21': 'Tendencia 5m · EMA 21',
}

export const FEATURES = Object.keys(FEATURE_LABELS)

const DECIMAL = /^-?\d+(?:\.\d+)?$/
const PARAM = /^\$[a-z][a-z0-9_]*$/

export function isCondition(node: RuleNode): node is Condition {
  return 'left' in node
}

export function operandLabel(operand: string, spec?: StrategySpec): string {
  if (FEATURE_LABELS[operand]) return FEATURE_LABELS[operand]
  if (PARAM.test(operand)) {
    const value = spec?.params[operand.slice(1)]
    return value === undefined
      ? operand
      : `${operand} · ${formatDecimal(value)}`
  }
  return formatDecimal(operand)
}

/** `1.5` → `1,5` for display; specs always store dot decimals. */
export function formatDecimal(value: string): string {
  return value.replace('.', ',')
}

/** Accepts `1,5` or `1.5`; returns the dot decimal or null. */
export function parseDecimalInput(value: string): string | null {
  const normalized = value.trim().replace(',', '.')
  return DECIMAL.test(normalized) ? normalized : null
}

/** Top-level conditions of a side, flattening a root `all`. */
export function sideConditions(node: RuleNode | null): Condition[] {
  if (node === null) return []
  if (isCondition(node)) return [node]
  if ('all' in node) return node.all.filter(isCondition)
  return []
}

export function cloneSpec(spec: StrategySpec): StrategySpec {
  return JSON.parse(JSON.stringify(spec)) as StrategySpec
}

/** Strategy number from ids like `c25-pullback-perp-v1` or `c31-mine`. */
export function strategyNumber(id: string): number | null {
  const match = /^c(\d+)-/.exec(id)
  return match ? Number(match[1]) : null
}

export function shortName(spec: StrategySpec): string {
  const number = strategyNumber(spec.id)
  return number === null ? spec.name : `C${number} · ${spec.name}`
}

function validateNode(node: unknown, path: string, errors: string[]): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    errors.push(`${path}: debe ser una condición o un grupo`)
    return
  }
  const value = node as Record<string, unknown>
  if ('left' in value) {
    for (const key of ['left', 'right'] as const) {
      const operand = value[key]
      if (
        typeof operand !== 'string' ||
        !(
          FEATURE_LABELS[operand] ||
          PARAM.test(operand) ||
          DECIMAL.test(operand)
        )
      )
        errors.push(`${path}.${key}: operando desconocido`)
    }
    if (!COMPARATORS.includes(value.op as Comparator))
      errors.push(`${path}.op: comparador inválido`)
    if (
      value.scale !== undefined &&
      !(
        typeof value.scale === 'string' &&
        (PARAM.test(value.scale) || DECIMAL.test(value.scale))
      )
    )
      errors.push(`${path}.scale: debe ser un número o un $parámetro`)
    return
  }
  if (Array.isArray(value.all) || Array.isArray(value.any)) {
    const list = (value.all ?? value.any) as unknown[]
    list.forEach((child, index) =>
      validateNode(child, `${path}[${index}]`, errors),
    )
    return
  }
  if ('not' in value) {
    validateNode(value.not, `${path}.not`, errors)
    return
  }
  errors.push(`${path}: debe ser una condición o un grupo all/any/not`)
}

/** Structural validation of an imported spec; returns readable errors. */
export function validateSpec(value: unknown): {
  spec: StrategySpec | null
  errors: string[]
} {
  const errors: string[] = []
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { spec: null, errors: ['El JSON debe ser un objeto.'] }
  const spec = value as Record<string, unknown>
  if (spec.schema !== STRATEGY_SCHEMA)
    errors.push(`schema debe ser "${STRATEGY_SCHEMA}"`)
  if (typeof spec.id !== 'string' || !/^c\d+-[a-z0-9-]+$/.test(spec.id))
    errors.push('id debe tener la forma c29-nombre')
  if (!Number.isSafeInteger(spec.version) || Number(spec.version) < 1)
    errors.push('version debe ser un entero positivo')
  if (typeof spec.name !== 'string' || spec.name.trim() === '')
    errors.push('name es obligatorio')
  const params = spec.params
  if (
    typeof params !== 'object' ||
    params === null ||
    Object.values(params).some(
      (param) => typeof param !== 'string' || !DECIMAL.test(param),
    )
  )
    errors.push('params debe mapear nombres a números decimales en texto')
  const entry = spec.entry as Record<string, unknown> | undefined
  if (typeof entry !== 'object' || entry === null)
    errors.push('entry es obligatorio')
  else
    for (const side of ['LONG', 'SHORT'] as const)
      if (entry[side] !== null && entry[side] !== undefined)
        validateNode(entry[side], `entry.${side}`, errors)
  const exit = spec.exit as Record<string, unknown> | undefined
  if (typeof exit === 'object' && exit !== null)
    for (const side of ['LONG', 'SHORT'] as const)
      if (exit[side] !== null && exit[side] !== undefined)
        validateNode(exit[side], `exit.${side}`, errors)
  const risk = spec.risk as Record<string, unknown> | undefined
  if (
    typeof risk !== 'object' ||
    risk === null ||
    typeof risk.stop_atr !== 'string' ||
    typeof risk.target_atr !== 'string' ||
    !DECIMAL.test(risk.stop_atr) ||
    !DECIMAL.test(risk.target_atr)
  )
    errors.push('risk.stop_atr y risk.target_atr son números decimales')
  if (!Number.isSafeInteger(spec.horizon_minutes))
    errors.push('horizon_minutes debe ser un entero')
  if (errors.length > 0) return { spec: null, errors }
  return {
    spec: {
      ...(spec as unknown as StrategySpec),
      products: Array.isArray(spec.products)
        ? (spec.products as string[])
        : ['PF_XBTUSD'],
      regime: Array.isArray(spec.regime) ? (spec.regime as Regime[]) : [],
      exit: (exit ?? { LONG: null, SHORT: null }) as StrategySpec['exit'],
    },
    errors,
  }
}
