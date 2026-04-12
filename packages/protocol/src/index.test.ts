import { describe, expect, test } from 'bun:test'
import {
  appliedHostConfigSchema,
  bootstrapClaimMessageSchema,
  configDispatchMessageSchema,
  configDispatchStatusSchema,
  controlPlaneMessageSchema,
  currentHostConfigSchema,
  desiredHostConfigSchema,
  hostSessionRecordSchema,
  serviceDefinitionSchema,
  tunnelMessageSchema,
} from './index'

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
      lastHeartbeatAt: Date.now(),
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
    expect(result.lastHeartbeatAt).toBeTypeOf('number')
  })

  test('validates a desired host config for control-plane state', () => {
    const result = desiredHostConfigSchema.parse({
      hostId: 'host-1',
      generation: 3,
      services: [
        {
          serviceId: 'svc-1',
          serviceName: 'echo',
          localUrl: 'http://127.0.0.1:3001',
          protocol: 'http',
          subdomain: 'echo.example.test',
        },
      ],
      updatedAt: Date.now(),
    })

    expect(result.generation).toBe(3)
  })

  test('validates current and applied host config states', () => {
    const current = currentHostConfigSchema.parse({
      hostId: 'host-1',
      generation: 4,
      status: 'acknowledged',
      reportedAt: Date.now(),
      services: [],
    })

    const applied = appliedHostConfigSchema.parse({
      hostId: 'host-1',
      generation: 4,
      appliedAt: Date.now(),
      services: [],
    })

    expect(current.status).toBe('acknowledged')
    expect(applied.generation).toBe(4)
  })

  test('validates bootstrap claim and config dispatch control messages', () => {
    const bootstrap = controlPlaneMessageSchema.parse({
      type: 'bootstrap_claim',
      payload: {
        hostId: 'host-1',
        hostname: 'machine-1',
        bootstrapToken: 'bootstrap-token',
      },
    })

    const dispatch = controlPlaneMessageSchema.parse({
      type: 'config_dispatch',
      payload: {
        hostId: 'host-1',
        generation: 5,
        desired: {
          hostId: 'host-1',
          generation: 5,
          services: [],
          updatedAt: Date.now(),
        },
        dispatchedAt: Date.now(),
        idempotencyKey: 'dispatch-1',
      },
    })

    expect(bootstrap.type).toBe('bootstrap_claim')
    expect(dispatch.type).toBe('config_dispatch')
  })

  test('rejects control-plane dispatch messages from tunnelMessageSchema', () => {
    expect(() =>
      tunnelMessageSchema.parse({
        type: 'config_dispatch',
        payload: {
          hostId: 'host-1',
          generation: 5,
          desired: {
            hostId: 'host-1',
            generation: 5,
            services: [],
            updatedAt: Date.now(),
          },
          dispatchedAt: Date.now(),
          idempotencyKey: 'dispatch-1',
        },
      }),
    ).toThrow()
  })

  test('requires error reason for failed dispatch acknowledgements', () => {
    expect(() =>
      configDispatchStatusSchema.parse({
        generation: 6,
        status: 'error',
        acknowledgedAt: Date.now(),
      }),
    ).toThrow()

    const ok = configDispatchStatusSchema.parse({
      generation: 6,
      status: 'applied',
      acknowledgedAt: Date.now(),
    })

    expect(ok.status).toBe('applied')
  })
})
