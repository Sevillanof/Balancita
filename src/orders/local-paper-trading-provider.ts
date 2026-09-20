import type { Instrument, Quote } from '../domain/market-data'
import {
  moneyAdd,
  moneyFromNumber,
  moneyFromString,
  moneyIsPositive,
  moneyIsZero,
  moneyLt,
  moneySub,
  moneyToDecimalString,
  type Money,
} from '../domain/money'
import type { Holding, PortfolioRepository } from '../domain/portfolio'
import { LocalStoragePortfolioRepository } from '../portfolio/local-storage-portfolio-repository'
import {
  BUY,
  MissingOrUnknownPreviewError,
  UnknownInstrumentError,
  UnavailablePriceError,
  IdempotencyConflictError,
  PreviewOutdatedError,
  SimulatorCorruptStateError,
  SELL,
  averageCostAfterBuy,
  calculateCommission,
  driftWithinTolerance,
  estimatePreview,
  orderSimulatorConfigFrom,
  type ConfirmedOrder,
  type FeePolicy,
  type OrderExecutionProvider,
  type OrderIntent,
  type OrderPreview,
  type OrderReceipt,
  type OrderSide,
  type OrderSimulatorConfig,
  ZERO_FEE_POLICY,
} from '../domain/orders'

const SIMULATOR_STORAGE_KEY = 'balancita:simulator'
const SIMULATOR_SCHEMA_VERSION = 2

/**
 * Live market surface the simulator reads on demand. Quoted prices stay
 * `number`; they are converted to fixed-point Money exactly at this frontier.
 */
export interface PaperTradingMarketSource {
  getInstrument(instrumentId: string): Promise<Instrument | null>
  getPrice(instrumentId: string): Promise<Quote | null>
}

export interface PaperTradingAccount {
  cash: Record<string, Money>
  history: OrderReceipt[]
  movements?: CashMovement[]
}

export type CashMovementType = 'deposit' | 'withdrawal'

export type CashMovement = {
  id: string
  type: CashMovementType
  currency: string
  amount: Money
  timestamp: number
  note?: string
  balance: Money
  idempotencyKey?: string
}

export type CashMovementOptions = {
  note?: string
  idempotencyKey?: string
  timestamp?: number
}

export class InvalidVirtualCashMovementError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidVirtualCashMovementError'
  }
}

export class InsufficientVirtualCashError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InsufficientVirtualCashError'
  }
}

export class CashMovementIdempotencyConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CashMovementIdempotencyConflictError'
  }
}

type StoredReceipt = {
  id: string
  instrumentId: string
  side: OrderSide
  quantity: string
  executedPrice: string
  slippedPrice?: string
  commission: string
  total: string
  status: 'executed' | 'rejected'
  reason?: string
  executedAt: number
  idempotencyKey: string
}

type SimulatorStateV1 = {
  version: 1
  cash: Record<string, string>
  nextPreviewNumber: number
  nextReceiptNumber: number
  usedKeys: Record<string, { previewReference: string; receiptId?: string }>
  consumedPreviews: string[]
  history: StoredReceipt[]
}

type StoredMovement = {
  id: string
  type: CashMovementType
  currency: string
  amount: string
  timestamp: number
  note?: string
  balance: string
  idempotencyKey?: string
}

type SimulatorStateV2 = {
  version: 2
  cash: Record<string, string>
  nextPreviewNumber: number
  nextReceiptNumber: number
  nextMovementNumber: number
  usedKeys: Record<string, { previewReference: string; receiptId?: string }>
  consumedPreviews: string[]
  history: StoredReceipt[]
  movements: StoredMovement[]
  movementKeys: Record<string, string>
}

function isDecimalString(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    moneyFromString(value)
    return true
  } catch {
    return false
  }
}

function isOrderSide(value: unknown): value is OrderSide {
  return value === BUY || value === SELL
}

