import {
  PortfolioCorruptError,
  isHolding,
  type Holding,
  type PortfolioRepository,
} from '../domain/portfolio'

export const PORTFOLIO_STORAGE_KEY = 'balancita:portfolio'
export const PORTFOLIO_SCHEMA_VERSION = 1

type PortfolioStore = {
  version: number
  holdings: Holding[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readStore(json: string): PortfolioStore {
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

  for (const holding of parsed.holdings) {
    if (!isHolding(holding)) {
      throw new PortfolioCorruptError(
        'Stored portfolio contains an invalid holding.',
      )
    }
  }

  return { version: parsed.version, holdings: parsed.holdings }
}

/**
 * Local-first portfolio persistence on top of localStorage. The stored payload
 * is the minimal `{ version, holdings }` — quotes and computed totals are never
 * persisted; the UI derives them from the live market feed.
 *
 * Reading performs strict validation: missing storage is an empty portfolio,
 * while existing-but-invalid data throws `PortfolioCorruptError` so the app can
 * offer an explicit reset instead of silently trusting garbage.
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
    return readStore(raw).holdings.map((holding) => ({ ...holding }))
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
      JSON.stringify({ version: PORTFOLIO_SCHEMA_VERSION, holdings: [] }),
    )
  }

  private write(holdings: Holding[]): void {
    this.storage.setItem(
      PORTFOLIO_STORAGE_KEY,
      JSON.stringify({ version: PORTFOLIO_SCHEMA_VERSION, holdings }),
    )
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
