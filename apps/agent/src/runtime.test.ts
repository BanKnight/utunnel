import { describe, expect, test } from 'bun:test'
import { buildServiceBindingPayload, createDefaultAgentConfig, createNextRuntimeState, resolveRegistrationPath } from './runtime'

describe('agent runtime helpers', () => {
  test('creates initial and reconnect runtime states', () => {
    const first = createNextRuntimeState()
    const second = createNextRuntimeState(first)

    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
    expect(second.previousSessionId).toBe(first.sessionId)
  })

  test('resolves registration path based on runtime state', () => {
    const first = createNextRuntimeState()
    const second = createNextRuntimeState(first)

    expect(resolveRegistrationPath(first)).toBe('services')
    expect(resolveRegistrationPath(second)).toBe('rebind')
  })

  test('builds service binding payload from config and state', () => {
    const config = createDefaultAgentConfig()
    const state = createNextRuntimeState()
    const payload = buildServiceBindingPayload(state, config.services)

    expect(payload.sessionId).toBe(state.sessionId)
    expect(payload.services).toHaveLength(1)
  })
})
