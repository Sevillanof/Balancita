import { readFileSync } from 'node:fs'
import { FUTURES_PRODUCT } from './futures-market.ts'

/**
 * The pinned set of Kraken public `PF_*` perpetuals the lab captures,
 * forecasts and scores (ADR 0001, amendment 2026-10-06). The list lives in
 * `config/futures-products.json`, shared with the Python services, and is never
 * chosen at runtime, so a replay sees the same products and tick sizes.
 */
export interface FuturesProduct {
  readonly productId: string
  /** Decimal string from the instrument catalog (`instruments[].tickSize`). */
  readonly tickSize: string
}

const PRODUCT_ID = /^PF_[A-Z0-9]{2,20}$/
const DECIMAL = /^\d+(?:\.\d+)?$/
const MAX_PRODUCTS = 20
const PINNED_URL = new URL(
  '../../../../config/futures-products.json',
  import.meta.url,
)

export function loadPinnedProducts(): FuturesProduct[] {
  const body: unknown = JSON.parse(readFileSync(PINNED_URL, 'utf8'))
  const list = (body as { products?: unknown }).products
  if (!Array.isArray(list) || list.length === 0)
    throw new TypeError('Pinned futures products file has no products.')
  const products = list.map((item: Record<string, unknown>) =>
    product(String(item.product_id), String(item.tick_size)),
  )
  assertUnique(products)
  return products
}

/**
 * `FUTURES_PRODUCTS` (optional) is a comma-separated list of `PF_X` or
 * `PF_X:tickSize`. A pinned product may omit its tick size; any other product
 * must give one. PF_XBTUSD is required: it is the paper-execution product.
 */
export function resolveFuturesProducts(
  env: Readonly<Record<string, string | undefined>> = process.env,
): FuturesProduct[] {
  const pinned = loadPinnedProducts()
  const text = env.FUTURES_PRODUCTS?.trim()
  if (!text) return pinned
  const products = text.split(',').map((entry) => {
    const [id = '', tick, ...rest] = entry.trim().split(':')
    if (rest.length > 0)
      throw new TypeError(`Invalid futures product "${entry}".`)
    if (!PRODUCT_ID.test(id))
      throw new TypeError(`Invalid futures product "${entry}".`)
    const known = pinned.find((item) => item.productId === id)
    if (tick === undefined) {
      if (!known)
        throw new TypeError(`Product ${id} needs a tick size (${id}:0.01).`)
      return known
    }
    const given = product(id, tick)
    if (known && known.tickSize !== given.tickSize)
      throw new TypeError(
        `Tick size ${given.tickSize} of ${id} differs from the pinned ${known.tickSize}.`,
      )
    return given
  })
  assertUnique(products)
  if (products.length > MAX_PRODUCTS)
    throw new RangeError(
      `At most ${MAX_PRODUCTS} futures products are allowed.`,
    )
  if (!products.some((item) => item.productId === FUTURES_PRODUCT))
    throw new TypeError(`The product list must include ${FUTURES_PRODUCT}.`)
  return products
}

/**
 * Compares the pinned products with a fetched public instrument catalog.
 * Advisory only: capture logs these and keeps running on the pinned values.
 */
export function catalogProductWarnings(
  catalog: unknown,
  products: readonly FuturesProduct[],
): string[] {
  const list =
    typeof catalog === 'object' && catalog !== null
      ? (catalog as { instruments?: unknown }).instruments
      : undefined
  const bySymbol = new Map<string, Record<string, unknown>>()
  if (Array.isArray(list))
    for (const item of list)
      if (typeof item === 'object' && item !== null)
        bySymbol.set(String((item as { symbol?: unknown }).symbol), item)
  const warnings: string[] = []
  for (const { productId, tickSize } of products) {
    const row = bySymbol.get(productId)
    if (!row) {
      warnings.push(`${productId} is missing from the catalog`)
      continue
    }
    if (row.tradeable !== true)
      warnings.push(`${productId} is not tradeable in the catalog`)
    const live = plainDecimal(row.tickSize)
    if (live !== tickSize)
      warnings.push(
        `${productId} tick size ${live ?? 'unknown'} in the catalog differs from the pinned ${tickSize}`,
      )
  }
  return warnings
}

function product(productId: string, tickSize: string): FuturesProduct {
  if (!PRODUCT_ID.test(productId))
    throw new TypeError(`Invalid futures product "${productId}".`)
  const tick = plainDecimal(tickSize)
  if (tick === undefined || !(Number(tick) > 0))
    throw new TypeError(`Invalid tick size "${tickSize}" for ${productId}.`)
  return { productId, tickSize: tick }
}

function assertUnique(products: readonly FuturesProduct[]): void {
  if (new Set(products.map((item) => item.productId)).size !== products.length)
    throw new TypeError('Duplicate futures product in the list.')
}

/** Plain decimal text without exponent or trailing zeros (1e-05 -> 0.00001). */
function plainDecimal(value: unknown): string | undefined {
  let text: string
  if (typeof value === 'number' && Number.isFinite(value))
    text = value.toFixed(12)
  else if (typeof value === 'string' && DECIMAL.test(value.trim()))
    text = value.trim()
  else return undefined
  text = text.replace(/^0+(?=\d)/, '')
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '')
  return text
}
