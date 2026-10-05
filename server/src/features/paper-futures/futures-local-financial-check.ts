const SCALE = 1_000_000_000_000n
const ZERO = { value: 0n }

export type LocalFinancialObservation = {
  stage: string
  position: {
    side: string | null
    quantityBtc: string
    averageEntryPriceUsdPerBtc?: string
  }
  ledger: {
    cashUsd: string
    realizedGrossUsd: string
    unrealizedGrossUsd: string
    feesUsd: string
    fundingPaidUsd: string
    netCompleteUsd: string | null
    equityUsd: string
  }
  fills: {
    side: string
    liquidity: string
    quantityBtc: string
    priceUsdPerBtc: string
    feeUsd: string
  }[]
}

export type LocalFinancialCheckInput = {
  initialCashUsd: string
  makerRate: string
  takerRate: string
  fundingRate: string
  fundingKnown: boolean
  fundingCoversClose: boolean
  partialQuantityBtc: string
  entryAskUsdPerBtc: string
  closeBidUsdPerBtc: string
  partialMarkUsdPerBtc: string
  observations: LocalFinancialObservation[]
}

type Values = Record<string, string | null>
type Check = {
  stage: string
  passed: boolean
  expected: Values
  observed: Values
}

const fundingLimitation =
  'Funding is zero in this local scenario; non-zero funding accrual, sign, interval coverage and allocation are not verified.'

/** Independent LOCAL_SIMULATION arithmetic; deliberately imports no ledger or engine helpers. */
export function checkLocalScenarioFinancials(input: LocalFinancialCheckInput) {
  if (
    !input.fundingKnown ||
    !input.fundingCoversClose ||
    decimal(input.fundingRate).value !== 0n
  )
    throw new Error(
      'Independent scenario check requires known zero funding covering the full position interval.',
    )
  if (input.observations.length !== 3)
    throw new Error(
      'Independent scenario check requires three financial boundaries.',
    )

  const cash = decimal(input.initialCashUsd)
  const qty = decimal(input.partialQuantityBtc)
  const entryPrice = decimal(input.entryAskUsdPerBtc)
  const exitPrice = decimal(input.closeBidUsdPerBtc)
  const partialMark = decimal(input.partialMarkUsdPerBtc)
  const takerRate = decimal(input.takerRate)
  // Read and validate the frozen maker rate even though both fixture executions are taker.
  const makerRate = decimal(input.makerRate)
  if (makerRate.value < 0n || takerRate.value < 0n)
    throw new Error('Independent scenario fee rates must be nonnegative.')

  const entryFee = multiply(multiply(qty, entryPrice), takerRate)
  const exitFee = multiply(multiply(qty, exitPrice), takerRate)
  const closeGross = multiply(qty, subtract(exitPrice, entryPrice))
  const partialUnrealized = multiply(qty, subtract(partialMark, entryPrice))
  const partialEquity = subtract(
    subtract(add(cash, partialUnrealized), entryFee),
    ZERO,
  )
  const closeFees = add(entryFee, exitFee)
  const closeEquity = subtract(add(cash, closeGross), closeFees)

  const expected: Values[] = [
    {
      side: null,
      quantityBtc: '0',
      averageEntryPriceUsdPerBtc: null,
      cashUsd: format(cash),
      realizedGrossUsd: '0',
      unrealizedGrossUsd: '0',
      feesUsd: '0',
      fundingPaidUsd: '0',
      netCompleteUsd: '0',
      equityUsd: format(cash),
    },
    {
      side: 'long',
      quantityBtc: format(qty),
      averageEntryPriceUsdPerBtc: format(entryPrice),
      cashUsd: format(cash),
      realizedGrossUsd: '0',
      unrealizedGrossUsd: format(partialUnrealized),
      feesUsd: format(entryFee),
      fundingPaidUsd: '0',
      netCompleteUsd: null,
      equityUsd: format(partialEquity),
    },
    {
      side: null,
      quantityBtc: '0',
      averageEntryPriceUsdPerBtc: null,
      cashUsd: format(cash),
      realizedGrossUsd: format(closeGross),
      unrealizedGrossUsd: '0',
      feesUsd: format(closeFees),
      fundingPaidUsd: '0',
      netCompleteUsd: format(subtract(closeGross, closeFees)),
      equityUsd: format(closeEquity),
    },
  ]
  const stages = ['entry-accepted', 'partial-fill', 'close']
  return {
    accountingContract:
      'ADR 0001 accounting contract; Balancita-Kraken-Futuros-Guia-Implementacion.md §10 lines 260–268 (fill-notional fees, side-aware gross P&L, mark equity, zero vs unknown funding) and §16. Equity = unchanged USD cash + realized gross + mark-based unrealized gross - fees - signed funding; futures notional is not debited from cash.',
    fundingLimitation,
    checks: input.observations.map((observation, index): Check => {
      const want = expected[index]!
      const actual: Values = {
        stage: observation.stage,
        side: observation.position.side,
        quantityBtc: normalize(observation.position.quantityBtc),
        cashUsd: normalize(observation.ledger.cashUsd),
        averageEntryPriceUsdPerBtc:
          observation.position.averageEntryPriceUsdPerBtc === undefined
            ? null
            : normalize(observation.position.averageEntryPriceUsdPerBtc),
        realizedGrossUsd: normalize(observation.ledger.realizedGrossUsd),
        unrealizedGrossUsd: normalize(observation.ledger.unrealizedGrossUsd),
        feesUsd: normalize(observation.ledger.feesUsd),
        fundingPaidUsd: normalize(observation.ledger.fundingPaidUsd),
        netCompleteUsd:
          observation.ledger.netCompleteUsd === null
            ? null
            : normalize(observation.ledger.netCompleteUsd),
        equityUsd: normalize(observation.ledger.equityUsd),
      }
      const fills = observation.fills
      const fillsMatch =
        index === 0
          ? fills.length === 0
          : index === 1
            ? fillMatches(fills, 'long', qty, entryPrice, entryFee)
            : fillMatches(fills, 'long', qty, exitPrice, exitFee)
      const passed =
        observation.stage === stages[index] &&
        fillsMatch &&
        Object.keys(want).every((key) => actual[key] === want[key])
      return {
        stage: stages[index]!,
        passed,
        expected: want,
        observed: actual,
      }
    }),
  }
}

