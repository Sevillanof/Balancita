/**
 * The C31 off switch as the gateway receives it from the launcher
 * (`scripts/dev-provider-env.mjs`, `qwenExitSwitch`). One rule everywhere: the
 * variable absent means on; present means off, and a blank reason is a config
 * error shown loudly in the reason, never a silent "on".
 */
export function qwenExitOffFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): { readonly reason: string; readonly since: string } | undefined {
  const reason = env.QWEN_EXIT_OFF_REASON
  if (reason === undefined) return undefined
  if (reason.trim() === '')
    return {
      reason:
        'configuración inválida: QWEN_EXIT_OFF_REASON vacío (bloque "off" sin motivo): apagada por seguridad',
      since: 'fecha no indicada',
    }
  return {
    reason,
    since: env.QWEN_EXIT_OFF_SINCE?.trim() || 'fecha no indicada',
  }
}
