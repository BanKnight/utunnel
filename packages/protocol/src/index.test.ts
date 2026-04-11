import { describe, expect, test } from 'bun:test'
import { hostSessionRecordSchema, serviceDefinitionSchema, tunnelMessageSchema } from './index'

describe('protocol schemas', () => {
  test('validates a service definition', () => {
    const result = serviceDefinitionSchema.parse({
      serviceId: 'svc-1',
      serviceName: 'echo',
      localUrl: 'http://127.0.0.1:3001',
      protocol: 'http',
      subdomain: 'echo.example.test',
    })

    expect(result.serviceId).toBe('svc-1')
  })

  test('validates a heartbeat message', () => {
    const result = tunnelMessageSchema.parse({
      type: 'heartbeat',
      payload: {
        hostId: 'host-1',
        sessionId: 'session-1',
        timestamp: new Date().toISOString(),
      },
    })

    expect(result.type).toBe('heartbeat')
  })

  test('validates a host session record', () => {
    const result = hostSessionRecordSchema.parse({
      hostId: 'host-1',
      sessionId: 'session-1',
      version: 1,
      connectedAt: Date.now(),
      disconnectedAt: null,
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

    expect(result.version).toBe(1)
  })
})
