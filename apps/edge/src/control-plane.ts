import { parseEdgeEnv } from '@utunnel/config'
import type {
  AppliedHostConfig,
  CurrentHostConfig,
  DesiredHostConfig,
  HostSessionRecord,
  RoutingEntry,
  ServiceDefinition,
} from '@utunnel/protocol'
import { configDispatchMessageSchema, serviceDefinitionSchema } from '@utunnel/protocol'
import { z } from 'zod'
import { isHostnameInRootDomain, isSessionHealthy, normalizeServiceDefinitions } from './lib'
import type { EdgeBindings, FetchStub } from './types'

export type AppliedRouteProjection = {
  hostId: string
  serviceId: string
  hostname: string
  generation: number
  projectedAt: number
}

export type BootstrapHostState = {
  hostname: string
  issuedAt: number
  expiresAt: number
  claimedAt: number | null
}

export type HostControlState = {
  hostId: string
  bootstrap: BootstrapHostState | null
  desired: DesiredHostConfig | null
  current: CurrentHostConfig | null
  applied: AppliedHostConfig | null
  projectedRoutes: AppliedRouteProjection[]
}

export type ControlApiTokenMetadata = {
  tokenId: string
  prefix: string
  label?: string
  createdAt: number
  rotatedAt: number | null
  revokedAt: number | null
  lastUsedAt: number | null
}

export type ControlApiTokenSecret = ControlApiTokenMetadata & {
  token: string
}

export type ControlPlaneHost = HostControlState & {
  runtime: {
    sessionId: string
    version: number
    healthy: boolean
    lastHeartbeatAt: number | null
    disconnectedAt: number | null
    serviceCount: number
  } | null
}

type ControlApiTokenCreateInput = {
  label?: string | undefined
}

type ControlPlaneMutationResult<T> =
  | {
      ok: true
      value: T
    }
  | {
      ok: false
      status: number
      reason: string
    }

type CurrentMutationInput = {
  generation: number
  status: 'pending' | 'acknowledged' | 'error'
  services: ServiceDefinition[]
  error?: string | undefined
}

type AppliedMutationInput = {
  generation: number
  services: ServiceDefinition[]
}

type BootstrapIssueResponse = {
  hostId: string
  hostname: string
  bootstrapToken: string
  issuedAt: number
  expiresAt: number
  claimedAt: number | null
}

export type BootstrapIssueResult = BootstrapIssueResponse & {
  command: string
}

type BootstrapIssueInput = {
  hostId: string
  hostname: string
  edgeBaseUrl: string
  expiresInMs?: number
}

type BootstrapClaimInput = {
  hostId: string
  hostname: string
  bootstrapToken: string
}

type BootstrapClaimResult = {
  ok: true
  hostId: string
  token: string
  claimedAt: number
}

const toJsonRequest = (url: string, body: unknown, method = 'POST') => {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const getControlPlaneStub = (env: EdgeBindings): FetchStub => {
  return env.ROUTING_DIRECTORY.get(env.ROUTING_DIRECTORY.idFromName('global'))
}

const getHostStub = (env: EdgeBindings, hostId: string): FetchStub => {
  return env.HOST_SESSION.get(env.HOST_SESSION.idFromName(hostId))
}

const readJson = async <T>(response: Response): Promise<T> => {
  return (await response.json()) as T
}

const readMutationResult = async <T>(response: Response): Promise<ControlPlaneMutationResult<T>> => {
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { reason?: string; error?: string } | null
    return {
      ok: false,
      status: response.status,
      reason: body?.reason ?? body?.error ?? 'control_plane_error',
    }
  }

  return {
    ok: true,
    value: await readJson<T>(response),
  }
}

const buildBootstrapCommand = (input: {
  hostId: string
  hostname: string
  bootstrapToken: string
  edgeBaseUrl: string
}) => {
  const config = {
    hostId: input.hostId,
    hostname: input.hostname,
    bootstrapToken: input.bootstrapToken,
    edgeBaseUrl: input.edgeBaseUrl,
    services: [],
  }

  return [
    "cat > agent.config.json <<'EOF'",
    JSON.stringify(config, null, 2),
    'EOF',
    'UTUNNEL_AGENT_CONFIG=agent.config.json bun --cwd apps/agent run dev',
  ].join('\n')
}

const normalizeAndValidateDesiredServices = (env: EdgeBindings, servicesInput: unknown) => {
  const services = z.array(serviceDefinitionSchema).parse(servicesInput)
  const normalizedServices = normalizeServiceDefinitions(services)

  for (const service of normalizedServices) {
    if (!isHostnameInRootDomain(service.subdomain, env.ROOT_DOMAIN)) {
      throw new Error(`service_outside_root_domain:${service.subdomain}`)
    }
  }

  return normalizedServices
}

