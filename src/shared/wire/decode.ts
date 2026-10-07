/** Shared decoders for the JSON that backends send: unknown in, safe values out. */
export type JsonRecord = Record<string, unknown>

/** The value as a plain object, or `{}` for anything else (null, arrays, scalars). */
export function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {}
}