function fillMatches(
  fills: LocalFinancialObservation['fills'],
  side: string,
  quantity: Decimal,
  price: Decimal,
  fee: Decimal,
): boolean {
  return (
    fills.length === 1 &&
    fills[0]!.side === side &&
    normalize(fills[0]!.quantityBtc) === format(quantity) &&
    normalize(fills[0]!.priceUsdPerBtc) === format(price) &&
    normalize(fills[0]!.feeUsd) === format(fee) &&
    fills[0]!.liquidity === 'taker'
  )
}

type Decimal = { value: bigint }
function decimal(value: string): Decimal {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))
    throw new Error(
      'Independent financial check requires finite decimal strings.',
    )
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [whole, fraction = ''] = unsigned.split('.')
  if (fraction.length > 12)
    throw new Error(
      'Independent financial check decimal precision exceeds 12 places.',
    )
  const coefficient =
    BigInt(whole!) * SCALE + BigInt(fraction.padEnd(12, '0') || '0')
  return { value: negative ? -coefficient : coefficient }
}
function multiply(left: Decimal, right: Decimal): Decimal {
  return { value: (left.value * right.value) / SCALE }
}
function add(left: Decimal, right: Decimal): Decimal {
  return { value: left.value + right.value }
}
function subtract(left: Decimal, right: Decimal): Decimal {
  return { value: left.value - right.value }
}
function format(value: Decimal): string {
  const negative = value.value < 0n
  const absolute = negative ? -value.value : value.value
  const whole = absolute / SCALE
  const fraction = (absolute % SCALE)
    .toString()
    .padStart(12, '0')
    .replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`
}
function normalize(value: string): string {
  return format(decimal(value))
}
