import type { TerminalEnvelope } from './terminal-stream-client.ts'

type TerminalState = Record<string, unknown>

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

export function applyTerminalEvent(
  previous: TerminalState | null,
  event: TerminalEnvelope,
): TerminalState {
  const state = { ...(previous ?? {}) }
  const data = event.data
  if (event.type === 'analysis.completed') {
    state.analyses = [
      ...(Array.isArray(state.analyses) ? state.analyses : []),
      data.analysis,
    ].slice(-500)
    state.state_version = Number(state.state_version ?? 0) + 1
  } else if (event.type === 'account.updated') state.account = data.account
  else if (event.type === 'position.updated') state.position = data.position
  else if (event.type === 'order.updated')
    state.orders = [
      ...(Array.isArray(state.orders) ? state.orders : []),
      data.order,
    ].slice(-500)
  else if (event.type === 'fill.created')
    state.fills = [
      ...(Array.isArray(state.fills) ? state.fills : []),
      data.fill,
    ].slice(-500)
  else if (event.type === 'command.result') {
    const result = record(record(data.result).result)
    state.state_version = result.applied_state_version ?? state.state_version
  }
  return state
}
