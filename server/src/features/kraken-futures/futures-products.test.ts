import { describe, expect, it } from 'vitest'
import {
  catalogProductWarnings,
  loadPinnedProducts,
  resolveFuturesProducts,
} from './futures-products.ts'

describe('pinned Kraken futures products', () => {
  it('pins 8 PF_ perpetuals with PF_XBTUSD first and PF_ETHUSD included', () => {
    const products = loadPinnedProducts()
    expect(products).toHaveLength(8)
    expect(products[0]).toEqual({ productId: 'PF_XBTUSD', tickSize: '1' })
    expect(products.map((product) => product.productId)).toContain('PF_ETHUSD')
    expect(new Set(products.map((product) => product.productId)).size).toBe(8)
    for (const product of products) {
      expect(product.productId).toMatch(/^PF_[A-Z0-9]+$/)
      expect(product.tickSize).toMatch(/^\d+(?:\.\d+)?$/)
      expect(Number(product.tickSize)).toBeGreaterThan(0)
    }
    expect(
      products.find((product) => product.productId === 'PF_ADAUSD')?.tickSize,
    ).toBe('0.00001')
  })

  it('uses the pinned list by default and never queries anything', () => {
    expect(resolveFuturesProducts({})).toEqual(loadPinnedProducts())
    expect(resolveFuturesProducts({ FUTURES_PRODUCTS: '  ' })).toEqual(
      loadPinnedProducts(),
    )
  })

  it('selects a subset from the pinned list with the pinned tick sizes', () => {
    expect(
      resolveFuturesProducts({ FUTURES_PRODUCTS: 'PF_XBTUSD, PF_SOLUSD' }),
    ).toEqual([
      { productId: 'PF_XBTUSD', tickSize: '1' },
      { productId: 'PF_SOLUSD', tickSize: '0.01' },
    ])
  })

  it('takes an explicit tick size for a product outside the pinned list', () => {
    expect(
      resolveFuturesProducts({
        FUTURES_PRODUCTS: 'PF_XBTUSD,PF_LINKUSD:0.0010',
      }),
    ).toEqual([
      { productId: 'PF_XBTUSD', tickSize: '1' },
      { productId: 'PF_LINKUSD', tickSize: '0.001' },
    ])
  })

  it('rejects unusable lists', () => {
    const bad = (value: string, message: RegExp) =>
      expect(() => resolveFuturesProducts({ FUTURES_PRODUCTS: value })).toThrow(
        message,
      )
    bad('PF_ETHUSD', /PF_XBTUSD/)
    bad('PF_XBTUSD,PF_XBTUSD', /duplicate/i)
    bad('PF_XBTUSD,PF_LINKUSD', /tick size/i)
    bad('PF_XBTUSD,pf_ethusd', /invalid/i)
    bad('PF_XBTUSD,FI_XBTUSD_261225:1', /invalid/i)
    bad('PF_XBTUSD,PF_LINKUSD:0', /tick size/i)
    bad('PF_XBTUSD,PF_ETHUSD:0.5', /pinned/i)
  })

  it('warns when the live catalog disagrees with the pinned values', () => {
    const catalog = {
      instruments: [
        { symbol: 'PF_XBTUSD', tickSize: 1, tradeable: true },
        { symbol: 'PF_ETHUSD', tickSize: 0.05, tradeable: true },
        { symbol: 'PF_SOLUSD', tickSize: 0.01, tradeable: false },
      ],
    }
    const warnings = catalogProductWarnings(catalog, [
      { productId: 'PF_XBTUSD', tickSize: '1' },
      { productId: 'PF_ETHUSD', tickSize: '0.1' },
      { productId: 'PF_SOLUSD', tickSize: '0.01' },
      { productId: 'PF_ZECUSD', tickSize: '0.01' },
    ])
    expect(warnings).toEqual([
      'PF_ETHUSD tick size 0.05 in the catalog differs from the pinned 0.1',
      'PF_SOLUSD is not tradeable in the catalog',
      'PF_ZECUSD is missing from the catalog',
    ])
  })
})
