import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  devEnvironment,
  serverEnvironment,
  serverNodeArgs,
} from './dev-provider-env.mjs'
import { serverLauncherArgs } from './server.mjs'

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

describe('serverLauncherArgs', () => {
  it('adds system CA support and watch only for dev', () => {
    assert.deepEqual(serverLauncherArgs('dev', new Set(['--use-system-ca'])), [
      '--use-system-ca',
      '--env-file-if-exists=.env',
      '--experimental-strip-types',
      '--watch',
      'src/app/index.ts',
    ])
    assert.deepEqual(
      serverLauncherArgs('start', new Set(['--use-system-ca'])),
      [
        '--use-system-ca',
        '--env-file-if-exists=.env',
        '--experimental-strip-types',
        'src/app/index.ts',
      ],
    )
  })

  it('omits the optional CA flag on unsupported Node versions', () => {
    assert.deepEqual(serverLauncherArgs('start', new Set()), [
      '--env-file-if-exists=.env',
      '--experimental-strip-types',
      'src/app/index.ts',
    ])
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
