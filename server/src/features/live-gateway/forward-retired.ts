/**
 * The forward paper books of C25-C31 and Kronos switched off by the launcher (`scripts/dev-provider-env.mjs`,
 * `forwardEnabled`; amendment 2026-11-06 of ADR 0001). One rule everywhere: the launcher sets
 * `FUTURES_FORWARD_RETIRED=1` only when it did not start the `forward` child. Anything else keeps the previous
 * behaviour (the reports judge the forward), so a gateway started by hand is unchanged.
 */
export function forwardRetiredFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (env.FUTURES_FORWARD_RETIRED ?? '').trim() === '1'
}

/** What a report says in place of the forward's numbers: retired on purpose, not broken, not zero. */
export const FORWARD_RETIRED_DETAIL =
  'Forward retirado: el paper hacia delante de C25-C31 y Kronos ya no corre (sus libros quedan como historia, solo lectura). Para volver a arrancarlo: FORWARD_ENABLED=1 y reiniciar pnpm dev.'
