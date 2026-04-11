import type { AgentConfig } from '@utunnel/config'
import type { RoutingEntry, ServiceDefinition } from '@utunnel/protocol'

export const createMockAgentConfig = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  hostId: overrides.hostId ?? 'host-1',
  hostname: overrides.hostname ?? 'machine-1',
  token: overrides.token ?? 'dev-token',
  edgeBaseUrl: overrides.edgeBaseUrl ?? 'http://127.0.0.1:8787',
  reconnectDelayMs: overrides.reconnectDelayMs ?? 3000,
  maxReconnectAttempts: overrides.maxReconnectAttempts ?? 5,
  services: overrides.services ?? [
    {
      serviceId: 'svc-1',
      serviceName: 'echo',
      localUrl: 'http://127.0.0.1:3001',
      protocol: 'http',
      subdomain: 'echo.example.test',
    },
  ],
})

export const createRoutingEntry = (
  service: ServiceDefinition,
  hostId = 'host-1',
  sessionId = 'session-1',
  version = 1,
): RoutingEntry => ({
  hostname: service.subdomain,
  hostId,
  serviceId: service.serviceId,
  sessionId,
  version,
  updatedAt: Date.now(),
})
