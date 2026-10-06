import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// Accepted ADRs are immutable. To change one, the user must explicitly authorize
// an amendment; then update the pinned hash here in the same change.
const PINNED = {
  'docs/adr/0001-isolated-paper-futures-accounting.md':
    '1c5a69daced7f1e254c5812a9f38d5fe651ccf55022fb40d29fc652f35be44a1',
}

for (const [path, expected] of Object.entries(PINNED)) {
  test(`ADR is immutable: ${path}`, () => {
    const actual = createHash('sha256')
      .update(readFileSync(new URL(`../${path}`, import.meta.url)))
      .digest('hex')
    assert.equal(
      actual,
      expected,
      `${path} changed. ADRs are immutable; changes need an explicit user-authorized amendment, then update the pinned hash in scripts/adr-immutable.node-test.mjs.`,
    )
  })
}