function isStoredReceipt(value: unknown): value is StoredReceipt {
  if (typeof value !== 'object' || value === null) return false
  const receipt = value as Record<string, unknown>
  return (
    typeof receipt.id === 'string' &&
    typeof receipt.instrumentId === 'string' &&
    isOrderSide(receipt.side) &&
    isDecimalString(receipt.quantity) &&
    isDecimalString(receipt.executedPrice) &&
    (receipt.slippedPrice === undefined ||
      (typeof receipt.slippedPrice === 'string' &&
        typeof receipt.commission === 'string')) &&
    isDecimalString(receipt.commission) &&
    isDecimalString(receipt.total) &&
    (receipt.status === 'executed' || receipt.status === 'rejected') &&
    (receipt.reason === undefined || typeof receipt.reason === 'string') &&
    typeof receipt.executedAt === 'number' &&
    typeof receipt.idempotencyKey === 'string'
  )
}

function isCashMovementType(value: unknown): value is CashMovementType {
  return value === 'deposit' || value === 'withdrawal'
}

function isStoredMovement(value: unknown): value is StoredMovement {
  if (typeof value !== 'object' || value === null) return false
  const movement = value as Record<string, unknown>
  return (
    typeof movement.id === 'string' &&
    isCashMovementType(movement.type) &&
    typeof movement.currency === 'string' &&
    isDecimalString(movement.amount) &&
    moneyIsPositive(moneyFromString(movement.amount)) &&
    typeof movement.timestamp === 'number' &&
    Number.isFinite(movement.timestamp) &&
    (movement.note === undefined || typeof movement.note === 'string') &&
    isDecimalString(movement.balance) &&
    (movement.idempotencyKey === undefined ||
      typeof movement.idempotencyKey === 'string')
  )
}

function isUsedKeys(value: unknown): value is SimulatorStateV1['usedKeys'] {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every(
      (binding) =>
        typeof binding === 'object' &&
        binding !== null &&
        typeof (binding as Record<string, unknown>).previewReference ===
          'string' &&
        ((binding as Record<string, unknown>).receiptId === undefined ||
          typeof (binding as Record<string, unknown>).receiptId === 'string'),
    )
  )
}

function isSimulatorStateV1(value: unknown): value is SimulatorStateV1 {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  if (state.version !== 1) return false
  if (
    typeof state.nextPreviewNumber !== 'number' ||
    !Number.isInteger(state.nextPreviewNumber) ||
    state.nextPreviewNumber < 0
  ) {
    return false
  }
  if (
    typeof state.nextReceiptNumber !== 'number' ||
    !Number.isInteger(state.nextReceiptNumber) ||
    state.nextReceiptNumber < 0
  ) {
    return false
  }
  if (
    typeof state.cash !== 'object' ||
    state.cash === null ||
    !Object.values(state.cash).every(isDecimalString)
  ) {
    return false
  }
  if (
    typeof state.usedKeys !== 'object' ||
    state.usedKeys === null ||
    !Object.values(state.usedKeys).every(
      (binding) =>
        typeof binding === 'object' &&
        binding !== null &&
        typeof (binding as Record<string, unknown>).previewReference ===
          'string' &&
        ((binding as Record<string, unknown>).receiptId === undefined ||
          typeof (binding as Record<string, unknown>).receiptId === 'string'),
    )
  ) {
    return false
  }
  if (
    !Array.isArray(state.consumedPreviews) ||
    !state.consumedPreviews.every((reference) => typeof reference === 'string')
  ) {
    return false
  }
  if (!Array.isArray(state.history) || !state.history.every(isStoredReceipt)) {
    return false
  }
  return true
}

function isSimulatorStateV2(value: unknown): value is SimulatorStateV2 {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return (
    state.version === 2 &&
    typeof state.nextPreviewNumber === 'number' &&
    Number.isInteger(state.nextPreviewNumber) &&
    state.nextPreviewNumber >= 0 &&
    typeof state.nextReceiptNumber === 'number' &&
    Number.isInteger(state.nextReceiptNumber) &&
    state.nextReceiptNumber >= 0 &&
    typeof state.nextMovementNumber === 'number' &&
    Number.isInteger(state.nextMovementNumber) &&
    state.nextMovementNumber >= 1 &&
    typeof state.cash === 'object' &&
    state.cash !== null &&
    Object.values(state.cash).every(isDecimalString) &&
    isUsedKeys(state.usedKeys) &&
    Array.isArray(state.consumedPreviews) &&
    state.consumedPreviews.every(
      (reference) => typeof reference === 'string',
    ) &&
    Array.isArray(state.history) &&
    state.history.every(isStoredReceipt) &&
    Array.isArray(state.movements) &&
    state.movements.every(isStoredMovement) &&
    typeof state.movementKeys === 'object' &&
    state.movementKeys !== null &&
    Object.values(state.movementKeys).every(
      (movementId) => typeof movementId === 'string',
    )
  )
}

