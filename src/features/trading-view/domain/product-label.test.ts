import { describe, expect, it } from 'vitest'
import { productBase, productName, productPair } from './product-label.ts'

describe('product labels', () => {
  it('maps XBT to BTC and defaults to BTC', () => {
    expect(productPair()).toBe('BTC/USD')
    expect(productBase('PF_XBTUSD')).toBe('BTC')
    expect(productPair('PF_ETHUSD')).toBe('ETH/USD')
  })

  it('returns the full coin name with Ethereum as default', () => {
    expect(productName()).toBe('Ethereum')
    expect(productName('PF_ETHUSD')).toBe('Ethereum')
    expect(productName('PF_XBTUSD')).toBe('Bitcoin')
    expect(productName('PF_SOLUSD')).toBe('Solana')
  })
})
