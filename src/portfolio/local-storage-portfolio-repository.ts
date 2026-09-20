import {
  PortfolioCorruptError,
  isHolding,
  type Holding,
  type PortfolioRepository,
} from '../domain/portfolio'
import {
  moneyFromNumber,
  moneyFromString,
  moneyIsPositive,
  moneyToDecimalString,
} from '../domain/money'

export const PORTFOLIO_STORAGE_KEY = 'balancita:portfolio'
export const PORTFOLIO_SCHEMA_VERSION = 2
export const PORTFOLIO_LEGACY_SCHEMA_VERSION = 1

const DECIMAL_STRING_RE = /^\d+(?:\.\d{1,8})?$/

type StoredHolding = {
  instrumentId: string
  quantity: string
  averageCost: string
}

type ReadResult = { holdings: readonly Holding[]; migratedFromV1: boolean }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function toStored(holding: Holding): StoredHolding {
  return {
    instrumentId: holding.instrumentId,
    quantity: moneyToDecimalString(holding.quantity),
    averageCost: moneyToDecimalString(holding.averageCost),
  }
}

function isPositiveDecimalString(
  value: unknown,
  field: string,
): value is string {
  if (typeof value !== 'string' || !DECIMAL_STRING_RE.test(value)) {
    throw new PortfolioCorruptError(
      `Stored portfolio holding has an invalid ${field}: ${JSON.stringify(
        value,
      )}.`,
    )
  }
  return moneyIsPositive(moneyFromString(value))
}

function parseHoldingV2(value: unknown): Holding {
  if (!isRecord(value)) {
    throw new PortfolioCorruptError(
      'Stored portfolio contains an invalid holding.',
    )
  }
  const instrumentId = value.instrumentId
  if (
    typeof instrumentId !== 'string' ||
    instrumentId.length === 0 ||
    !isPositiveDecimalString(value.quantity, 'quantity') ||
    !isPositiveDecimalString(value.averageCost, 'averageCost')
  ) {
    throw new PortfolioCorruptError(
      'Stored portfolio contains an invalid holding.',
    )
  }
  return {
    instrumentId,
    quantity: moneyFromString(value.quantity as string),
    averageCost: moneyFromString(value.averageCost as string),
  }
}

function parseLegacyHoldingV1(value: unknown): Holding {
  if (!isRecord(value)) {
    throw new PortfolioCorruptError(
      'Stored portfolio contains an invalid v1 holding.',
    )
  }
  const { instrumentId, quantity, averageCost } = value
  if (
    typeof instrumentId !== 'string' ||
    instrumentId.length === 0 ||
    typeof quantity !== 'number' ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    typeof averageCost !== 'number' ||
    !Number.isFinite(averageCost) ||
    averageCost <= 0
  ) {
    throw new PortfolioCorruptError(
      'Stored portfolio contains an invalid v1 holding.',
    )
  }
  // v1 stored plain numbers; convert them at scale 8 when crossing into Money.
  return {
    instrumentId,
    quantity: moneyFromNumber(quantity),
    averageCost: moneyFromNumber(averageCost),
  }
}

function readStore(json: string): ReadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (cause) {
    throw new PortfolioCorruptError(
      'Stored portfolio data is not valid JSON.',
      cause,
    )
  }

  if (!isRecord(parsed)) {
    throw new PortfolioCorruptError(
      'Stored portfolio data is not an object payload.',
    )
  }

  if (parsed.version === PORTFOLIO_LEGACY_SCHEMA_VERSION) {
    if (!Array.isArray(parsed.holdings)) {
      throw new PortfolioCorruptError(
        'Stored portfolio payload is missing its holdings list.',
      )
    }
    return {
      holdings: parsed.holdings.map(parseLegacyHoldingV1),
      migratedFromV1: true,
    }
  }

  if (parsed.version !== PORTFOLIO_SCHEMA_VERSION) {
    throw new PortfolioCorruptError(
      `Unsupported portfolio schema version: ${String(parsed.version)}.`,
    )
  }

  if (!Array.isArray(parsed.holdings)) {
    throw new PortfolioCorruptError(
      'Stored portfolio payload is missing its holdings list.',
    )
  }

  return {
    holdings: parsed.holdings.map(parseHoldingV2),
    migratedFromV1: false,
  }
}

function serialize(holdings: readonly Holding[]): string {
  return JSON.stringify({
    version: PORTFOLIO_SCHEMA_VERSION,
    holdings: holdings.map(toStored),
  })
}

/**
 * Local-first portfolio persistence on top of localStorage. The stored payload
 * is the minimal `{ version, holdings }` — quotes and computed totals are never
 * persisted; the UI derives them from the live market feed. Holdings are stored
 * as decimal strings produced by the fixed-point money module.
 *
 * Reading performs strict validation: missing storage is an empty portfolio,
 * existing-but-invalid data throws `PortfolioCorruptError`, and a legacy v1
 * payload (plain-number holdings) is migrated automatically to v2 decimal
 * strings and rewritten once, so every later read is at the current schema.
 */
export class LocalStoragePortfolioRepository implements PortfolioRepository {
  private readonly storage: Pick<Storage, 'getItem' | 'setItem'>

  constructor(
    storage: Pick<Storage, 'getItem' | 'setItem'> = window.localStorage,
  ) {
    this.storage = storage
  }

  async list(): Promise<readonly Holding[]> {
    const raw = this.storage.getItem(PORTFOLIO_STORAGE_KEY)
    if (raw === null) return []
    const { holdings, migratedFromV1 } = readStore(raw)
    if (migratedFromV1) {
      try {
        this.storage.setItem(PORTFOLIO_STORAGE_KEY, serialize(holdings))
      } catch {
        // Migration is a best-effort rewrite; the data is already usable.
      }
    }
    return holdings.map((holding) => ({
      instrumentId: holding.instrumentId,
      quantity: holding.quantity,
      averageCost: holding.averageCost,
    }))
  }

  async add(holding: Holding): Promise<void> {
    if (!isHolding(holding)) {
      throw new PortfolioCorruptError('Refusing to persist an invalid holding.')
    }
    const holdings = await this.readHoldingsForWrite()
    const index = holdings.findIndex(
      (existing) => existing.instrumentId === holding.instrumentId,
    )
    if (index === -1) {
      holdings.push({ ...holding })
    } else {
      holdings[index] = { ...holding }
    }
    this.write(holdings)
  }

  async remove(instrumentId: string): Promise<void> {
    const holdings = await this.currentHoldings()
    const remaining = holdings.filter(
      (holding) => holding.instrumentId !== instrumentId,
    )
    if (remaining.length !== holdings.length) {
      this.write(remaining)
    }
  }

  async clear(): Promise<void> {
    this.storage.setItem(
      PORTFOLIO_STORAGE_KEY,
      serialize([] as readonly Holding[]),
    )
  }

  private write(holdings: Holding[]): void {
    this.storage.setItem(PORTFOLIO_STORAGE_KEY, serialize(holdings))
  }

  /** Reads all holdings for a read-modify-write cycle (for mutation ops). */
  private async readHoldingsForWrite(): Promise<Holding[]> {
    return this.currentHoldings().then((holdings) =>
      holdings.map((holding) => ({ ...holding })),
    )
  }

  private async currentHoldings(): Promise<Holding[]> {
    const listed = await this.list()
    return [...listed]
  }
}