function storedReceiptToReceipt(stored: StoredReceipt): OrderReceipt {
  const receipt: OrderReceipt = {
    id: stored.id,
    instrumentId: stored.instrumentId,
    side: stored.side,
    quantity: moneyFromString(stored.quantity),
    executedPrice: moneyFromString(stored.executedPrice),
    commission: moneyFromString(stored.commission),
    total: moneyFromString(stored.total),
    status: stored.status,
    executedAt: stored.executedAt,
    idempotencyKey: stored.idempotencyKey,
  }
  if (stored.slippedPrice !== undefined) {
    receipt.slippedPrice = moneyFromString(stored.slippedPrice)
  }
  if (stored.reason !== undefined) {
    receipt.reason = stored.reason
  }
  return receipt
}

function receiptToStored(receipt: OrderReceipt): StoredReceipt {
  const stored: StoredReceipt = {
    id: receipt.id,
    instrumentId: receipt.instrumentId,
    side: receipt.side,
    quantity: moneyToDecimalString(receipt.quantity),
    executedPrice: moneyToDecimalString(receipt.executedPrice),
    commission: moneyToDecimalString(receipt.commission),
    total: moneyToDecimalString(receipt.total),
    status: receipt.status,
    executedAt: receipt.executedAt,
    idempotencyKey: receipt.idempotencyKey,
  }
  if (receipt.slippedPrice !== undefined) {
    stored.slippedPrice = moneyToDecimalString(receipt.slippedPrice)
  }
  if (receipt.reason !== undefined) {
    stored.reason = receipt.reason
  }
  return stored
}

function storedMovementToMovement(stored: StoredMovement): CashMovement {
  const movement: CashMovement = {
    id: stored.id,
    type: stored.type,
    currency: stored.currency,
    amount: moneyFromString(stored.amount),
    timestamp: stored.timestamp,
    balance: moneyFromString(stored.balance),
  }
  if (stored.note !== undefined) movement.note = stored.note
  if (stored.idempotencyKey !== undefined) {
    movement.idempotencyKey = stored.idempotencyKey
  }
  return movement
}

function movementToStored(movement: CashMovement): StoredMovement {
  const stored: StoredMovement = {
    id: movement.id,
    type: movement.type,
    currency: movement.currency,
    amount: moneyToDecimalString(movement.amount),
    timestamp: movement.timestamp,
    balance: moneyToDecimalString(movement.balance),
  }
  if (movement.note !== undefined) stored.note = movement.note
  if (movement.idempotencyKey !== undefined) {
    stored.idempotencyKey = movement.idempotencyKey
  }
  return stored
}

/**
 * Local paper-trading engine implementing OrderExecutionProvider. It prices
 * against the injected market source, keeps its account in `balancita:simulator`
 * and writes positions through the shared PortfolioRepository so the Portfolio
 * tab and the simulator always see one source of truth.
 */
export class LocalPaperTradingProvider implements OrderExecutionProvider {
  private readonly marketSource: PaperTradingMarketSource
  private readonly portfolio: PortfolioRepository
  private readonly config: OrderSimulatorConfig
  private readonly feePolicy: FeePolicy | undefined
  private readonly previews = new Map<string, OrderPreview>()
  private readonly now: () => number

  constructor(
    marketSource: PaperTradingMarketSource,
    portfolio: PortfolioRepository = new LocalStoragePortfolioRepository(),
    options: Partial<OrderSimulatorConfig> & { now?: () => number } = {},
  ) {
    this.marketSource = marketSource
    this.portfolio = portfolio
    this.config = orderSimulatorConfigFrom(options)
    this.feePolicy =
      this.config.feePolicy ??
      (this.config.commission === 0 ? ZERO_FEE_POLICY : undefined)
    this.now = options.now ?? Date.now
  }

