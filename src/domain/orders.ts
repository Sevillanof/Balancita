import {
  MONEY_SCALE,
  moneyAdd,
  moneyAbs,
  moneyDiv,
  moneyFromNumber,
  moneyIsZero,
  moneyLte,
  moneyMul,
  moneyGte,
  moneyIsNegative,
  moneySub,
  type Money,
} from './money'
import type { InstrumentCurrency } from './market-data'

export const BUY = 'buy' as const
export const SELL = 'sell' as const
export type OrderSide = typeof BUY | typeof SELL

export type InstrumentId = string

export interface OrderIntent {
  instrumentId: InstrumentId
  side: OrderSide
  quantity: Money
  idempotencyKey: string
}

export interface ConfirmedOrder {
  previewReference: string
  idempotencyKey: string
}

export type OrderOutcome = 'executed' | 'rejected'

/**
 * Configurable paper-trading fee scenario. `percentage` is a decimal rate:
 * 0.001 means 0.1%. It is Money so fee arithmetic never uses floats.
 */
export type FeePolicy = {
  id: string
  label: string
  percentage: Money
  minimum: Money
  currency: InstrumentCurrency
}

/** Development default: no fee. This is not a real broker or exchange tariff. */
export const ZERO_FEE_POLICY: FeePolicy = {
  id: 'development-zero',
  label: 'Desarrollo: comisión cero (no real)',
  percentage: moneyFromNumber(0),
  minimum: moneyFromNumber(0),
  currency: 'EUR',
}

export interface OrderReceipt {
  id: string
  instrumentId: InstrumentId
  side: OrderSide
  quantity: Money
  executedPrice: Money
  slippedPrice?: Money
  commission: Money
  total: Money
  status: OrderOutcome
  reason?: string
  executedAt: number
  idempotencyKey: string
}

export interface OrderPreview {
  reference: string
  instrumentId: InstrumentId
  side: OrderSide
  quantity: Money
  marketPrice: Money
  slippageApplied: Money
  slippedPrice: Money
  commission: Money
  subtotal: Money
  estimatedTotal: Money
  currency: string
  feePolicy?: FeePolicy
}

export interface OrderExecutionProvider {
  preview(order: OrderIntent): Promise<OrderPreview>
  submit(order: ConfirmedOrder): Promise<OrderReceipt>
}

export interface OrderSimulatorConfig {
  slippage: number
  commission: number
  previewTolerance: number
  initialCash: Record<string, number>
  feePolicy?: FeePolicy
}

export const DEFAULT_ORDER_SIMULATOR_CONFIG: OrderSimulatorConfig = {
  slippage: 0,
  commission: 0,
  previewTolerance: 0.005,
  initialCash: { EUR: 10_000, USD: 10_000 },
}

export interface PriceProjection {
  slippedPrice: Money
  slippageApplied: Money
  commission: Money
  subtotal: Money
  estimatedTotal: Money
}

export interface PositionProjection {
  quantity: Money
  averageCost: Money
}

export class IdempotencyConflictError extends Error {
  readonly previewReference?: string

  constructor(message: string, previewReference?: string) {
    super(message)
    this.name = 'IdempotencyConflictError'
    this.previewReference = previewReference
  }
}

export class MissingOrUnknownPreviewError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingOrUnknownPreviewError'
  }
}

export class PreviewOutdatedError extends Error {
  readonly reference: string

  constructor(message: string, reference: string) {
    super(message)
    this.name = 'PreviewOutdatedError'
    this.reference = reference
  }
}

export class SimulatorCorruptStateError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'SimulatorCorruptStateError'
  }
}

export class UnknownInstrumentError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownInstrumentError'
  }
}

export class UnavailablePriceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnavailablePriceError'
  }
}

export function estimatePreview(
  side: OrderSide,
  quantity: Money,
  marketPrice: Money,
  slippage: Money,
  commission: Money,
): PriceProjection {
  const slippageApplied = slippage
  const slippedPrice =
    side === BUY
      ? moneyMul(marketPrice, moneyAdd(moneyFromNumber(1), slippage))
      : moneyMul(marketPrice, moneySub(moneyFromNumber(1), slippage))
  const subtotal = moneyMul(quantity, slippedPrice)
  const estimatedTotal =
    side === BUY
      ? moneyAdd(subtotal, commission)
      : moneySub(subtotal, commission)
  return { slippedPrice, slippageApplied, commission, subtotal, estimatedTotal }
}

export function calculateCommission(
  subtotal: Money,
  policy: FeePolicy,
  currency: string,
): Money {
  if (policy.currency !== currency) {
    throw new Error('Fee policy currency does not match the order currency')
  }
  if (moneyIsNegative(policy.percentage) || moneyIsNegative(policy.minimum)) {
    throw new Error('Fee policy values cannot be negative')
  }
  const percentageFee = moneyMul(subtotal, policy.percentage)
  return moneyGte(percentageFee, policy.minimum)
    ? percentageFee
    : policy.minimum
}

export function averageCostAfterBuy(
  current: { quantity: Money; averageCost: Money } | null,
  buyQuantity: Money,
  outlay: Money,
): PositionProjection {
  if (current === null) {
    return { quantity: buyQuantity, averageCost: moneyDiv(outlay, buyQuantity) }
  }
  const quantity = moneyAdd(current.quantity, buyQuantity)
  const totalCost = moneyAdd(
    moneyMul(current.quantity, current.averageCost),
    outlay,
  )
  return { quantity, averageCost: moneyDiv(totalCost, quantity) }
}

export function driftWithinTolerance(
  previewPrice: Money,
  currentPrice: Money,
  tolerance: Money,
): boolean {
  if (moneyIsZero(previewPrice) || moneyIsZero(tolerance)) {
    return true
  }
  const spanUnits = moneyAbs(moneySub(currentPrice, previewPrice)).units
  const scaled = (spanUnits * 10n ** BigInt(MONEY_SCALE)) / previewPrice.units
  const drift = { units: scaled }
  return moneyLte(drift, tolerance)
}

export function orderSimulatorConfigFrom(
  partial?: Partial<OrderSimulatorConfig>,
): OrderSimulatorConfig {
  const config: OrderSimulatorConfig = {
    slippage: partial?.slippage ?? DEFAULT_ORDER_SIMULATOR_CONFIG.slippage,
    commission:
      partial?.commission ?? DEFAULT_ORDER_SIMULATOR_CONFIG.commission,
    previewTolerance:
      partial?.previewTolerance ??
      DEFAULT_ORDER_SIMULATOR_CONFIG.previewTolerance,
    initialCash: partial?.initialCash
      ? {
          ...DEFAULT_ORDER_SIMULATOR_CONFIG.initialCash,
          ...partial.initialCash,
        }
      : DEFAULT_ORDER_SIMULATOR_CONFIG.initialCash,
  }
  if (partial?.feePolicy !== undefined) config.feePolicy = partial.feePolicy
  return config
}
