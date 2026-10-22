import type { StrategySpec } from './strategy-spec.ts'

const IDENTITY = new Set(['id', 'version', 'name', 'description'])

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null)
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/**
 * Whether two specs trade alike. Same rule as the registry's `rules_hash`: the id, the
 * version, the name and the description are not part of what a strategy does, so changing
 * only those is not a new version.
 */
export function sameRules(a: StrategySpec, b: StrategySpec): boolean {
  const strip = (spec: StrategySpec) =>
    Object.fromEntries(
      Object.entries(spec).filter(([key]) => !IDENTITY.has(key)),
    )
  return canonical(strip(a)) === canonical(strip(b))
}
