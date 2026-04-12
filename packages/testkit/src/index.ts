import { createHash } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

export const buildHostToken = (hostId: string, operatorToken: string): string => {
  return createHash('sha256').update(`${hostId}:${operatorToken}`).digest('hex')
}

type DemoServicePorts = {
  host1Http: number
  host2Http: number
  host3Http: number
  host3Ws: number
}

const defaultDemoServicePorts: DemoServicePorts = {
  host1Http: 4101,
  host2Http: 4102,
  host3Http: 4103,
  host3Ws: 4203,
}

export const createV1DemoAgentConfigs = (
  edgeBaseUrl: string,
  rootDomain: string,
  operatorToken: string,
  servicePorts: DemoServicePorts = defaultDemoServicePorts,
  suffix = 'demo',
): AgentConfig[] => {
  return [
    createMockAgentConfig({
      hostId: `host-1-${suffix}`,
      hostname: `demo-host-1-${suffix}`,
      token: buildHostToken(`host-1-${suffix}`, operatorToken),
      edgeBaseUrl,
      reconnectDelayMs: 60000,
      maxReconnectAttempts: 1,
      services: [
        {
          serviceId: `svc-host-1-http-${suffix}`,
          serviceName: `host-1-http-${suffix}`,
          localUrl: `http://127.0.0.1:${servicePorts.host1Http}`,
          protocol: 'http',
          subdomain: `host-1-http-${suffix}.${rootDomain}`,
        },
      ],
    }),
    createMockAgentConfig({
      hostId: `host-2-${suffix}`,
      hostname: `demo-host-2-${suffix}`,
      token: buildHostToken(`host-2-${suffix}`, operatorToken),
      edgeBaseUrl,
      reconnectDelayMs: 60000,
      maxReconnectAttempts: 1,
      services: [
        {
          serviceId: `svc-host-2-http-${suffix}`,
          serviceName: `host-2-http-${suffix}`,
          localUrl: `http://127.0.0.1:${servicePorts.host2Http}`,
          protocol: 'http',
          subdomain: `host-2-http-${suffix}.${rootDomain}`,
        },
      ],
    }),
    createMockAgentConfig({
      hostId: `host-3-${suffix}`,
      hostname: `demo-host-3-${suffix}`,
      token: buildHostToken(`host-3-${suffix}`, operatorToken),
      edgeBaseUrl,
      reconnectDelayMs: 60000,
      maxReconnectAttempts: 1,
      services: [
        {
          serviceId: `svc-host-3-http-${suffix}`,
          serviceName: `host-3-http-${suffix}`,
          localUrl: `http://127.0.0.1:${servicePorts.host3Http}`,
          protocol: 'http',
          subdomain: `host-3-http-${suffix}.${rootDomain}`,
        },
        {
          serviceId: `svc-host-3-ws-${suffix}`,
          serviceName: `host-3-ws-${suffix}`,
          localUrl: `http://127.0.0.1:${servicePorts.host3Ws}`,
          protocol: 'websocket',
          subdomain: `host-3-ws-${suffix}.${rootDomain}`,
        },
      ],
    }),
  ]
}

export const createTempDemoConfigDir = async (configs: AgentConfig[]) => {
  const dir = join(tmpdir(), `utunnel-v1-demo-${Date.now()}`)
  await mkdir(dir, { recursive: true })

  const configPaths: string[] = []
  for (const config of configs) {
    const filePath = join(dir, `${config.hostId}.json`)
    await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    configPaths.push(filePath)
  }

  return {
    dir,
    configPaths,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true })
    },
  }
}
