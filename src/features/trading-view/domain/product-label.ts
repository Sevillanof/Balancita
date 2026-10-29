const PRODUCT_NAMES: Record<string, string> = {
  ETH: 'Ethereum',
  BTC: 'Bitcoin',
  SOL: 'Solana',
  ZEC: 'Zcash',
  XRP: 'XRP',
  NEAR: 'NEAR',
  HYPE: 'Hyperliquid',
  ADA: 'Cardano',
}

/** Display names for a pinned Kraken Futures product (`PF_<BASE>USD`). */
export function productBase(product?: string): string {
  const base = (product ?? 'PF_XBTUSD').replace(/^PF_/, '').replace(/USD$/, '')
  return base === 'XBT' ? 'BTC' : base
}

export function productName(product?: string): string {
  const base = productBase(product ?? 'PF_ETHUSD')
  return PRODUCT_NAMES[base] ?? base
}

export function productPair(product?: string): string {
  return `${productBase(product)}/USD`
}
