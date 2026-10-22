import type { StatusTone } from '../../../shared/mission-control/index.ts'
import type {
  HealthComponent,
  HealthStatus,
} from '../infrastructure/observability-api.ts'

import { B1_MAX_AGE_MS, CLOCK_SKEW_MS } from './latest-decision.ts'

/** Presentation only: a new receipt cannot rejuvenate a cached generation. */
export function reportTiming(
  now: number,
  receivedAt: number | null | undefined,
  generatedAt: number,
) {
  const generationAge =
    Number.isFinite(now) && Number.isFinite(generatedAt)
      ? now - generatedAt
      : null
  const receiptAge =
    receivedAt != null && Number.isFinite(receivedAt) && Number.isFinite(now)
      ? now - receivedAt
      : null
  const unverified =
    generationAge === null || receiptAge === null || receivedAt == null ||
    generationAge < -CLOCK_SKEW_MS || receiptAge < -CLOCK_SKEW_MS ||
    generatedAt - receivedAt > CLOCK_SKEW_MS
  const state = unverified
    ? 'unverified'
    : generationAge > B1_MAX_AGE_MS || receiptAge > B1_MAX_AGE_MS
      ? 'stale'
      : 'fresh'
  return {
    state,
    generationAge,
    receiptAge,
    // Preserve the base evidence age, then add elapsed time since generation.
    reference: unverified ? null : generatedAt + Math.max(0, generationAge),
  }
}

export const TONE: Record<HealthStatus, StatusTone> = {
  ok: 'ok',
  warning: 'warn',
  error: 'bad',
  // «Sin datos» is not healthy and not failing: it stays neutral.
  unknown: 'nodata',
}

export const LABEL: Record<HealthStatus, string> = {
  ok: 'Correcto',
  warning: 'Advertencia',
  error: 'Error',
  unknown: 'Sin datos',
}

export type ComponentGroup = {
  title: string
  items: { component: HealthComponent; index: number }[]
}

/**
 * Problems first, then what is unverified, then what is fine. The number is
 * the component's fixed place (1 to 6), so the order of the list never
 * renames a component.
 */
export function componentOrder(
  components: readonly HealthComponent[],
): ComponentGroup[] {
  const numbered = components.map((component, i) => ({
    component,
    index: i + 1,
  }))
  const groups: ComponentGroup[] = [
    {
      title: 'Con problemas',
      items: numbered.filter(
        ({ component }) =>
          component.status === 'error' || component.status === 'warning',
      ),
    },
    {
      title: 'Sin verificar',
      items: numbered.filter(({ component }) => component.status === 'unknown'),
    },
    {
      title: 'Correctos',
      items: numbered.filter(({ component }) => component.status === 'ok'),
    },
  ]
  return groups.filter((group) => group.items.length > 0)
}
