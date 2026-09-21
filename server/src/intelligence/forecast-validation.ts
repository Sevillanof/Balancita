import {
  parseTimestampMs,
  type ForecastOutcome,
  type ForecastRecord,
  type ForecastHorizon,
} from './contracts.ts'
import {
  invalid,
  isRecord,
  issue,
  nonEmptyString,
  valid,
  type ValidationIssue,
  type ValidationResult,
} from './validation.ts'

const PROBABILITY_TOLERANCE = 1e-9
const horizons: readonly ForecastHorizon[] = ['15m', '1h', '4h', '24h']

function requiredString(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[],
): boolean {
  if (!nonEmptyString(input[key])) {
    issues.push(
      issue('required_string', key, `${key} must be a non-empty string.`),
    )
    return false
  }
  return true
}

function finiteNumber(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[],
  positive = false,
): boolean {
  if (
    typeof input[key] !== 'number' ||
    !Number.isFinite(input[key]) ||
    (positive && input[key] <= 0)
  ) {
    issues.push(
      issue(
        'invalid_number',
        key,
        `${key} must be finite${positive ? ' and positive' : ''}.`,
      ),
    )
    return false
  }
  return true
}

function timestamp(
  input: Record<string, unknown>,
  key: string,
  issues: ValidationIssue[],
) {
  const result = parseTimestampMs(input[key], key)
  if (!result.valid) issues.push(...result.issues)
  return result
}

