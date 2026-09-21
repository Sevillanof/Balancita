export const SHADOW_POLICY_VERSION = 'shadow-policy.v1' as const
export const SHADOW_AGGREGATION_RULE_VERSION = 'shadow-aggregation.v1' as const
export const SHADOW_BASELINE_RULE_VERSION = 'shadow-baseline.v1' as const
export const SHADOW_REGIME_RULE_VERSION = 'shadow-regime.v1' as const
export const SHADOW_REPORT_VERSION = 'shadow-report.v1' as const
export const SHADOW_DECISION_VERSION = 'shadow-decision.v1' as const
export const SHADOW_RUN_SCHEMA_VERSION = 'shadow-run.v1' as const
export const SHADOW_STATUS_VERSION = 'shadow-run-status.v1' as const

export type ShadowRunStatusKind =
  'collecting' | 'ready_for_review' | 'insufficient_evidence' | 'go' | 'no_go'

export type ShadowDecisionType = 'go' | 'no_go'

export type ShadowDerivedRegime = 'high_volatility' | 'low_volatility'

export interface ShadowVersions {
  readonly policyVersion: typeof SHADOW_POLICY_VERSION
  readonly aggregationRuleVersion: typeof SHADOW_AGGREGATION_RULE_VERSION
  readonly baselineRuleVersion: typeof SHADOW_BASELINE_RULE_VERSION
  readonly regimeRuleVersion: typeof SHADOW_REGIME_RULE_VERSION
  readonly reportVersion: typeof SHADOW_REPORT_VERSION
  readonly decisionVersion: typeof SHADOW_DECISION_VERSION
}

export interface ShadowSourceConstraints {
  readonly realtimeOnly: boolean
  readonly technicalFreshnessToleranceMs: number
  readonly newsScoresNotPersisted: boolean
}
