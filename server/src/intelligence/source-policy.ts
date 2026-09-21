import {
  parseTimestampMs,
  type CorrectionStatus,
  type LicenseStatus,
  type NewsEvidence,
  type NewsEventTaxonomy,
  type NewsRelevance,
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
  | 'empty_source_item_id'
  | 'invalid_relevance'
  | 'invalid_taxonomy'
  | 'invalid_rule_version'
  | 'invalid_metadata'
  | 'correction_reference_required'
  | 'content_too_long'

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

function relevance(value: unknown): value is NewsRelevance {
  return (
    value === 'relevant' || value === 'not_relevant' || value === 'uncertain'
  )
}

function taxonomy(value: unknown): value is NewsEventTaxonomy {
  return (
    value === 'macro' ||
    value === 'regulation' ||
    value === 'market_structure' ||
    value === 'technology' ||
    value === 'exchange' ||
    value === 'security' ||
    value === 'other'
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

function validateMetadata(input: unknown): boolean {
  if (!isRecord(input) || !nonEmptyString(input.title)) return false
  if (input.title.length > 512) return false
  if (input.author !== undefined && typeof input.author !== 'string')
    return false
  if (input.category !== undefined && typeof input.category !== 'string')
    return false
  if (input.feedUrl !== undefined && typeof input.feedUrl !== 'string')
    return false
  return true
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
  if (!nonEmptyString(input.sourceItemId)) {
    reasons.push(
      reason(
        'empty_source_item_id',
        'sourceItemId',
        'Source item identity is required for replay and correction tracking.',
      ),
    )
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
  } else if (
    input.correctionStatus !== 'original' &&
    !nonEmptyString(input.correctionOfSourceItemId)
  ) {
    reasons.push(
      reason(
        'correction_reference_required',
        'correctionOfSourceItemId',
        'Corrected and retracted evidence must reference prior source identity.',
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
  } else if (
    isRecord(input.content) &&
    input.content.kind !== 'metadata_only' &&
    typeof input.content.text === 'string' &&
    input.content.text.length > 500
  ) {
    reasons.push(
      reason(
        'content_too_long',
        'content.text',
        'Stored content must be a short permitted fragment, never a full article.',
      ),
    )
  }

  if (!relevance(input.relevance)) {
    reasons.push(
      reason('invalid_relevance', 'relevance', 'Relevance is not supported.'),
    )
  }
  if (!taxonomy(input.taxonomy)) {
    reasons.push(
      reason('invalid_taxonomy', 'taxonomy', 'News taxonomy is not supported.'),
    )
  }
  if (!nonEmptyString(input.relevanceRuleVersion)) {
    reasons.push(
      reason(
        'invalid_rule_version',
        'relevanceRuleVersion',
        'Relevance rule version is required.',
      ),
    )
  }
  if (!nonEmptyString(input.taxonomyRuleVersion)) {
    reasons.push(
      reason(
        'invalid_rule_version',
        'taxonomyRuleVersion',
        'Taxonomy rule version is required.',
      ),
    )
  }
  if (!validateMetadata(input.metadata)) {
    reasons.push(
      reason(
        'invalid_metadata',
        'metadata',
        'News metadata must contain a bounded non-empty title.',
      ),
    )
  }

  if (
    reasons.length > 0 ||
    parsedUrl === undefined ||
    !sourceLevel(input.sourceLevel) ||
    !licenseStatus(input.licenseStatus) ||
    !correctionStatus(input.correctionStatus) ||
    !relevance(input.relevance) ||
    !taxonomy(input.taxonomy) ||
    !publishedAt.valid ||
    !ingestedAt.valid ||
    !retrievedAt.valid ||
    !validateMetadata(input.metadata)
  ) {
    return { accepted: false, reasons }
  }

  return {
    accepted: true,
    evidence: {
      instrumentId: 'BTC-EUR',
      source: input.source as string,
      sourceLevel: input.sourceLevel,
      sourceItemId: input.sourceItemId as string,
      url: parsedUrl.href,
      publishedAt: publishedAt.value,
      ingestedAt: ingestedAt.value,
      retrievedAt: retrievedAt.value,
      contentHash: input.contentHash as string,
      licenseStatus: input.licenseStatus,
      correctionStatus: input.correctionStatus,
      ...(input.correctionOfSourceItemId === undefined
        ? {}
        : {
            correctionOfSourceItemId: input.correctionOfSourceItemId as string,
          }),
      relevance: input.relevance as NewsRelevance,
      relevanceRuleVersion: input.relevanceRuleVersion as string,
      taxonomy: input.taxonomy as NewsEventTaxonomy,
      taxonomyRuleVersion: input.taxonomyRuleVersion as string,
      metadata: input.metadata as NewsEvidence['metadata'],
      content: input.content as NewsEvidence['content'],
    },
    reasons: [],
  }
}
