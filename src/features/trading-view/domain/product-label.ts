/** Display names for a pinned Kraken Futures product (`PF_<BASE>USD`). */
export function productBase(product?: string): string {
  const base = (product ?? 'PF_XBTUSD').replace(/^PF_/, '').replace(/USD$/, '')
  return base === 'XBT' ? 'BTC' : base
}

export function productPair(product?: string): string {
  return `${productBase(product)}/USD`
}
