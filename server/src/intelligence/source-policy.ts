import {
  parseTimestampMs,
  type CorrectionStatus,
  type LicenseStatus,
  type NewsEvidence,
  type NewsSourceLevel,
} from './contracts.ts'
import {
  invalid,
  isRecord,
  nonEmptyString,
  valid,
  type ValidationIssue,
  type ValidationResult,
} from './validation.ts'

export type SourcePolicyReasonCode =
  | 'invalid_provenance'
  | 'unsupported_instrument'
  | 'empty_source'
  | 'invalid_url'
  | 'url_must_be_https'
  | 'invalid_timestamp'
  | 'published_after_ingested'
  | 'retrieved_before_ingested'
  | 'invalid_source_level'
  | 'source_level_excluded'
  | 'license_status_required'
  | 'license_status_not_permitted'
  | 'invalid_correction_status'
  | 'correction_retracted'
  | 'empty_content_hash'
  | 'content_required'
  | 'invalid_content'

export interface SourcePolicyReason extends ValidationIssue {
  readonly code: SourcePolicyReasonCode
}

export interface SourcePolicyDecision {
  readonly accepted: boolean
  readonly evidence?: NewsEvidence
  readonly reasons: readonly SourcePolicyReason[]
}

function reason(
  code: SourcePolicyReasonCode,
  path: string,
  message: string,
): SourcePolicyReason {
  return { code, path, message }
}

function sourceLevel(value: unknown): value is NewsSourceLevel {
  return (
    value === 'official_primary' ||
    value === 'licensed_reporting' ||
    value === 'unverified_social'
  )
}

function licenseStatus(value: unknown): value is LicenseStatus {
  return (
    value === 'official_public' ||
    value === 'licensed' ||
    value === 'permission_required' ||
    value === 'unknown'
  )
}

function correctionStatus(value: unknown): value is CorrectionStatus {
  return (
    value === 'original' ||
    value === 'corrected' ||
    value === 'retracted' ||
    value === 'unknown'
  )
}

function validateContent(input: unknown): boolean {
  if (!isRecord(input) || typeof input.kind !== 'string') return false
  if (input.kind === 'metadata_only') return true
  return (
    (input.kind === 'excerpt' || input.kind === 'summary') &&
    nonEmptyString(input.text)
  )
}

export function validateNewsEvidence(
  input: unknown,
): ValidationResult<NewsEvidence> {
  const decision = evaluateNewsSource(input)
  return decision.accepted && decision.evidence !== undefined
    ? valid(decision.evidence)
    : invalid(decision.reasons)
}