  async preview(order: OrderIntent): Promise<OrderPreview> {
    const instrument = await this.marketSource.getInstrument(order.instrumentId)
    if (instrument === null) {
      throw new UnknownInstrumentError(
        `No instrument registered for "${order.instrumentId}".`,
      )
    }
    const quote = await this.marketSource.getPrice(order.instrumentId)
    if (quote === null) {
      throw new UnavailablePriceError(
        `No live price available for "${order.instrumentId}".`,
      )
    }

    const marketPrice = moneyFromNumber(quote.price)
    const projection = this.project(
      order.side,
      order.quantity,
      marketPrice,
      instrument.currency,
    )

    const state = await this.readState()
    const reference = `P${state.nextPreviewNumber}`
    state.nextPreviewNumber += 1
    await this.writeState(state)

    const preview: OrderPreview = {
      reference,
      instrumentId: order.instrumentId,
      side: order.side,
      quantity: order.quantity,
      marketPrice,
      slippageApplied: projection.slippageApplied,
      slippedPrice: projection.slippedPrice,
      commission: projection.commission,
      subtotal: projection.subtotal,
      estimatedTotal: projection.estimatedTotal,
      currency: instrument.currency,
      ...(this.feePolicy === undefined ? {} : { feePolicy: this.feePolicy }),
    }
    this.previews.set(reference, preview)
    return preview
  }

  async submit(order: ConfirmedOrder): Promise<OrderReceipt> {
    const state = await this.readState()

    const binding = state.usedKeys[order.idempotencyKey]
    if (binding !== undefined) {
      if (binding.previewReference !== order.previewReference) {
        throw new IdempotencyConflictError(
          `Idempotency key "${order.idempotencyKey}" was already used for preview "${binding.previewReference}".`,
          binding.previewReference,
        )
      }
      const stored = state.history.find(
        (receipt) => receipt.id === binding.receiptId,
      )
      if (stored === undefined) {
        throw new SimulatorCorruptStateError(
          `Receipt "${binding.receiptId}" referenced by key "${order.idempotencyKey}" is missing from history.`,
        )
      }
      return storedReceiptToReceipt(stored)
    }

    const preview = this.previews.get(order.previewReference)
    if (preview === undefined) {
      throw new MissingOrUnknownPreviewError(
        `Preview "${order.previewReference}" is unknown or was already consumed. Re-request a preview before confirming.`,
      )
    }

    const instrument = await this.marketSource.getInstrument(
      preview.instrumentId,
    )
    if (instrument === null) {
      throw new UnknownInstrumentError(
        `No instrument registered for "${preview.instrumentId}".`,
      )
    }
    const quote = await this.marketSource.getPrice(preview.instrumentId)
    if (quote === null) {
      throw new UnavailablePriceError(
        `No live price available for "${preview.instrumentId}".`,
      )
    }

    const freshPrice = moneyFromNumber(quote.price)
    if (
      !driftWithinTolerance(
        preview.marketPrice,
        freshPrice,
        moneyFromNumber(this.config.previewTolerance),
      )
    ) {
      state.consumedPreviews.push(preview.reference)
      await this.writeState(state)
      this.previews.delete(preview.reference)
      throw new PreviewOutdatedError(
        `Market moved beyond the ${this.config.previewTolerance * 100}% preview tolerance. Re-preview before confirming.`,
        preview.reference,
      )
    }

    const projection = this.project(
      preview.side,
      preview.quantity,
      freshPrice,
      instrument.currency,
    )
    const currency = instrument.currency
    const cash = this.parseCash(state, currency)
    const holdings = await this.portfolio.list()
    const held = holdings.find((h) => h.instrumentId === preview.instrumentId)

    let outcome: 'executed' | 'rejected'
    let reason: string | undefined
    let updatedHoldings: readonly Holding[] | null = null

    if (preview.side === BUY) {
      if (moneyLt(cash, projection.estimatedTotal)) {
        outcome = 'rejected'
        reason = 'insufficient-cash'
      } else {
        state.cash[currency] = moneyToDecimalString(
          moneySub(cash, projection.estimatedTotal),
        )
        const position = averageCostAfterBuy(
          held ?? null,
          preview.quantity,
          projection.estimatedTotal,
        )
        updatedHoldings = [
          {
            instrumentId: preview.instrumentId,
            quantity: position.quantity,
            averageCost: position.averageCost,
          },
        ]
        outcome = 'executed'
      }
    } else {
      const heldQuantity = held?.quantity
      if (
        heldQuantity === undefined ||
        moneyLt(heldQuantity, preview.quantity)
      ) {
        outcome = 'rejected'
        reason = 'insufficient-position'
      } else {
        state.cash[currency] = moneyToDecimalString(
          moneyAdd(cash, projection.estimatedTotal),
        )
        const remaining = moneySub(heldQuantity, preview.quantity)
        if (moneyIsZero(remaining)) {
          updatedHoldings = []
        } else if (held !== undefined) {
          updatedHoldings = [
            {
              instrumentId: preview.instrumentId,
              quantity: remaining,
              averageCost: held.averageCost,
            },
          ]
        }
        outcome = 'executed'
      }
    }

    if (outcome === 'executed' && updatedHoldings !== null) {
      for (const next of updatedHoldings) {
        await this.portfolio.add(next)
      }
      if (updatedHoldings.length === 0) {
        await this.portfolio.remove(preview.instrumentId)
      }
    }

    const receipt: OrderReceipt = {
      id: `R${state.nextReceiptNumber}`,
      instrumentId: preview.instrumentId,
      side: preview.side,
      quantity: preview.quantity,
      executedPrice: freshPrice,
      slippedPrice: projection.slippedPrice,
      commission: projection.commission,
      total: projection.estimatedTotal,
      status: outcome,
      executedAt: this.now(),
      idempotencyKey: order.idempotencyKey,
    }
    if (reason !== undefined) receipt.reason = reason

    state.nextReceiptNumber += 1
    state.history.push(receiptToStored(receipt))
    state.usedKeys[order.idempotencyKey] = {
      previewReference: preview.reference,
      receiptId: receipt.id,
    }
    state.consumedPreviews.push(preview.reference)
    this.previews.delete(preview.reference)
    await this.writeState(state)

    return receipt
  }

