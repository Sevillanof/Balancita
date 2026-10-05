import { describe, expect, it } from 'vitest'
import {
  checkLocalScenarioFinancials,
  type LocalFinancialCheckInput,
  type LocalFinancialObservation,
} from './futures-local-financial-check.js'

const input: LocalFinancialCheckInput = {
  initialCashUsd: '10000',
  makerRate: '0.0002',
  takerRate: '0.0005',
  fundingRate: '0',
  fundingKnown: true,
  fundingCoversClose: true,
  partialQuantityBtc: '0.005',
  entryAskUsdPerBtc: '100001',
  closeBidUsdPerBtc: '99943',
  partialMarkUsdPerBtc: '100000.5',
  observations: [
    {
      stage: 'entry-accepted',
      position: { side: null, quantityBtc: '0' },
      ledger: {
        cashUsd: '10000',
        realizedGrossUsd: '0',
        unrealizedGrossUsd: '0',
        feesUsd: '0',
        fundingPaidUsd: '0',
        netCompleteUsd: '0',
        equityUsd: '10000',
      },
      fills: [],
    },
    {
      stage: 'partial-fill',
      position: {
        side: 'long',
        quantityBtc: '0.005',
        averageEntryPriceUsdPerBtc: '100001',
      },
      ledger: {
        cashUsd: '10000',
        realizedGrossUsd: '0',
        unrealizedGrossUsd: '-0.0025',
        feesUsd: '0.2500025',
        fundingPaidUsd: '0',
        netCompleteUsd: null,
        equityUsd: '9999.7474975',
      },
      fills: [
        {
          side: 'long',
          liquidity: 'taker',
          quantityBtc: '0.005',
          priceUsdPerBtc: '100001',
          feeUsd: '0.2500025',
        },
      ],
    },
    {
      stage: 'close',
      position: { side: null, quantityBtc: '0' },
      ledger: {
        cashUsd: '10000',
        realizedGrossUsd: '-0.29',
        unrealizedGrossUsd: '0',
        feesUsd: '0.49986',
        fundingPaidUsd: '0',
        netCompleteUsd: '-0.78986',
        equityUsd: '9999.21014',
      },
      fills: [
        {
          side: 'long',
          liquidity: 'taker',
          quantityBtc: '0.005',
          priceUsdPerBtc: '99943',
          feeUsd: '0.2498575',
        },
      ],
    },
  ],
}

describe('independent local scenario financial check', () => {
  it('derives all three accounting boundaries without engine totals', () => {
    const result = checkLocalScenarioFinancials(input)

    expect(result.checks).toHaveLength(3)
    expect(result.checks.every((check) => check.passed)).toBe(true)
    expect(result.checks.map((check) => check.expected.equityUsd)).toEqual([
      '10000',
      '9999.7474975',
      '9999.21014',
    ])
    expect(result.fundingLimitation).toContain(
      'Funding is zero in this local scenario',
    )
  })

  it.each([
    [
      'entry acceptance quantity',
      0,
      (observations: LocalFinancialObservation[]) => {
        observations[0]!.position.quantityBtc = '0.005'
      },
    ],
    [
      'partial cash notional debit',
      1,
      (observations: LocalFinancialObservation[]) => {
        observations[1]!.ledger.cashUsd = '9499.995'
      },
    ],
    [
      'partial average entry',
      1,
      (observations: LocalFinancialObservation[]) => {
        observations[1]!.position.averageEntryPriceUsdPerBtc = '100000'
      },
    ],
    [
      'partial unrealized P&L',
      1,
      (observations: LocalFinancialObservation[]) => {
        observations[1]!.ledger.unrealizedGrossUsd = '0'
      },
    ],
    [
      'partial fee',
      1,
      (observations: LocalFinancialObservation[]) => {
        observations[1]!.ledger.feesUsd = '0'
      },
    ],
    [
      'partial equity',
      1,
      (observations: LocalFinancialObservation[]) => {
        observations[1]!.ledger.equityUsd = '10000'
      },
    ],
    [
      'close realized P&L',
      2,
      (observations: LocalFinancialObservation[]) => {
        observations[2]!.ledger.realizedGrossUsd = '0'
      },
    ],
    [
      'close fee',
      2,
      (observations: LocalFinancialObservation[]) => {
        observations[2]!.ledger.feesUsd = '0'
      },
    ],
    [
      'close equity',
      2,
      (observations: LocalFinancialObservation[]) => {
        observations[2]!.ledger.equityUsd = '10000'
      },
    ],
    [
      'complete close net P&L',
      2,
      (observations: LocalFinancialObservation[]) => {
        observations[2]!.ledger.netCompleteUsd = null
      },
    ],
    [
      'close fill price',
      2,
      (observations: LocalFinancialObservation[]) => {
        observations[2]!.fills[0]!.priceUsdPerBtc = '99944'
      },
    ],
  ] as [string, number, (observations: LocalFinancialObservation[]) => void][])(
    'rejects tampered %s',
    (_name, index, mutate) => {
      const changed = cloneInput()
      mutate(changed.observations)
      expect(checkLocalScenarioFinancials(changed).checks[index]!.passed).toBe(
        false,
      )
    },
  )

  it('rejects a non-zero or unknown funding input outside this zero-funding proof', () => {
    expect(() =>
      checkLocalScenarioFinancials({ ...input, fundingRate: '0.01' }),
    ).toThrow(/known zero funding/i)
    expect(() =>
      checkLocalScenarioFinancials({ ...input, fundingKnown: false }),
    ).toThrow(/known zero funding/i)
    expect(() =>
      checkLocalScenarioFinancials({ ...input, fundingCoversClose: false }),
    ).toThrow(/known zero funding/i)
  })

  it('rejects mark-to-mid or fill-price substitutions in the observed accounting', () => {
    const wrongMark = cloneInput()
    wrongMark.observations[1]!.ledger.unrealizedGrossUsd = '-0.0025'
    wrongMark.observations[1]!.ledger.equityUsd = '9999.75'
    expect(checkLocalScenarioFinancials(wrongMark).checks[1]!.passed).toBe(
      false,
    )

    const wrongFill = cloneInput()
    wrongFill.observations[1]!.fills[0]!.priceUsdPerBtc = '100000'
    expect(checkLocalScenarioFinancials(wrongFill).checks[1]!.passed).toBe(
      false,
    )
  })
})

function cloneInput(): LocalFinancialCheckInput {
  return {
    ...input,
    observations: input.observations.map((observation) =>
      structuredClone(observation),
    ),
  }
}
