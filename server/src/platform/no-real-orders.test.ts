import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Issue #184, PR 5a (docs/etapa-10e-camino-paper-datos-reales.md, 3.2): the server has no way to send a real order.
// Whoever talks to Kraken here (the capture and the gateway) uses public data only: no private route, no signature
// header, no credential variable, and every Kraken URL is on the public list below.

const here = dirname(fileURLToPath(import.meta.url))
const serverSrc = join(here, '..')
const frontendSrc = join(here, '..', '..', '..', 'src')

function sources(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name)
    if (statSync(path).isDirectory())
      return name === 'fixtures' ? [] : sources(path)
    return /\.(ts|tsx|mjs)$/.test(name) && !/\.(test|pw)\.(ts|tsx)$/.test(name)
      ? [path]
      : []
  })
}

const PUBLIC_REST = [
  'https://futures.kraken.com/derivatives/api/v3/instruments',
  'https://futures.kraken.com/derivatives/api/v3/historical-funding-rates',
  'https://futures.kraken.com/derivatives/api/v3/tickers',
  'https://futures.kraken.com/api/charts/v1/trade',
  'https://futures.kraken.com/api/charts/v1/analytics',
]
const PUBLIC_WS = ['wss://futures.kraken.com/ws/v1']
const FORBIDDEN =
  /sendorder|editorder|cancelorder|batchorder|\/accounts|\/openpositions|\bAPIKey\b|\bAuthent\b|KRAKEN_API|API_SECRET|apisecret/i

describe('no real orders (server)', () => {
  const files = [...sources(serverSrc), ...sources(frontendSrc)]

  it('inventories the sources it is supposed to read', () => {
    expect(files.length).toBeGreaterThan(50)
    expect(files.some((file) => file.endsWith('official-candles.ts'))).toBe(
      true,
    )
  })

  it('names no private route, signature header or credential variable', () => {
    const offenders = files
      .filter((file) => FORBIDDEN.test(readFileSync(file, 'utf8')))
      .map((file) => relative(join(here, '..', '..', '..'), file))
    expect(offenders).toEqual([])
  })

  it('talks to Kraken only through the public list', () => {
    const found = new Set<string>()
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const match of text.matchAll(
        /(?:https?|wss?):\/\/[^\s'"`)]*kraken\.com[^\s'"`)]*/g,
      ))
        found.add(match[0])
    }
    expect(found.size).toBeGreaterThan(0)
    const allowed = [...PUBLIC_REST, ...PUBLIC_WS]
    const outside = [...found].filter(
      (url) =>
        !allowed.some(
          (prefix) =>
            url === prefix ||
            url.startsWith(prefix + '/') ||
            url.startsWith(prefix + '?'),
        ),
    )
    expect(outside).toEqual([])
  })

  it('has no HTTP route that writes, and the gateway answers a paper command with an error only', () => {
    // by verb, whatever the variable is called: a route (.post('/x')) or a request (method: 'POST')
    const verbs = [
      /(?<!searchParams)\.(?:post|put|patch|delete)\(\s*['"`/]/,
      /method:\s*['"](?:POST|PUT|PATCH|DELETE)/i,
    ]
    // the only writes there are, both to the local strategies API and neither an order: the carry on/off switch
    // (a flag) and the strategy gate client (start/cancel a backtest run, which touches no market)
    const writers = files.filter((file) => {
      const text = readFileSync(file, 'utf8')
      return verbs.some((verb) => verb.test(text))
    })
    expect(writers.map((file) => relative(frontendSrc, file)).sort()).toEqual([
      join('features', 'strategy-lab', 'infrastructure', 'carry-api.ts'),
      join('features', 'strategy-lab', 'infrastructure', 'gate-api.ts'),
    ])
    for (const writer of writers)
      expect(readFileSync(writer, 'utf8')).not.toMatch(/kraken/i)
    const gateway = readFileSync(
      join(serverSrc, 'features', 'live-gateway', 'gateway.ts'),
      'utf8',
    )
    const at = gateway.indexOf("message.type === 'paper.command'")
    expect(at).toBeGreaterThan(0)
    expect(gateway.slice(at, at + 160)).toMatch(
      /control\(view, session, 'protocol\.error'/,
    )
  })
})
