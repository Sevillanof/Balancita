import { describe, expect, it } from 'vitest'
import { productBase, productPair } from './product-label.ts'

describe('product labels', () => {
  it('maps XBT to BTC and defaults to BTC', () => {
    expect(productPair()).toBe('BTC/USD')
    expect(productBase('PF_XBTUSD')).toBe('BTC')
    expect(productPair('PF_ETHUSD')).toBe('ETH/USD')
  })
})
