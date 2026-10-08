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

/** Where a set of rules lives: the spec itself or one adapter branch. */
export type RulesScope = 'rules' | 'trend' | 'range'

/** Index path from a check's node down to one comparison. */
export type CmpPath = { check: number; steps: number[] }

export type EditableCondition = { path: CmpPath; node: CmpNode }

export const COMPARATORS: readonly Comparator[] = ['>', '>=', '<', '<=']

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

/** Operands the editor offers: the registry's feature catalog per scope. */
export const FEATURE_REFS: readonly string[] = [
  '1m',
  '1m_previous',
  '5m',
].flatMap((scope) =>
  Object.keys(FIELD_LABELS)
    .filter((field) => !field.startsWith('frozen_'))
    .map((field) => `${scope}.${field}`),
)

const DECIMAL = /^-?\d+(?:\.\d+)?$/

export function isCmp(node: SpecNode): node is CmpNode {
  return 'cmp' in node
}

export function isDecimal(operand: Operand): operand is string {
  return typeof operand === 'string' && DECIMAL.test(operand)
}

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

/** `1.5` → `1,5` for display; specs always store dot decimals. */
export function formatDecimal(value: string): string {
  return value.replace('.', ',')
}

/** Accepts `1,5` or `1.5`; returns the dot decimal or null. */
export function parseDecimalInput(value: string): string | null {
  const normalized = value.trim().replace(',', '.')
  return DECIMAL.test(normalized) ? normalized : null
}

/** Numbers typed as `35; 40; 45` for a parameter sweep, or null if invalid. */
export function parseParamValues(text: string): string[] | null {
  const parts = text
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return null
  const values = parts.map(parseDecimalInput)
  return values.every((value) => value !== null)
    ? [...new Set(values as string[])]
    : null
}

export function cloneSpec(spec: StrategySpec): StrategySpec {
  return structuredClone(spec)
}

/** Strategy number from ids like `c25-pullback-perp-v1` or `c31-mine`. */
export function strategyNumber(id: string): number | null {
  const match = /^c(\d+)-/.exec(id)
  return match ? Number(match[1]) : null
}

export function rulesScopes(spec: StrategySpec): RulesScope[] {
  if (spec.kind === 'regime_adapter')
    return (['trend', 'range'] as const).filter(
      (regime) => spec.branches?.[regime],
    )
  return ['rules']
}

export function rulesOf(
  spec: StrategySpec,
  scope: RulesScope,
): Rules | undefined {
  return scope === 'rules' ? spec.rules : spec.branches?.[scope]?.rules
}

function collect(
  node: SpecNode,
  check: number,
  steps: number[],
  out: EditableCondition[],
) {
  if (isCmp(node)) {
    out.push({ path: { check, steps }, node })
    return
  }
  const children =
    'and' in node
      ? node.and
      : 'all' in node
        ? node.all
        : 'any' in node
          ? node.any
          : null
  children?.forEach((child, index) =>
    collect(child, check, [...steps, index], out),
  )
}

/** Comparisons behind the checks a side requires, in the order written. */
export function sideConditions(
  rules: Rules | undefined,
  side: Side,
): EditableCondition[] {
  const entry = rules?.sides[side]
  if (!rules || !entry) return []
  const out: EditableCondition[] = []
  rules.checks.forEach((check, index) => {
    if (check.name === undefined || entry.requires.includes(check.name))
      collect(check.node, index, [], out)
  })
  return out
}

/** Returns a copy of `spec` with the comparison at `path` patched. */
export function patchCondition(
  spec: StrategySpec,
  scope: RulesScope,
  path: CmpPath,
  patch: Partial<Pick<CmpNode, 'left' | 'op' | 'right'>>,
): StrategySpec {
  const next = cloneSpec(spec)
  const rules = rulesOf(next, scope)
  const check = rules?.checks[path.check]
  if (!check) return spec
  let node: SpecNode = check.node
  for (const step of path.steps) {
    const children: SpecNode[] | undefined =
      'and' in node
        ? node.and
        : 'all' in node
          ? node.all
          : 'any' in node
            ? node.any
            : undefined
    if (!children?.[step]) return spec
    node = children[step]
  }
  if (!isCmp(node)) return spec
  Object.assign(node, patch)
  return next
}

function cmpCodes(rules: Rules): Set<string> {
  const codes = new Set<string>()
  const walk = (node: SpecNode) => {
    if (isCmp(node)) codes.add(node.cmp)
    else if ('and' in node) node.and.forEach(walk)
    else if ('all' in node) node.all.forEach(walk)
    else if ('any' in node) node.any.forEach(walk)
    else if ('not' in node) walk(node.not)
  }
  rules.checks.forEach((check) => walk(check.node))
  return codes
}

/** Returns a copy of `spec` with one new comparison required by `side`. */
export function addCondition(
  spec: StrategySpec,
  scope: RulesScope,
  side: Side,
): StrategySpec {
  const next = cloneSpec(spec)
  const rules = rulesOf(next, scope)
  const entry = rules?.sides[side]
  if (!rules || !entry) return spec
  const codes = cmpCodes(rules)
  const names = new Set(rules.checks.map((check) => check.name))
  let n = rules.checks.length + 1
  while (codes.has(`custom_${n}`) || names.has(`custom_${n}`)) n += 1
  const name = `custom_${n}`
  rules.checks.push({
    name,
    node: {
      cmp: name,
      left: '1m.candidate_close',
      op: '>',
      right: '1m.ema21',
    },
  })
  entry.requires.push(name)
  return next
}

/** Returns a copy of `spec` without the comparison at `path` for `side`. */
export function removeCondition(
  spec: StrategySpec,
  scope: RulesScope,
  side: Side,
  path: CmpPath,
): StrategySpec {
  const next = cloneSpec(spec)
  const rules = rulesOf(next, scope)
  const check = rules?.checks[path.check]
  if (!rules || !check) return spec
  if (path.steps.length === 0) {
    const name = check.name
    const entry = rules.sides[side]
    if (name !== undefined && entry) {
      entry.requires = entry.requires.filter((item) => item !== name)
      const stillUsed = Object.values(rules.sides).some((other) =>
        other?.requires.includes(name),
      )
      if (stillUsed) return next
    }
    rules.checks.splice(path.check, 1)
    return next
  }
  let parent: SpecNode = check.node
  for (const step of path.steps.slice(0, -1)) {
    const children = childrenOf(parent)
    if (!children?.[step]) return spec
    parent = children[step]
  }
  const children = childrenOf(parent)
  const last = path.steps[path.steps.length - 1]
  if (!children || last === undefined || !children[last]) return spec
  children.splice(last, 1)
  return next
}

function childrenOf(node: SpecNode): SpecNode[] | undefined {
  return 'and' in node
    ? node.and
    : 'all' in node
      ? node.all
      : 'any' in node
        ? node.any
        : undefined
}

/** The decimal a risk value resolves to, through `$param` if it is one. */
export function resolveValue(
  value: string,
  params: Record<string, string>,
): string {
  return isParam(value) ? (params[value.slice(1)] ?? value) : value
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