  async account(): Promise<PaperTradingAccount> {
    const state = await this.readState()
    return {
      cash: Object.fromEntries(
        Object.entries(state.cash).map(([currency, value]) => [
          currency,
          moneyFromString(value),
        ]),
      ),
      history: state.history.map(storedReceiptToReceipt),
      movements: state.movements.map(storedMovementToMovement),
    }
  }

  async deposit(
    currency: string,
    amount: Money,
    options: CashMovementOptions = {},
  ): Promise<CashMovement> {
    return this.recordCashMovement('deposit', currency, amount, options)
  }

  async withdraw(
    currency: string,
    amount: Money,
    options: CashMovementOptions = {},
  ): Promise<CashMovement> {
    return this.recordCashMovement('withdrawal', currency, amount, options)
  }

  private project(
    side: OrderSide,
    quantity: Money,
    marketPrice: Money,
    currency: string,
  ) {
    const slippage = moneyFromNumber(this.config.slippage)
    const provisional = estimatePreview(
      side,
      quantity,
      marketPrice,
      slippage,
      moneyFromNumber(0),
    )
    const commission =
      this.feePolicy === undefined
        ? moneyFromNumber(this.config.commission)
        : calculateCommission(provisional.subtotal, this.feePolicy, currency)
    return estimatePreview(side, quantity, marketPrice, slippage, commission)
  }