export const dispatchDesiredConfigToHost = async (env: EdgeBindings, hostId: string) => {
  const desired = await getDesiredHostConfig(env, hostId)
  if (!desired) {
    return { ok: true as const, dispatched: false as const }
  }

  const message = configDispatchMessageSchema.parse({
    type: 'config_dispatch',
    payload: {
      hostId,
      generation: desired.generation,
      desired,
      dispatchedAt: Date.now(),
      idempotencyKey: crypto.randomUUID(),
    },
  })

  const response = await getHostStub(env, hostId).fetch(
    toJsonRequest('https://host.internal/control/dispatch', message),
  )

  if (!response.ok) {
    return { ok: false as const, status: response.status }
  }

  return { ok: true as const, dispatched: true as const, generation: desired.generation }
}

export const applyDesiredHostServices = async (
  env: EdgeBindings,
  hostId: string,
  servicesInput: unknown,
): Promise<ControlPlaneMutationResult<DesiredHostConfig>> => {
  const services = normalizeAndValidateDesiredServices(env, servicesInput)
  const result = await upsertDesiredHostServices(env, hostId, services)
  if (!result.ok) {
    return result
  }

  await dispatchDesiredConfigToHost(env, hostId)
  return result
}

export const getHostControlState = async (env: EdgeBindings, hostId: string): Promise<HostControlState | null> => {
  const response = await getControlPlaneStub(env).fetch(`https://routing.internal/control/hosts/${encodeURIComponent(hostId)}`)
  if (response.status === 404) {
    return null
  }

  return readJson<HostControlState>(response)
}

export const getDesiredHostConfig = async (env: EdgeBindings, hostId: string): Promise<DesiredHostConfig | null> => {
  const state = await getHostControlState(env, hostId)
  return state?.desired ?? null
}

export const listHostControlStates = async (env: EdgeBindings): Promise<HostControlState[]> => {
  const response = await getControlPlaneStub(env).fetch('https://routing.internal/control/hosts')
  return readJson<HostControlState[]>(response)
}

export const listAppliedRouteProjections = async (env: EdgeBindings): Promise<AppliedRouteProjection[]> => {
  const response = await getControlPlaneStub(env).fetch('https://routing.internal/control/routes')
  return readJson<AppliedRouteProjection[]>(response)
}

export const upsertDesiredHostServices = async (
  env: EdgeBindings,
  hostId: string,
  services: ServiceDefinition[],
): Promise<ControlPlaneMutationResult<DesiredHostConfig>> => {
  const response = await getControlPlaneStub(env).fetch(
    toJsonRequest(
      `https://routing.internal/control/hosts/${encodeURIComponent(hostId)}/desired`,
      { services: normalizeServiceDefinitions(services) },
      'PUT',
    ),
  )

  return readMutationResult<DesiredHostConfig>(response)
}

export const reportCurrentHostConfig = async (
  env: EdgeBindings,
  hostId: string,
  input: CurrentMutationInput,
): Promise<ControlPlaneMutationResult<CurrentHostConfig>> => {
  const response = await getControlPlaneStub(env).fetch(
    toJsonRequest(`https://routing.internal/control/hosts/${encodeURIComponent(hostId)}/current`, {
      ...input,
      services: normalizeServiceDefinitions(input.services),
    }),
  )

  return readMutationResult<CurrentHostConfig>(response)
}

export const promoteAppliedHostConfig = async (
  env: EdgeBindings,
  hostId: string,
  input: AppliedMutationInput,
): Promise<ControlPlaneMutationResult<AppliedHostConfig>> => {
  const response = await getControlPlaneStub(env).fetch(
    toJsonRequest(`https://routing.internal/control/hosts/${encodeURIComponent(hostId)}/applied`, {
      ...input,
      services: normalizeServiceDefinitions(input.services),
    }),
  )

  return readMutationResult<AppliedHostConfig>(response)
}

export const deleteHostControlState = async (
  env: EdgeBindings,
  hostId: string,
): Promise<ControlPlaneMutationResult<{ ok: true }>> => {
  const response = await getControlPlaneStub(env).fetch(
    new Request(`https://routing.internal/control/hosts/${encodeURIComponent(hostId)}`, {
      method: 'DELETE',
    }),
  )

  return readMutationResult<{ ok: true }>(response)
}

export const issueHostBootstrap = async (
  env: EdgeBindings,
  input: BootstrapIssueInput,
): Promise<ControlPlaneMutationResult<BootstrapIssueResult>> => {
  const response = await getControlPlaneStub(env).fetch(
    toJsonRequest(`https://routing.internal/control/hosts/${encodeURIComponent(input.hostId)}/bootstrap`, {
      hostname: input.hostname,
      expiresInMs: input.expiresInMs,
    }),
  )

  const result = await readMutationResult<BootstrapIssueResponse>(response)
  if (!result.ok) {
    return result
  }

  return {
    ok: true,
    value: {
      ...result.value,
      command: buildBootstrapCommand({
        hostId: result.value.hostId,
        hostname: result.value.hostname,
        bootstrapToken: result.value.bootstrapToken,
        edgeBaseUrl: input.edgeBaseUrl,
      }),
    },
  }
}

