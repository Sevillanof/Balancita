import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  devEnvironment,
  onlyChildSpecs,
  serverEnvironment,
  serverNodeArgs,
} from './dev-provider-env.mjs'

describe('devEnvironment', () => {
  it('defaults only the root development environment to Kraken', () => {
    assert.equal(devEnvironment({}).VITE_MARKET_DATA_PROVIDER, 'kraken')
  })

  it('preserves an explicit mock override and all other environment values', () => {
    assert.deepEqual(
      devEnvironment({ VITE_MARKET_DATA_PROVIDER: 'mock', OTHER: 'value' }),
      { VITE_MARKET_DATA_PROVIDER: 'mock', OTHER: 'value' },
    )
  })
})

describe('serverNodeArgs', () => {
  const serverArgs = [
    '--env-file-if-exists=.env',
    '--experimental-strip-types',
    '--watch',
    'src/app/index.ts',
  ]

  it('enables the system CA store when Node supports the flag', () => {
    assert.deepEqual(serverNodeArgs(serverArgs, new Set(['--use-system-ca'])), [
      '--use-system-ca',
      ...serverArgs,
    ])
  })

  it('does not pass the system CA flag when Node does not support it', () => {
    assert.deepEqual(serverNodeArgs(serverArgs, new Set()), serverArgs)
  })
})

describe('serverEnvironment', () => {
  it('sets the root development marker only for the server environment', () => {
    assert.deepEqual(serverEnvironment({ MARKET_COLLECTOR_ENABLED: 'false' }), {
      MARKET_COLLECTOR_ENABLED: 'false',
      BALANCITA_ROOT_DEV_SERVER: 'true',
    })
  })
})

describe('onlyChildSpecs', () => {
  const specs = [
    { name: 'vite' },
    { name: 'capture' },
    { name: 'paper' },
    { name: 'llm' },
    { name: 'q' },
    { name: 'verdict' },
    { name: 'qwenexit' },
  ]

  it('keeps everything when DEV_ONLY is unset or empty', () => {
    assert.deepEqual(onlyChildSpecs(specs, {}), specs)
    assert.deepEqual(onlyChildSpecs(specs, { DEV_ONLY: ' , ' }), specs)
  })

  it('keeps only the named children and Qwen, and ignores unknown names', () => {
    assert.deepEqual(
      onlyChildSpecs(specs, { DEV_ONLY: 'vite, capture,nope' }).map(
        (s) => s.name,
      ),
      ['vite', 'capture', 'llm', 'q', 'verdict', 'qwenexit'],
    )
  })
})
