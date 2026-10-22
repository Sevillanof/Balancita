import {
  conditionSentence,
  formatDecimal,
  type CmpNode,
  type Operand,
  type Rules,
  type SpecNode,
  type StrategySpec,
} from './strategy-spec.ts'

/**
 * What can be varied in a VectorBT exploration. The server accepts a `params`
 * name (`stop_atr`) or the path of a numeric constant of a condition
 * (`rules.checks[3].node.right`, see `describe_variation` in
 * `spec_variation.py`); there is no listing route, so the list is derived here
 * from the spec with the same rules.
 */
export type Variable = {
  /** The `vary` the server receives. */
  vary: string
  kind: 'param' | 'condition'
  /** Readable name for the picker. */
  label: string
  /** One line saying what it does. */
  hint: string
  /** The value the strategy has now, as the server writes it (`1.5`). */
  base: string
  /** Conditions of the engine only admit integers; parameters admit decimals. */
  integerOnly: boolean
}

const NUMBER = /^-?\d+(?:\.\d+)?$/
const INTEGER = /^-?\d+$/

const PARAM_TEXT: Record<string, { label: string; hint: string }> = {
  stop_atr: {
    label: 'Distancia del stop',
    hint: 'Cuántas veces el rango típico de la vela se deja correr una pérdida antes de cortar.',
  },
  target_stop_ratio: {
    label: 'Objetivo frente al stop',
    hint: 'Cuántas veces la distancia del stop se espera ganar antes de cerrar.',
  },
  volume_multiplier: {
    label: 'Volumen mínimo',
    hint: 'Cuántas veces el volumen normal tiene que moverse para entrar.',
  },
  z_min: {
    label: 'Fuerza mínima del movimiento',
    hint: 'Cuánto tiene que moverse el precio, frente a lo habitual, para entrar.',
  },
  rsi_long_min: {
    label: 'RSI mínimo para comprar',
    hint: 'Piso del RSI al comprar.',
  },
  rsi_long_max: {
    label: 'RSI máximo para comprar',
    hint: 'Techo del RSI al comprar.',
  },
  rsi_short_min: {
    label: 'RSI mínimo para vender en corto',
    hint: 'Piso del RSI al vender en corto.',
  },
  rsi_short_max: {
    label: 'RSI máximo para vender en corto',
    hint: 'Techo del RSI al vender en corto.',
  },
  rsi_oversold: {
    label: 'RSI de sobreventa',
    hint: 'Por debajo de este nivel se considera que el precio cayó de más.',
  },
  rsi_overbought: {
    label: 'RSI de sobrecompra',
    hint: 'Por encima de este nivel se considera que el precio subió de más.',
  },
  pct_high: {
    label: 'Nivel alto del funding',
    hint: 'Desde qué posición (de 0 a 100) el funding se considera alto.',
  },
  pct_low: {
    label: 'Nivel bajo del funding',
    hint: 'Hasta qué posición (de 0 a 100) el funding se considera bajo.',
  },
}

/** Constants that are not a decision of the strategy (a derived factor). */
const INTERNAL_PARAMS = new Set(['sqrt_bars'])

const GROUP_LABEL: Record<string, string> = {
  trend: 'Tendencia',
  range: 'Rango',
}

const humanize = (name: string) => {
  const text = name.replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function constantsOf(
  operand: Operand,
  path: string,
  out: Array<{ path: string; value: string }>,
) {
  if (typeof operand === 'string') {
    if (NUMBER.test(operand)) out.push({ path, value: operand })
    return
  }
  operand.mul.forEach((factor, index) => {
    // ±1 in a product is a sign flip or an identity, not a threshold.
    if (typeof factor === 'string' && (factor === '1' || factor === '-1'))
      return
    constantsOf(factor, `${path}.mul[${index}]`, out)
  })
}

function walk(
  node: SpecNode,
  path: string,
  params: Record<string, string>,
  found: Array<{ path: string; value: string; node: CmpNode }>,
) {
  if ('cmp' in node) {
    const here: Array<{ path: string; value: string }> = []
    constantsOf(node.left, `${path}.left`, here)
    constantsOf(node.right, `${path}.right`, here)
    here.forEach((item) => found.push({ ...item, node }))
    return
  }
  if ('not' in node) {
    walk(node.not, `${path}.not`, params, found)
    return
  }
  for (const key of ['all', 'any', 'and'] as const) {
    const children = (node as Record<string, unknown>)[key]
    if (Array.isArray(children))
      (children as SpecNode[]).forEach((child, index) =>
        walk(child, `${path}.${key}[${index}]`, params, found),
      )
  }
}

function conditionsOf(
  rules: Rules | undefined,
  prefix: string,
  group: string | null,
  params: Record<string, string>,
): Variable[] {
  if (!rules) return []
  const out: Variable[] = []
  rules.checks.forEach((check, index) => {
    const found: Array<{ path: string; value: string; node: CmpNode }> = []
    walk(check.node, `${prefix}.checks[${index}].node`, params, found)
    for (const item of found) {
      const sentence = conditionSentence(item.node, params)
      out.push({
        vary: item.path,
        kind: 'condition',
        label: `${group ? `${group} · ` : ''}Número ${formatDecimal(item.value)} de la condición «${sentence}»`,
        hint: 'Un número escrito dentro de una condición de entrada.',
        base: item.value.replace(/^(-?\d+)\.0+$/, '$1'),
        integerOnly: true,
      })
    }
  })
  return out
}

/** Parameters first, then the numbers inside entry conditions, in the order the spec writes them. */
export function listVariables(spec: StrategySpec): Variable[] {
  const params = spec.params ?? {}
  const out: Variable[] = []
  for (const [name, value] of Object.entries(params)) {
    if (INTERNAL_PARAMS.has(name) || !NUMBER.test(String(value))) continue
    const text = PARAM_TEXT[name]
    out.push({
      vary: name,
      kind: 'param',
      label: text?.label ?? humanize(name),
      hint: text?.hint ?? 'Un número de la estrategia.',
      base: String(value),
      integerOnly: false,
    })
  }
  if (spec.kind === 'regime_adapter') {
    for (const regime of ['trend', 'range'] as const)
      out.push(
        ...conditionsOf(
          spec.branches?.[regime]?.rules,
          `branches.${regime}.rules`,
          GROUP_LABEL[regime] ?? regime,
          params,
        ),
      )
  } else {
    out.push(...conditionsOf(spec.rules, 'rules', null, params))
  }
  return out
}

export const isIntegerText = (value: string) => INTEGER.test(value)