export function validateForecastRecord(
  input: unknown,
): ValidationResult<ForecastRecord> {
  if (!isRecord(input))
    return invalid([
      issue(
        'invalid_forecast',
        'forecast',
        'Forecast record must be an object.',
      ),
    ])
  const issues: ValidationIssue[] = []
  requiredString(input, 'id', issues)
  requiredString(input, 'version', issues)
  requiredString(input, 'modelVersion', issues)
  requiredString(input, 'ruleVersion', issues)
  requiredString(input, 'contentHash', issues)
  if (input.instrumentId !== 'BTC-EUR')
    issues.push(
      issue(
        'unsupported_instrument',
        'instrumentId',
        'Only BTC-EUR forecasts are supported.',
      ),
    )
  if (!horizons.includes(input.horizon as ForecastHorizon))
    issues.push(
      issue('invalid_horizon', 'horizon', 'Forecast horizon is not supported.'),
    )

  const createdAt = timestamp(input, 'createdAt', issues)
  const asOfTimestamp = timestamp(input, 'asOfTimestamp', issues)
  const eventCutoff = timestamp(input, 'eventCutoff', issues)
  if (
    createdAt.valid &&
    asOfTimestamp.valid &&
    createdAt.value < asOfTimestamp.value
  )
    issues.push(
      issue(
        'created_before_cutoff',
        'createdAt',
        'Created time cannot precede the evidence cutoff.',
      ),
    )
  if (
    asOfTimestamp.valid &&
    eventCutoff.valid &&
    asOfTimestamp.value !== eventCutoff.value
  )
    issues.push(
      issue(
        'cutoff_mismatch',
        'eventCutoff',
        'asOfTimestamp and eventCutoff must identify the same instant.',
      ),
    )

  finiteNumber(input, 'referencePrice', issues, true)
  const probabilityKeys = [
    'probabilityUp',
    'probabilityDown',
    'probabilityFlat',
  ] as const
  const probabilities = probabilityKeys.map((key) => input[key])
  probabilities.forEach((probability, index) => {
    if (
      typeof probability !== 'number' ||
      !Number.isFinite(probability) ||
      probability < 0 ||
      probability > 1
    ) {
      issues.push(
        issue(
          'invalid_probability',
          probabilityKeys[index],
          'Probability must be finite and within [0, 1].',
        ),
      )
    }
  })
  if (
    probabilities.every(
      (probability): probability is number =>
        typeof probability === 'number' && Number.isFinite(probability),
    )
  ) {
    const sum = probabilities.reduce(
      (total, probability) => total + probability,
      0,
    )
    if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE)
      issues.push(
        issue(
          'probabilities_sum',
          'probabilities',
          `Probabilities must sum to 1 within tolerance ${PROBABILITY_TOLERANCE}.`,
        ),
      )
  }

  if (input.expectedRange !== undefined) {
    if (
      !isRecord(input.expectedRange) ||
      !finiteNumber(input.expectedRange, 'lower', issues) ||
      !finiteNumber(input.expectedRange, 'upper', issues)
    ) {
      issues.push(
        issue(
          'invalid_expected_range',
          'expectedRange',
          'Expected range must contain finite lower and upper values.',
        ),
      )
    } else if (
      (input.expectedRange.lower as number) >
      (input.expectedRange.upper as number)
    ) {
      issues.push(
        issue(
          'invalid_expected_range',
          'expectedRange',
          'Expected range lower bound cannot exceed upper bound.',
        ),
      )
    }
  }
  if (input.expectedReturn !== undefined)
    finiteNumber(input, 'expectedReturn', issues)

  const feature = input.technicalFeatureSnapshot
  if (!isRecord(feature)) {
    issues.push(
      issue(
        'feature_snapshot_required',
        'technicalFeatureSnapshot',
        'Technical feature snapshot is required.',
      ),
    )
  } else {
    if (!nonEmptyString(feature.version))
      issues.push(
        issue(
          'feature_version_required',
          'technicalFeatureSnapshot.version',
          'Feature version is required.',
        ),
      )
    const featureTime = parseTimestampMs(
      feature.asOfTimestamp,
      'technicalFeatureSnapshot.asOfTimestamp',
    )
    if (!featureTime.valid) issues.push(...featureTime.issues)
    if (
      featureTime.valid &&
      eventCutoff.valid &&
      featureTime.value > eventCutoff.value
    )
      issues.push(
        issue(
          'feature_after_cutoff',
          'technicalFeatureSnapshot.asOfTimestamp',
          'Feature evidence cannot follow the forecast cutoff.',
        ),
      )
    if (feature.isClosed !== true)
      issues.push(
        issue(
          'open_candle_evidence',
          'technicalFeatureSnapshot.isClosed',
          'Open candle evidence cannot feed a forecast.',
        ),
      )
    if (typeof feature.ready !== 'boolean')
      issues.push(
        issue(
          'feature_readiness_required',
          'technicalFeatureSnapshot.ready',
          'Feature readiness is required.',
        ),
      )
    if (!isRecord(feature.warmUp)) {
      issues.push(
        issue(
          'feature_warmup_required',
          'technicalFeatureSnapshot.warmUp',
          'Feature warm-up metrics are required.',
        ),
      )
    } else {
      for (const key of [
        'requiredCandles',
        'availableCandles',
        'missingCandles',
      ]) {
        if (
          typeof feature.warmUp[key] !== 'number' ||
          !Number.isSafeInteger(feature.warmUp[key]) ||
          feature.warmUp[key] < 0
        )
          issues.push(
            issue(
              'invalid_feature_warmup',
              `technicalFeatureSnapshot.warmUp.${key}`,
              'Feature warm-up counts must be non-negative safe integers.',
            ),
          )
      }
    }
    if (!isRecord(feature.values)) {
      issues.push(
        issue(
          'feature_values_required',
          'technicalFeatureSnapshot.values',
          'Feature values are required.',
        ),
      )
    } else {
      for (const [key, value] of Object.entries(feature.values)) {
        if (typeof value !== 'number' || !Number.isFinite(value))
          issues.push(
            issue(
              'invalid_feature_value',
              `technicalFeatureSnapshot.values.${key}`,
              'Feature values must be finite numbers.',
            ),
          )
      }
    }
  }

  const references = input.newsEvidenceReferences
  if (!Array.isArray(references)) {
    issues.push(
      issue(
        'news_references_required',
        'newsEvidenceReferences',
        'News evidence references must be an array.',
      ),
    )
  } else {
    references.forEach((reference, index) => {
      if (!isRecord(reference)) {
        issues.push(
          issue(
            'invalid_news_reference',
            `newsEvidenceReferences[${index}]`,
            'News reference must be an object.',
          ),
        )
        return
      }
      requiredString(reference, 'id', issues)
      if (!nonEmptyString(reference.version))
        issues.push(
          issue(
            'news_version_required',
            `newsEvidenceReferences[${index}].version`,
            'News evidence version is required.',
          ),
        )
      if (!nonEmptyString(reference.contentHash))
        issues.push(
          issue(
            'news_hash_required',
            `newsEvidenceReferences[${index}].contentHash`,
            'News evidence hash is required.',
          ),
        )
      const published = parseTimestampMs(
        reference.publishedAt,
        `newsEvidenceReferences[${index}].publishedAt`,
      )
      const ingested = parseTimestampMs(
        reference.ingestedAt,
        `newsEvidenceReferences[${index}].ingestedAt`,
      )
      if (!published.valid) issues.push(...published.issues)
      if (!ingested.valid) issues.push(...ingested.issues)
      if (published.valid && ingested.valid && published.value > ingested.value)
        issues.push(
          issue(
            'news_order_invalid',
            `newsEvidenceReferences[${index}]`,
            'Published time cannot follow ingestion time.',
          ),
        )
      if (
        ingested.valid &&
        eventCutoff.valid &&
        ingested.value > eventCutoff.value
      )
        issues.push(
          issue(
            'news_after_cutoff',
            `newsEvidenceReferences[${index}].ingestedAt`,
            'News evidence cannot be ingested after the forecast cutoff.',
          ),
        )
    })
  }

  const freshness = input.dataFreshness
  if (
    !isRecord(freshness) ||
    typeof freshness.ageMs !== 'number' ||
    !Number.isFinite(freshness.ageMs) ||
    freshness.ageMs < 0 ||
    typeof freshness.isStale !== 'boolean' ||
    typeof freshness.clockInverted !== 'boolean'
  ) {
    issues.push(
      issue(
        'invalid_freshness_metrics',
        'dataFreshness',
        'Freshness metrics are incomplete or invalid.',
      ),
    )
  }
  const gaps = input.dataGaps
  if (!isRecord(gaps)) {
    issues.push(
      issue(
        'invalid_gap_metrics',
        'dataGaps',
        'Gap metrics are incomplete or invalid.',
      ),
    )
  } else {
    const gapCount = gaps.gapCount
    const expectedOpportunities = gaps.expectedOpportunities
    const rate = gaps.rate
    if (
      typeof gapCount !== 'number' ||
      !Number.isSafeInteger(gapCount) ||
      gapCount < 0 ||
      typeof expectedOpportunities !== 'number' ||
      !Number.isSafeInteger(expectedOpportunities) ||
      expectedOpportunities < 0 ||
      typeof gaps.sequenceAvailable !== 'boolean' ||
      (rate !== null &&
        (typeof rate !== 'number' ||
          !Number.isFinite(rate) ||
          rate < 0 ||
          rate > 1))
    ) {
      issues.push(
        issue(
          'invalid_gap_metrics',
          'dataGaps',
          'Gap metrics are incomplete or invalid.',
        ),
      )
    }
  }

  if (typeof input.abstained !== 'boolean')
    issues.push(
      issue(
        'abstention_required',
        'abstained',
        'Abstention state is required.',
      ),
    )
  if (input.abstained === true && !nonEmptyString(input.abstentionReason))
    issues.push(
      issue(
        'abstention_reason_required',
        'abstentionReason',
        'An abstention reason is required when abstained is true.',
      ),
    )

  if (issues.length > 0) return invalid(issues)
  return valid(input as unknown as ForecastRecord)
}