export function evaluateNewsSource(input: unknown): SourcePolicyDecision {
  if (!isRecord(input)) {
    return {
      accepted: false,
      reasons: [
        reason(
          'invalid_provenance',
          'evidence',
          'News evidence must be an object.',
        ),
      ],
    }
  }

  const reasons: SourcePolicyReason[] = []
  if (input.instrumentId !== 'BTC-EUR') {
    reasons.push(
      reason(
        'unsupported_instrument',
        'instrumentId',
        'Only BTC-EUR news evidence is accepted.',
      ),
    )
  }
  if (!nonEmptyString(input.source)) {
    reasons.push(reason('empty_source', 'source', 'Source is required.'))
  }

  let parsedUrl: URL | undefined
  if (typeof input.url !== 'string' || input.url.trim() === '') {
    reasons.push(
      reason('invalid_url', 'url', 'URL must be an absolute HTTPS URL.'),
    )
  } else {
    try {
      parsedUrl = new URL(input.url)
      if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname === '') {
        reasons.push(
          reason(
            'url_must_be_https',
            'url',
            'URL must use HTTPS and include a hostname.',
          ),
        )
      }
    } catch {
      reasons.push(
        reason('invalid_url', 'url', 'URL must be an absolute HTTPS URL.'),
      )
    }
  }

  const publishedAt = parseTimestampMs(input.publishedAt, 'publishedAt')
  const ingestedAt = parseTimestampMs(input.ingestedAt, 'ingestedAt')
  const retrievedAt = parseTimestampMs(input.retrievedAt, 'retrievedAt')
  for (const timestamp of [publishedAt, ingestedAt, retrievedAt]) {
    if (!timestamp.valid)
      reasons.push(
        ...timestamp.issues.map((item) => ({
          ...item,
          code: 'invalid_timestamp' as const,
        })),
      )
  }
  if (
    publishedAt.valid &&
    ingestedAt.valid &&
    publishedAt.value > ingestedAt.value
  ) {
    reasons.push(
      reason(
        'published_after_ingested',
        'publishedAt',
        'Published time cannot follow ingestion time.',
      ),
    )
  }
  if (
    ingestedAt.valid &&
    retrievedAt.valid &&
    retrievedAt.value < ingestedAt.value
  ) {
    reasons.push(
      reason(
        'retrieved_before_ingested',
        'retrievedAt',
        'Retrieved time cannot precede ingestion time.',
      ),
    )
  }

  if (!sourceLevel(input.sourceLevel)) {
    reasons.push(
      reason(
        'invalid_source_level',
        'sourceLevel',
        'Source level is not supported.',
      ),
    )
  } else if (input.sourceLevel === 'unverified_social') {
    reasons.push(
      reason(
        'source_level_excluded',
        'sourceLevel',
        'Unverified social sources are excluded from the initial pipeline.',
      ),
    )
  }

  if (!licenseStatus(input.licenseStatus)) {
    reasons.push(
      reason(
        'license_status_required',
        'licenseStatus',
        'License status must be explicit.',
      ),
    )
  } else if (
    input.licenseStatus === 'unknown' ||
    input.licenseStatus === 'permission_required' ||
    (input.sourceLevel === 'official_primary' &&
      input.licenseStatus !== 'official_public') ||
    (input.sourceLevel === 'licensed_reporting' &&
      input.licenseStatus !== 'licensed')
  ) {
    reasons.push(
      reason(
        'license_status_not_permitted',
        'licenseStatus',
        'License status is not permitted for this source level.',
      ),
    )
  }

  if (!correctionStatus(input.correctionStatus)) {
    reasons.push(
      reason(
        'invalid_correction_status',
        'correctionStatus',
        'Correction status must be explicit.',
      ),
    )
  } else if (input.correctionStatus === 'unknown') {
    reasons.push(
      reason(
        'invalid_correction_status',
        'correctionStatus',
        'Unknown correction status is not accepted.',
      ),
    )
  } else if (input.correctionStatus === 'retracted') {
    reasons.push(
      reason(
        'correction_retracted',
        'correctionStatus',
        'Retracted evidence cannot enter the pipeline.',
      ),
    )
  }

  if (!nonEmptyString(input.contentHash)) {
    reasons.push(
      reason('empty_content_hash', 'contentHash', 'Content hash is required.'),
    )
  }
  if (input.content === undefined) {
    reasons.push(
      reason(
        'content_required',
        'content',
        'Only permitted content or an explicit metadata-only record is accepted.',
      ),
    )
  } else if (!validateContent(input.content)) {
    reasons.push(
      reason(
        'invalid_content',
        'content',
        'Content must be metadata-only, a non-empty excerpt, or a non-empty summary.',
      ),
    )
  }

  if (
    reasons.length > 0 ||
    parsedUrl === undefined ||
    !sourceLevel(input.sourceLevel) ||
    !licenseStatus(input.licenseStatus) ||
    !correctionStatus(input.correctionStatus) ||
    !publishedAt.valid ||
    !ingestedAt.valid ||
    !retrievedAt.valid
  ) {
    return { accepted: false, reasons }
  }

  return {
    accepted: true,
    evidence: {
      instrumentId: 'BTC-EUR',
      source: input.source as string,
      sourceLevel: input.sourceLevel,
      url: parsedUrl.href,
      publishedAt: publishedAt.value,
      ingestedAt: ingestedAt.value,
      retrievedAt: retrievedAt.value,
      contentHash: input.contentHash as string,
      licenseStatus: input.licenseStatus,
      correctionStatus: input.correctionStatus,
      content: input.content as NewsEvidence['content'],
    },
    reasons: [],
  }
}
