/**
 * The old engine D (verdict service, forecast scorer, old LLM decisions) switched off by the launcher
 * (`scripts/dev-provider-env.mjs`, `engineDEnabled`; datos-utiles S7). One rule everywhere: the launcher
 * sets `FUTURES_ENGINE_D_RETIRED=1` only when it did not start those children. Anything else keeps the
 * previous behaviour (the reports judge the engine), so a gateway started by hand is unchanged.
 */
export function engineDRetiredFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (env.FUTURES_ENGINE_D_RETIRED ?? '').trim() === '1'
}

/** What a report says in place of the retired engine's numbers: retired on purpose, not broken, not zero. */
export const ENGINE_D_RETIRED_DETAIL =
  'Motor D retirado: verdicts, puntaje de pronósticos y decisiones LLM viejas ya no se escriben (sus bases quedan como historia). Para volver a capturarlos: ENGINE_D_ENABLED=1 y reiniciar pnpm dev.'