export function validateForecastOutcome(
  input: unknown,
  forecast?: ForecastRecord,
): ValidationResult<ForecastOutcome> {
  if (!isRecord(input))
    return invalid([
      issue(
        'invalid_outcome',
        'outcome',
        'Forecast outcome must be an object.',
      ),
    ])
  const issues: ValidationIssue[] = []
  requiredString(input, 'id', issues)
  requiredString(input, 'version', issues)
  requiredString(input, 'forecastId', issues)
  requiredString(input, 'forecastVersion', issues)
  requiredString(input, 'contentHash', issues)
  if (input.forecastId !== forecast?.id && forecast !== undefined)
    issues.push(
      issue(
        'forecast_reference_mismatch',
        'forecastId',
        'Outcome must reference the supplied forecast id.',
      ),
    )
  if (input.forecastVersion !== forecast?.version && forecast !== undefined)
    issues.push(
      issue(
        'forecast_reference_mismatch',
        'forecastVersion',
        'Outcome must reference the supplied forecast version.',
      ),
    )
  const evaluatedAt = timestamp(input, 'evaluatedAt', issues)
  const observedEventTime = timestamp(input, 'observedEventTime', issues)
  if (
    forecast !== undefined &&
    evaluatedAt.valid &&
    evaluatedAt.value < forecast.eventCutoff
  )
    issues.push(
      issue(
        'outcome_before_cutoff',
        'evaluatedAt',
        'Outcome cannot be evaluated before the forecast cutoff.',
      ),
    )
  finiteNumber(input, 'observedPrice', issues, true)
  finiteNumber(input, 'realizedReturn', issues)
  if (!nonEmptyString(input.observedDataHash))
    issues.push(
      issue(
        'observed_data_hash_required',
        'observedDataHash',
        'Observed data hash is required.',
      ),
    )
  if (input.observedDataIsClosed !== true)
    issues.push(
      issue(
        'open_observed_data',
        'observedDataIsClosed',
        'Open observed data cannot evaluate a forecast.',
      ),
    )
  finiteNumber(input, 'neutralBand', issues)
  if (typeof input.neutralBand === 'number' && input.neutralBand < 0)
    issues.push(
      issue(
        'invalid_neutral_band',
        'neutralBand',
        'Neutral band must be non-negative.',
      ),
    )
  finiteNumber(input, 'brierScore', issues)
  if (input.logLoss !== undefined) finiteNumber(input, 'logLoss', issues)
  if (input.returnAbsoluteError !== undefined)
    finiteNumber(input, 'returnAbsoluteError', issues)
  if (input.rangeAbsoluteError !== undefined)
    finiteNumber(input, 'rangeAbsoluteError', issues)
  if (
    forecast !== undefined &&
    observedEventTime.valid &&
    observedEventTime.value < forecast.eventCutoff
  )
    issues.push(
      issue(
        'observed_before_cutoff',
        'observedEventTime',
        'Observed event time cannot precede the forecast cutoff.',
      ),
    )
  if (input.costs !== undefined) {
    const costs = input.costs
    if (!isRecord(costs) || !nonEmptyString(costs.version))
      issues.push(
        issue(
          'invalid_cost_parameters',
          'costs',
          'Cost parameters require a version.',
        ),
      )
    else {
      finiteNumber(costs, 'commissionRate', issues)
      finiteNumber(costs, 'slippageRate', issues)
      if (typeof costs.commissionRate === 'number' && costs.commissionRate < 0)
        issues.push(
          issue(
            'invalid_cost_parameters',
            'costs.commissionRate',
            'Commission rate must be non-negative.',
          ),
        )
      if (typeof costs.slippageRate === 'number' && costs.slippageRate < 0)
        issues.push(
          issue(
            'invalid_cost_parameters',
            'costs.slippageRate',
            'Slippage rate must be non-negative.',
          ),
        )
    }
  }
  if (input.label !== 'up' && input.label !== 'down' && input.label !== 'flat')
    issues.push(
      issue(
        'invalid_outcome_label',
        'label',
        'Outcome label is not supported.',
      ),
    )
  if (issues.length > 0) return invalid(issues)
  return valid(input as unknown as ForecastOutcome)
}

export { PROBABILITY_TOLERANCE }
