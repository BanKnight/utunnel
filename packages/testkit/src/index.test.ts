import { describe, expect, test } from 'bun:test'
import {
  buildHostToken,
  createMockAgentConfig,
  createRoutingEntry,
  createTempDemoConfigDir,
  createV1DemoAgentConfigs,
} from './index'
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

  test('creates demo agent configs for three hosts', () => {
    const configs = createV1DemoAgentConfigs('http://127.0.0.1:8787', 'example.test', 'dev-operator-token', {
      host1Http: 5101,
      host2Http: 5102,
      host3Http: 5103,
      host3Ws: 5203,
    }, 'suite')

    expect(configs).toHaveLength(3)
    expect(configs.map((config) => config.hostId)).toEqual(['host-1-suite', 'host-2-suite', 'host-3-suite'])
    expect(configs[0]?.token).toBe(buildHostToken('host-1-suite', 'dev-operator-token'))
    expect(configs[0]?.services[0]?.localUrl).toBe('http://127.0.0.1:5101')
    expect(configs[0]?.services[0]?.subdomain).toBe('host-1-http-suite.example.test')
    expect(configs[2]?.services).toHaveLength(2)
    expect(configs[2]?.services[1]?.protocol).toBe('websocket')
    expect(configs[2]?.services[1]?.localUrl).toBe('http://127.0.0.1:5203')
  })

  test('writes temporary demo config files', async () => {
    const demo = await createTempDemoConfigDir([
      createMockAgentConfig({ hostId: 'host-a' }),
      createMockAgentConfig({ hostId: 'host-b' }),
    ])

    try {
      expect(demo.configPaths).toHaveLength(2)
      expect(demo.configPaths[0]).toContain('host-a.json')
      expect(demo.configPaths[1]).toContain('host-b.json')
    } finally {
      await demo.cleanup()
    }
  })
})
