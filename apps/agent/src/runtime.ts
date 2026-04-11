import type { AgentConfig } from '@utunnel/config'
import type { ServiceBindingPayload, ServiceDefinition } from '@utunnel/protocol'
import { buildHostToken } from '../../edge/src/lib'

export type RuntimeState = {
  sessionId: string
  version: number
  previousSessionId?: string
}

const createSessionId = () => `session-${crypto.randomUUID()}`

export const createNextRuntimeState = (current?: RuntimeState): RuntimeState => {
  if (!current) {
    return {
      sessionId: createSessionId(),
      version: 1,
    }
  }

  return {
    sessionId: createSessionId(),
    version: current.version + 1,
    previousSessionId: current.sessionId,
  }
}

export const buildServiceBindingPayload = (
  state: RuntimeState,
  services: ServiceDefinition[],
): ServiceBindingPayload => ({
  sessionId: state.sessionId,
  version: state.version,
  services,
})

export const resolveRegistrationPath = (state: RuntimeState): 'services' | 'rebind' => {
  return state.previousSessionId ? 'rebind' : 'services'
}

export const createDefaultAgentConfig = (): AgentConfig => ({
  hostId: 'host-dev',
  hostname: 'host-dev',
  token: buildHostToken('host-dev', 'dev-operator-token'),
  edgeBaseUrl: 'http://127.0.0.1:8787',
  reconnectDelayMs: 3000,
  maxReconnectAttempts: 5,
  services: [
    {
      serviceId: 'svc-dev',
      serviceName: 'dev-http',
      localUrl: 'http://127.0.0.1:3000',
      protocol: 'http',
      subdomain: 'dev-http.example.test',
    },
  ],
})
