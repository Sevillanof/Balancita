import { join } from 'node:path'

export function runtimeEvidencePath(repositoryRoot: string): string {
  return join(
    repositoryRoot,
    'playwright-artifacts/futures-baseline/connected-final-mock-evidence.json',
  )
}