export const claimHostBootstrap = async (
  env: EdgeBindings,
  input: BootstrapClaimInput,
): Promise<ControlPlaneMutationResult<BootstrapClaimResult>> => {
  const response = await getControlPlaneStub(env).fetch(
    toJsonRequest(`https://routing.internal/control/hosts/${encodeURIComponent(input.hostId)}/claim`, {
      hostname: input.hostname,
      bootstrapToken: input.bootstrapToken,
    }),
  )

  return readMutationResult<BootstrapClaimResult>(response)
}

export const verifyHostAccessToken = async (env: EdgeBindings, hostId: string, token: string | null): Promise<boolean> => {
  if (!token) {
    return false
  }

  const response = await getControlPlaneStub(env).fetch(
    toJsonRequest(`https://routing.internal/control/hosts/${encodeURIComponent(hostId)}/token/verify`, { token }),
  )

  if (!response.ok) {
    return false
  }

  const json = (await response.json()) as { ok: boolean }
  return json.ok
}

export const verifyControlApiToken = async (env: EdgeBindings, token: string | null): Promise<boolean> => {
  if (!token) {
    return false
  }

  const response = await getControlPlaneStub(env).fetch(
    toJsonRequest('https://routing.internal/control/tokens/verify', { token }),
  )

  if (!response.ok) {
    return false
  }

  const json = (await response.json()) as { ok: boolean }
  return json.ok
}

export const listControlApiTokens = async (env: EdgeBindings): Promise<ControlApiTokenMetadata[]> => {
  const response = await getControlPlaneStub(env).fetch('https://routing.internal/control/tokens')
  return readJson<ControlApiTokenMetadata[]>(response)
}

export const createControlApiToken = async (
  env: EdgeBindings,
  input: ControlApiTokenCreateInput,
): Promise<ControlPlaneMutationResult<ControlApiTokenSecret>> => {
  const response = await getControlPlaneStub(env).fetch(
    toJsonRequest('https://routing.internal/control/tokens', input),
  )
  return readMutationResult<ControlApiTokenSecret>(response)
}

export const rotateControlApiToken = async (
  env: EdgeBindings,
  tokenId: string,
): Promise<ControlPlaneMutationResult<ControlApiTokenSecret>> => {
  const response = await getControlPlaneStub(env).fetch(
    toJsonRequest(`https://routing.internal/control/tokens/${encodeURIComponent(tokenId)}/rotate`, {}),
  )
  return readMutationResult<ControlApiTokenSecret>(response)
}

export const revokeControlApiToken = async (
  env: EdgeBindings,
  tokenId: string,
): Promise<ControlPlaneMutationResult<ControlApiTokenMetadata>> => {
  const response = await getControlPlaneStub(env).fetch(
    toJsonRequest(`https://routing.internal/control/tokens/${encodeURIComponent(tokenId)}/revoke`, {}),
  )
  return readMutationResult<ControlApiTokenMetadata>(response)
}

export const listControlPlaneHosts = async (env: EdgeBindings): Promise<ControlPlaneHost[]> => {
  const edgeEnv = parseEdgeEnv(env)
  const controlStates = await listHostControlStates(env)
  const routesResponse = await getControlPlaneStub(env).fetch('https://routing.internal/list')
  const routes = (await readJson<RoutingEntry[]>(routesResponse)).map((route) => route.hostId)

  const controlStateByHostId = new Map(controlStates.map((state) => [state.hostId, state]))
  const hostIds = Array.from(new Set([...controlStateByHostId.keys(), ...routes])).sort((left, right) =>
    left.localeCompare(right),
  )

  return Promise.all(
    hostIds.map(async (hostId) => {
      const baseState = controlStateByHostId.get(hostId) ?? {
        hostId,
        bootstrap: null,
        desired: null,
        current: null,
        applied: null,
        projectedRoutes: [],
      }

      const response = await getHostStub(env, hostId).fetch('https://host.internal/session')
      const session = (await readJson<HostSessionRecord | null>(response)) ?? null

      return {
        ...baseState,
        runtime: session
          ? {
              sessionId: session.sessionId,
              version: session.version,
              healthy: isSessionHealthy(session, edgeEnv.HEARTBEAT_GRACE_MS),
              lastHeartbeatAt: session.lastHeartbeatAt,
              disconnectedAt: session.disconnectedAt,
              serviceCount: session.services.length,
            }
          : null,
      } satisfies ControlPlaneHost
    }),
  )
}
