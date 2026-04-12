import { parseEdgeEnv } from '@utunnel/config'
import type {
  AppliedHostConfig,
  CurrentHostConfig,
  DesiredHostConfig,
  HostSessionRecord,
  RoutingEntry,
  ServiceDefinition,
} from '@utunnel/protocol'
import { isSessionHealthy, normalizeServiceDefinitions } from './lib'
import type { EdgeBindings, FetchStub } from './types'

export type AppliedRouteProjection = {
  hostId: string
  serviceId: string
  hostname: string
  generation: number
  projectedAt: number
}

export type HostControlState = {
  hostId: string
  desired: DesiredHostConfig | null
  current: CurrentHostConfig | null
  applied: AppliedHostConfig | null
  projectedRoutes: AppliedRouteProjection[]
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

export const buildAppliedRouteProjections = (applied: AppliedHostConfig | null): AppliedRouteProjection[] => {
  if (!applied) {
    return []
  }

  return applied.services.map((service) => ({
    hostId: applied.hostId,
    serviceId: service.serviceId,
    hostname: service.subdomain,
    generation: applied.generation,
    projectedAt: applied.appliedAt,
  }))
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
