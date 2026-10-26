import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { exportDesignSystem, extractTokens } from './export-tokens.mjs'

test('exports literal tokens from static and inline themes, without wildcard resets', () => {
  assert.deepEqual(
    extractTokens(`
    @theme static { --color-*: initial; /* note */ --color-long: #10b981; }
    @theme inline { --font-sans: 'Inter',
      sans-serif; --radius-sm: 4px; }
  `),
    [
      { name: 'color-long', value: '#10b981', type: 'color' },
      { name: 'font-sans', value: "'Inter', sans-serif", type: 'font' },
      { name: 'radius-sm', value: '4px', type: 'radius' },
    ],
  )
})

test('fails visibly on empty, duplicate, malformed and unresolved tokens', () => {
  for (const css of [
    ':root { --color-long: green; }',
    '@theme { --a: 1; --a: 2; }',
    '@theme { broken; }',
    '@theme { --a: var(--b); }',
    '@theme { --a: calc(4px * 2); }',
  ])
    assert.throws(() => extractTokens(css))
})

test('generated catalog and JSON use the exact same source tokens', async () => {
  const output = await mkdtemp(join(tmpdir(), 'balancita-tokens-'))
  try {
    await exportDesignSystem(output)
    const css = await readFile(
      new URL('../../src/shared/design-system/theme.css', import.meta.url),
      'utf8',
    )
    const tokens = JSON.parse(
      await readFile(join(output, 'tokens.json'), 'utf8'),
    )
    assert.deepEqual(tokens, extractTokens(css))
    assert.equal(tokens.find((t) => t.name === 'spacing').value, '4px')
    assert.equal(tokens.find((t) => t.name === 'color-long').value, '#10b981')
    const html = await readFile(join(output, 'index.html'), 'utf8')
    assert.ok(!html.includes('/* TOKEN_DATA */'))
    assert.ok(html.includes(JSON.stringify(tokens)))
    const usage = JSON.parse(
      await readFile(join(output, 'tokens.usage.json'), 'utf8'),
    )
    assert.match(usage['color-ink-3'], /No usar como color de texto/)
  } finally {
    await rm(output, { recursive: true })
  }
})
