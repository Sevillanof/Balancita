export function devEnvironment(environment) {
  return {
    ...environment,
    VITE_MARKET_DATA_PROVIDER:
      environment.VITE_MARKET_DATA_PROVIDER || 'kraken',
  }
}

export function serverEnvironment(environment) {
  return {
    ...environment,
    BALANCITA_ROOT_DEV_SERVER: 'true',
  }
}

export function serverNodeArgs(
  args,
  allowedFlags = process.allowedNodeEnvironmentFlags,
) {
  return allowedFlags.has('--use-system-ca')
    ? ['--use-system-ca', ...args]
    : args
}
