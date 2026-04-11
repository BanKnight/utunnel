import { describe, expect, test } from 'bun:test'
import { parseAgentConfig, parseEdgeEnv } from './index'

describe('config parsing', () => {
  test('parses edge env', () => {
    const parsed = parseEdgeEnv({
      ROOT_DOMAIN: 'example.test',
      OPERATOR_TOKEN: 'dev-token',
      STALE_ROUTE_GRACE_MS: '30000',
    })

    expect(parsed.ROOT_DOMAIN).toBe('example.test')
    expect(parsed.STALE_ROUTE_GRACE_MS).toBe(30000)
  })

  test('parses agent config with defaults', () => {
    const parsed = parseAgentConfig({
      hostId: 'host-1',
      hostname: 'machine-1',
      token: 'dev-token',
      edgeBaseUrl: 'http://127.0.0.1:8787',
      services: [
        {
          serviceId: 'svc-1',
          serviceName: 'echo',
          localUrl: 'http://127.0.0.1:3001',
          protocol: 'http',
          subdomain: 'echo.example.test',
        },
      ],
    })

    expect(parsed.services).toHaveLength(1)
    expect(parsed.reconnectDelayMs).toBe(3000)
    expect(parsed.maxReconnectAttempts).toBe(5)
  })
})