  private async recordCashMovement(
    type: CashMovementType,
    currency: string,
    amount: Money,
    options: CashMovementOptions,
  ): Promise<CashMovement> {
    if (!moneyIsPositive(amount)) {
      throw new InvalidVirtualCashMovementError(
        'Virtual cash movement amount must be positive.',
      )
    }
    const state = await this.readState()
    if (state.cash[currency] === undefined) {
      throw new InvalidVirtualCashMovementError(
        `Currency "${currency}" is not supported by the virtual account.`,
      )
    }

    if (options.idempotencyKey !== undefined) {
      const existingId = state.movementKeys[options.idempotencyKey]
      if (existingId !== undefined) {
        const existing = state.movements.find(
          (movement) => movement.id === existingId,
        )
        if (existing === undefined) {
          this.reset()
          throw new SimulatorCorruptStateError(
            `Movement "${existingId}" referenced by an idempotency key is missing.`,
          )
        }
        if (
          existing.type !== type ||
          existing.currency !== currency ||
          moneyFromString(existing.amount).units !== amount.units ||
          existing.note !== options.note
        ) {
          throw new CashMovementIdempotencyConflictError(
            `Cash movement key "${options.idempotencyKey}" was already used with another payload.`,
          )
        }
        return storedMovementToMovement(existing)
      }
    }

    const current = this.parseCash(state, currency)
    const balance =
      type === 'deposit' ? moneyAdd(current, amount) : moneySub(current, amount)
    if (type === 'withdrawal' && moneyLt(current, amount)) {
      throw new InsufficientVirtualCashError(
        `Insufficient virtual cash in ${currency}.`,
      )
    }
    const movement: CashMovement = {
      id: `M${state.nextMovementNumber}`,
      type,
      currency,
      amount,
      timestamp: options.timestamp ?? this.now(),
      balance,
    }
    if (!Number.isFinite(movement.timestamp)) {
      throw new InvalidVirtualCashMovementError(
        'Virtual cash movement timestamp must be finite.',
      )
    }
    if (options.note !== undefined) movement.note = options.note
    if (options.idempotencyKey !== undefined) {
      movement.idempotencyKey = options.idempotencyKey
      state.movementKeys[options.idempotencyKey] = movement.id
    }
    state.cash[currency] = moneyToDecimalString(balance)
    state.nextMovementNumber += 1
    state.movements.push(movementToStored(movement))
    await this.writeState(state)
    return movement
  }

  private initialCash(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.config.initialCash).map(([currency, amount]) => [
        currency,
        moneyToDecimalString(moneyFromNumber(amount)),
      ]),
    )
  }

  private initialState(): SimulatorStateV2 {
    return {
      version: SIMULATOR_SCHEMA_VERSION,
      cash: this.initialCash(),
      nextPreviewNumber: 1,
      nextReceiptNumber: 1,
      nextMovementNumber: 1,
      usedKeys: {},
      consumedPreviews: [],
      history: [],
      movements: [],
      movementKeys: {},
    }
  }

  private async readState(): Promise<SimulatorStateV2> {
    const raw = this.storage().getItem(SIMULATOR_STORAGE_KEY)
    if (raw === null) return this.initialState()
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isSimulatorStateV2(parsed)) return parsed
      if (isSimulatorStateV1(parsed)) {
        const migrated: SimulatorStateV2 = {
          ...parsed,
          version: 2,
          nextMovementNumber: 1,
          movements: [],
          movementKeys: {},
        }
        await this.writeState(migrated)
        return migrated
      }
    } catch {
      // fall through to corruption handling
    }
    this.reset()
    return this.initialState()
  }

  private async writeState(state: SimulatorStateV2): Promise<void> {
    this.storage().setItem(SIMULATOR_STORAGE_KEY, JSON.stringify(state))
  }

  private reset(): void {
    this.storage().removeItem(SIMULATOR_STORAGE_KEY)
  }

  private storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
    return window.localStorage
  }

  private parseCash(state: SimulatorStateV2, currency: string): Money {
    const raw = state.cash[currency]
    if (raw === undefined) {
      this.reset()
      throw new SimulatorCorruptStateError(
        `Account has no cash ledger for currency "${currency}".`,
      )
    }
    try {
      return moneyFromString(raw)
    } catch (cause) {
      this.reset()
      throw new SimulatorCorruptStateError(
        `Cash value for "${currency}" is not a valid decimal.`,
        cause,
      )
    }
  }
}
