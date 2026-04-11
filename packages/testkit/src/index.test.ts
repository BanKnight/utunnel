import { describe, expect, test } from 'bun:test'
import { createMockAgentConfig, createRoutingEntry } from './index'
import { createNextRuntimeState } from '../../../apps/agent/src/runtime'

describe('testkit helpers', () => {
  test('creates a mock agent config', () => {
    const config = createMockAgentConfig()
    expect(config.hostId).toBe('host-1')
    expect(config.services[0]?.subdomain).toBe('echo.example.test')
  })

  test('creates a routing entry', () => {
    const config = createMockAgentConfig()
    const entry = createRoutingEntry(config.services[0]!)
    expect(entry.hostname).toBe('echo.example.test')
    expect(entry.version).toBe(1)
  })

  test('creates the next runtime state for reconnects', () => {
    const initial = createNextRuntimeState()
    const next = createNextRuntimeState(initial)

    expect(next.version).toBe(initial.version + 1)
    expect(next.previousSessionId).toBe(initial.sessionId)
  })
})
