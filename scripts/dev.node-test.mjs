import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { devChildSpecs, devProxyConfig } from './dev-provider-env.mjs'

const root = '/repo'
const noFlags = new Set()

describe('devChildSpecs', () => {
  const specs = devChildSpecs({
    root,
    env: { FUTURES_MODE: 'paper_live', PORT: '9999', KEEP: 'yes' },
    allowedFlags: noFlags,
  })
  const byName = Object.fromEntries(specs.map((spec) => [spec.name, spec]))

  it('starts vite, legacy server, mock API, live capture, live gateway and verdict service', () => {
    assert.deepEqual(
      specs.map((spec) => spec.name),
      ['vite', 'server', 'mock', 'capture', 'live', 'verdict'],
    )
  })

  it('keeps the legacy server legacy even if the environment sets FUTURES_MODE', () => {
    assert.equal(byName.server.env.FUTURES_MODE, '')
    assert.equal(byName.server.env.PORT, '8787')
    assert.equal(byName.server.env.BALANCITA_ROOT_DEV_SERVER, 'true')
    assert.equal(byName.server.env.KEEP, 'yes')
    assert.equal(byName.server.cwd, '/repo/server')
  })

  it('runs the scripted MOCK terminal API only on 8788', () => {
    assert.deepEqual(byName.mock.args, [
      '/repo/scripts/futures-local-terminal.mjs',
      '--api-only',
      '--api-port',
      '8788',
    ])
    assert.equal(byName.mock.cwd, root)
  })

  it('runs capture as the only writer of the live market database, without HTTP or engine', () => {
    const { env, args, cwd } = byName.capture
    assert.equal(cwd, '/repo/server')
    assert.ok(args.includes('src/app/capture-main.ts'))
    assert.ok(!args.includes('--watch'))
    assert.equal(
      env.FUTURES_MARKET_DB_PATH,
      './data/dev-live/futures-market.sqlite',
    )
    assert.equal(env.FUTURES_MODE, '')
    assert.equal(env.FUTURES_DB_PATH, undefined)
  })

  it('runs the read-only live gateway on 8789 over the same market database', () => {
    const { env, args, cwd } = byName.live
    assert.equal(cwd, '/repo/server')
    assert.ok(args.includes('src/app/gateway-main.ts'))
    assert.ok(!args.includes('src/app/index.ts'))
    assert.equal(env.PORT, '8789')
    assert.equal(env.FUTURES_MODE, '')
    assert.equal(
      env.FUTURES_MARKET_DB_PATH,
      byName.capture.env.FUTURES_MARKET_DB_PATH,
    )
    assert.equal(env.FUTURES_DB_PATH, undefined)
  })

  it('runs the Python verdict service over the capture market database', () => {
    const { command, args, cwd, env } = byName.verdict
    assert.equal(command, 'python3')
    assert.equal(cwd, '/repo/server')
    assert.deepEqual(args, [
      '-m',
      'balancita_engine.futures_verdicts',
      '--market-db',
      byName.capture.env.FUTURES_MARKET_DB_PATH,
      '--verdicts-db',
      './data/dev-live/futures-verdicts.sqlite',
    ])
    assert.equal(env.PYTHONPATH, '/repo/python')
    assert.equal(env.KEEP, 'yes')
  })

  it('keeps the single-process paper_live rollback behind DEV_LIVE_SINGLE_PROCESS', () => {
    const rollback = devChildSpecs({
      root,
      env: { DEV_LIVE_SINGLE_PROCESS: '1' },
      allowedFlags: noFlags,
    })
    assert.deepEqual(
      rollback.map((spec) => spec.name),
      ['vite', 'server', 'mock', 'live'],
    )
    const { env, args } = rollback.find((spec) => spec.name === 'live')
    assert.equal(env.FUTURES_MODE, 'paper_live')
    assert.equal(env.PORT, '8789')
    assert.ok(args.includes('src/app/index.ts'))
    assert.equal(
      rollback.find((spec) => spec.name === 'verdict'),
      undefined,
    )
    const paths = [
      env.FUTURES_DB_PATH,
      env.FUTURES_MARKET_DB_PATH,
      env.MARKET_DB_PATH,
      env.SIMULATIONS_REPORT_PATH,
    ]
    for (const path of paths) assert.match(path, /^\.\/data\/dev-live\//)
    assert.equal(new Set(paths).size, paths.length)
  })

  it('keeps vite on the default provider environment', () => {
    assert.equal(byName.vite.env.VITE_MARKET_DATA_PROVIDER, 'kraken')
  })
})

describe('devProxyConfig', () => {
  const proxy = devProxyConfig()

  it('keeps /api on the legacy server and proxies websockets', () => {
    assert.equal(proxy['/api'].target, 'http://127.0.0.1:8787')
    assert.equal(proxy['/api'].ws, true)
    assert.equal(proxy['/api'].rewrite, undefined)
  })

  it('routes /api-mock and /api-live to their backends with /api rewrite', () => {
    for (const [prefix, port] of [
      ['/api-mock', 8788],
      ['/api-live', 8789],
    ]) {
      assert.equal(proxy[prefix].target, `http://127.0.0.1:${port}`)
      assert.equal(proxy[prefix].ws, true)
      assert.equal(
        proxy[prefix].rewrite(`${prefix}/terminal/bootstrap?x=1`),
        '/api/terminal/bootstrap?x=1',
      )
    }
  })

  it('does not let /api swallow the prefixed routes', () => {
    const keys = Object.keys(proxy)
    assert.ok(keys.indexOf('/api-mock') < keys.indexOf('/api'))
    assert.ok(keys.indexOf('/api-live') < keys.indexOf('/api'))
    assert.ok(
      proxy['/api'] &&
        Object.keys(proxy).every((key) => key.startsWith('/api')),
    )
  })
})
