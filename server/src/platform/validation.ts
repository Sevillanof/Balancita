export interface ValidationIssue {
  readonly code: string
  readonly path: string
  readonly message: string
}

export interface ValidationSuccess<T> {
  readonly valid: true
  readonly value: T
}

export interface ValidationFailure {
  readonly valid: false
  readonly issues: readonly ValidationIssue[]
}

export type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure

export function valid<T>(value: T): ValidationSuccess<T> {
  return { valid: true, value }
}

export function invalid(issues: readonly ValidationIssue[]): ValidationFailure {
  return { valid: false, issues }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function issue(
  code: string,
  path: string,
  message: string,
): ValidationIssue {
  return { code, path, message }
}

export function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function finiteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
