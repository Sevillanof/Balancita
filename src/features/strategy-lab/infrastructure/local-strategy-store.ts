import { validateSpec, type StrategySpec } from '../domain/strategy-spec.ts'

/**
 * Browser-only stand-in for the strategy registry S (PS-08b): every saved
 * version is appended, nothing is overwritten. It lives in this browser's
 * localStorage until S and its command channel exist.
 */
export const LAB_STORAGE_KEY = 'balancita.lab.versions.v1'

export type StoredVersion = {
  spec: StrategySpec
  savedAt: number
}

export function readVersions(
  storage: Storage | undefined = safeStorage(),
): StoredVersion[] {
  if (!storage) return []
  try {
    const value: unknown = JSON.parse(storage.getItem(LAB_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      const entry = item as Partial<StoredVersion>
      const { spec } = validateSpec(entry?.spec)
      return spec && Number.isFinite(entry.savedAt)
        ? [{ spec, savedAt: Number(entry.savedAt) }]
        : []
    })
  } catch {
    return []
  }
}

export function appendVersion(
  spec: StrategySpec,
  savedAt: number,
  storage: Storage | undefined = safeStorage(),
): StoredVersion[] {
  const versions = [...readVersions(storage), { spec, savedAt }]
  try {
    storage?.setItem(LAB_STORAGE_KEY, JSON.stringify(versions))
  } catch {
    // Saving is best effort; the version still applies for this session.
  }
  return versions
}

/** Newest version per strategy id. */
export function latestById(
  versions: readonly StoredVersion[],
): Map<string, StrategySpec> {
  const latest = new Map<string, StrategySpec>()
  for (const { spec } of versions) {
    const current = latest.get(spec.id)
    if (!current || spec.version >= current.version) latest.set(spec.id, spec)
  }
  return latest
}

function safeStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}
