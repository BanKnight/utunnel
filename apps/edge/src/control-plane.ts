import { parseEdgeEnv } from '@utunnel/config'
import type {
  AppliedHostConfig,
  CurrentHostConfig,
  DesiredHostConfig,
  HostSessionRecord,
  RoutingEntry,
  ServiceDefinition,
  ServiceProbeRecord,
  ServiceProbeResult,
  ServiceReachability,
} from '@utunnel/protocol'
import { configDispatchMessageSchema, serviceDefinitionSchema } from '@utunnel/protocol'
import { z } from 'zod'
import { isHostnameInRootDomain, isSessionHealthy, normalizeServiceDefinitions } from './lib'
import { deriveServiceReachability } from './reachability'
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

export type ControlPlaneServiceReachabilitySummary = {
  hostId: string
  serviceId: string
  serviceName: string
  subdomain: string
  protocol: ServiceDefinition['protocol']
  reachability: ServiceReachability
  checkedAt: number | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  recentResults: ServiceProbeResult[]
  hasProjectedRoute: boolean
  desiredGeneration: number | null
  currentGeneration: number | null
  currentStatus: CurrentHostConfig['status'] | null
  appliedGeneration: number | null
  runtime: {
    healthy: boolean
    lastHeartbeatAt: number | null
    disconnectedAt: number | null
  } | null
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

export const normalizeAndValidateDesiredServices = (env: EdgeBindings, servicesInput: unknown) => {
  const services = z.array(serviceDefinitionSchema).parse(servicesInput)
  const normalizedServices = normalizeServiceDefinitions(services)

  for (const service of normalizedServices) {
    if (!isHostnameInRootDomain(service.subdomain, env.ROOT_DOMAIN)) {
      throw new Error(`service_outside_root_domain:${service.subdomain}`)
    }
  }

  return normalizedServices
}

type ServiceReachabilitySummaryBase = Pick<
  ControlPlaneServiceReachabilitySummary,
  | 'hostId'
  | 'serviceId'
  | 'serviceName'
  | 'subdomain'
  | 'protocol'
  | 'reachability'
  | 'checkedAt'
  | 'lastSuccessAt'
  | 'lastFailureAt'
  | 'recentResults'
>

type ReachabilityServiceTarget = {
  hostId: string
  service: ServiceDefinition
}

type ReachabilityAnalyticsConfig = {
  accountId: string
  apiToken: string
  dataset: string
}

type ReachabilityAnalyticsRow = {
  hostId?: unknown
  serviceId?: unknown
  checkedAt?: unknown
  statusCode?: unknown
  latencyMs?: unknown
  successState?: unknown
  failureKind?: unknown
}

const REACHABILITY_ANALYTICS_RECENT_RESULTS_LIMIT = 5

const getReachabilityAnalyticsConfig = (
  edgeEnv: ReturnType<typeof parseEdgeEnv>,
): ReachabilityAnalyticsConfig | null => {
  if (
    !edgeEnv.REACHABILITY_ANALYTICS_ACCOUNT_ID ||
    !edgeEnv.REACHABILITY_ANALYTICS_API_TOKEN ||
    !edgeEnv.REACHABILITY_ANALYTICS_DATASET
  ) {
    return null
  }

  return {
    accountId: edgeEnv.REACHABILITY_ANALYTICS_ACCOUNT_ID,
    apiToken: edgeEnv.REACHABILITY_ANALYTICS_API_TOKEN,
    dataset: edgeEnv.REACHABILITY_ANALYTICS_DATASET,
  }
}

const toSqlIdentifier = (value: string) => {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error('invalid_reachability_analytics_dataset')
  }

  return value
}

const toSqlStringLiteral = (value: string) => {
  return `'${value.replaceAll("'", "''")}'`
}

const toOptionalNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  return undefined
}

const toOptionalStatusCode = (value: unknown) => {
  const parsed = toOptionalNumber(value)
  if (parsed === undefined || !Number.isInteger(parsed) || parsed < 100 || parsed > 599) {
    return undefined
  }

  return parsed
}

const toOptionalFailureKind = (value: unknown): ServiceProbeRecord['failureKind'] => {
  switch (value) {
    case 'timeout':
    case 'dns':
    case 'edge':
    case 'upstream':
    case 'status-code':
    case 'unknown':
      return value
    default:
      return undefined
  }
}

const queryReachabilityAnalyticsEngine = async <Row>(config: ReachabilityAnalyticsConfig, sql: string): Promise<Row[]> => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/analytics_engine/sql`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiToken}`,
        'content-type': 'text/plain',
      },
      body: sql,
    },
  )

  if (!response.ok) {
    throw new Error(`reachability_analytics_query_failed:${response.status}`)
  }

  const json = (await response.json()) as {
    rows?: Row[]
    data?: Row[]
  }

  if (Array.isArray(json.rows)) {
    return json.rows
  }

  if (Array.isArray(json.data)) {
    return json.data
  }

  throw new Error('invalid_reachability_analytics_response')
}

const buildServiceReachabilitySummaryBase = (
  hostId: string,
  service: ServiceDefinition,
  recentRecords: ServiceProbeRecord[],
): ServiceReachabilitySummaryBase => {
  const recentResults: ServiceProbeResult[] = recentRecords.map((record) => ({
    checkedAt: record.checkedAt,
    success: record.success,
    statusCode: record.statusCode,
    latencyMs: record.latencyMs,
    failureKind: record.failureKind,
  }))
  const lastSuccess = recentResults.find((result) => result.success) ?? null
  const lastFailure = recentResults.find((result) => !result.success) ?? null

  return {
    hostId,
    serviceId: service.serviceId,
    serviceName: service.serviceName,
    subdomain: service.subdomain,
    protocol: service.protocol,
    reachability: deriveServiceReachability(recentRecords),
    checkedAt: recentResults[0]?.checkedAt ?? null,
    lastSuccessAt: lastSuccess?.checkedAt ?? null,
    lastFailureAt: lastFailure?.checkedAt ?? null,
    recentResults,
  }
}

const listReachabilitySummaryBasesFromRoutingDirectory = async (
  env: EdgeBindings,
): Promise<ServiceReachabilitySummaryBase[]> => {
  const response = await getControlPlaneStub(env).fetch('https://routing.internal/control/services/reachability')
  return readJson<ServiceReachabilitySummaryBase[]>(response)
}

const listReachabilitySummaryBasesFromAnalyticsEngine = async (
  edgeEnv: ReturnType<typeof parseEdgeEnv>,
  services: ReachabilityServiceTarget[],
): Promise<ServiceReachabilitySummaryBase[]> => {
  const config = getReachabilityAnalyticsConfig(edgeEnv)
  if (!config || services.length === 0) {
    return []
  }

  const dataset = toSqlIdentifier(config.dataset)
  const serviceByKey = new Map<string, ServiceDefinition>(
    services.map(({ hostId, service }) => [`${hostId}:${service.serviceId}`, service]),
  )
  const rows = await queryReachabilityAnalyticsEngine<ReachabilityAnalyticsRow>(
    config,
    [
      'SELECT',
      '  blob1 AS hostId,',
      '  index1 AS serviceId,',
      '  double3 AS checkedAt,',
      '  double1 AS statusCode,',
      '  double2 AS latencyMs,',
      '  blob5 AS successState,',
      '  blob6 AS failureKind',
      `FROM ${dataset}`,
      `WHERE ${services.map(({ hostId, service }) => `(blob1 = ${toSqlStringLiteral(hostId)} AND index1 = ${toSqlStringLiteral(service.serviceId)})`).join(' OR ')}`,
      'ORDER BY double3 DESC',
    ].join('\n'),
  )

  const recentRecordsByKey = new Map<string, ServiceProbeRecord[]>()
  for (const row of rows) {
    if (typeof row.hostId !== 'string' || typeof row.serviceId !== 'string') {
      throw new Error('invalid_reachability_analytics_row_identity')
    }

    const key = `${row.hostId}:${row.serviceId}`
    if (!serviceByKey.has(key)) {
      continue
    }

    const existing = recentRecordsByKey.get(key) ?? []
    if (existing.length >= REACHABILITY_ANALYTICS_RECENT_RESULTS_LIMIT) {
      continue
    }

    const checkedAt = toOptionalNumber(row.checkedAt)
    if (checkedAt === undefined || !Number.isInteger(checkedAt) || checkedAt < 0) {
      throw new Error('invalid_reachability_analytics_row_checked_at')
    }

    if (row.successState !== 'ok' && row.successState !== 'fail') {
      throw new Error('invalid_reachability_analytics_row_success_state')
    }

    const failureKind = toOptionalFailureKind(row.failureKind)
    existing.push(
      row.successState === 'ok'
        ? {
            hostId: row.hostId,
            serviceId: row.serviceId,
            checkedAt,
            success: true,
            statusCode: toOptionalStatusCode(row.statusCode),
            latencyMs: toOptionalNumber(row.latencyMs),
          }
        : {
            hostId: row.hostId,
            serviceId: row.serviceId,
            checkedAt,
            success: false,
            statusCode: toOptionalStatusCode(row.statusCode),
            latencyMs: toOptionalNumber(row.latencyMs),
            failureKind: failureKind ?? 'unknown',
          },
    )
    recentRecordsByKey.set(key, existing)
  }

  return services
    .map(({ hostId, service }) =>
      buildServiceReachabilitySummaryBase(hostId, service, recentRecordsByKey.get(`${hostId}:${service.serviceId}`) ?? []),
    )
    .sort((left, right) => {
      if (left.hostId !== right.hostId) {
        return left.hostId.localeCompare(right.hostId)
      }

      return left.serviceId.localeCompare(right.serviceId)
    })
}

function buildConfigDispatchMessage(
  hostId: string,
  desired: DesiredHostConfig,
): ReturnType<typeof configDispatchMessageSchema.parse> {
  return configDispatchMessageSchema.parse({
    type: 'config_dispatch',
    payload: {
      hostId,
      generation: desired.generation,
      desired,
      dispatchedAt: Date.now(),
      idempotencyKey: crypto.randomUUID(),
    },
  })
}

export const dispatchDesiredConfigToHost = async (env: EdgeBindings, hostId: string) => {
  const desired = await getDesiredHostConfig(env, hostId)
  if (!desired) {
    return { ok: true as const, dispatched: false as const }
  }

  const hostStub = getHostStub(env, hostId)
  const response = await hostStub.fetch(
    toJsonRequest('https://host.internal/control/dispatch', buildConfigDispatchMessage(hostId, desired)),
  )

  if (!response.ok) {
    return { ok: false as const, status: response.status }
  }

  return { ok: true as const, dispatched: true as const, generation: desired.generation }
}

export const redispatchDesiredConfigToHost = async (
  env: EdgeBindings,
  hostId: string,
): Promise<ControlPlaneMutationResult<{ generation: number }>> => {
  const desired = await getDesiredHostConfig(env, hostId)
  if (!desired) {
    return { ok: false, status: 409, reason: 'desired_not_found' }
  }

  const edgeEnv = parseEdgeEnv(env)
  const hostStub = getHostStub(env, hostId)
  const hostSessionResponse = await hostStub.fetch('https://host.internal/session')
  const session = (await readJson<HostSessionRecord | null>(hostSessionResponse)) ?? null
  if (!session || !isSessionHealthy(session, edgeEnv.HEARTBEAT_GRACE_MS)) {
    return { ok: false, status: 409, reason: 'runtime_unhealthy' }
  }

  const dispatchResult = await readMutationResult<{ ok: true }>(
    await hostStub.fetch(
      toJsonRequest('https://host.internal/control/dispatch', buildConfigDispatchMessage(hostId, desired)),
    ),
  )

  if (!dispatchResult.ok) {
    return dispatchResult
  }

  return {
    ok: true,
    value: {
      generation: desired.generation,
    },
  }
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

export const listServiceReachabilitySummaries = async (
  env: EdgeBindings,
): Promise<ControlPlaneServiceReachabilitySummary[]> => {
  const edgeEnv = parseEdgeEnv(env)
  const controlStates = await listHostControlStates(env)
  const stateByHostId = new Map(controlStates.map((state) => [state.hostId, state]))
  const hostIds = Array.from(new Set(controlStates.map((state) => state.hostId)))
  const hostSessions = await Promise.all(
    hostIds.map(async (hostId) => {
      const hostSessionResponse = await getHostStub(env, hostId).fetch('https://host.internal/session')
      const session = (await readJson<HostSessionRecord | null>(hostSessionResponse)) ?? null
      return [hostId, session] as const
    }),
  )
  const sessionByHostId = new Map(hostSessions)
  const serviceTargets = controlStates.flatMap((state) =>
    (state.applied?.services ?? []).map((service) => ({ hostId: state.hostId, service })),
  )

  let summaries: ServiceReachabilitySummaryBase[]
  if (getReachabilityAnalyticsConfig(edgeEnv)) {
    try {
      summaries = await listReachabilitySummaryBasesFromAnalyticsEngine(edgeEnv, serviceTargets)
    } catch (error) {
      console.error('reachability_analytics_read_failed', {
        error: error instanceof Error ? error.message : 'unknown_error',
      })
      summaries = await listReachabilitySummaryBasesFromRoutingDirectory(env)
    }
  } else {
    summaries = await listReachabilitySummaryBasesFromRoutingDirectory(env)
  }

  return summaries.map((summary) => {
    const state = stateByHostId.get(summary.hostId) ?? null
    const session = sessionByHostId.get(summary.hostId) ?? null

    return {
      ...summary,
      hasProjectedRoute:
        state?.projectedRoutes.some((route) => route.serviceId === summary.serviceId && route.hostname === summary.subdomain) ?? false,
      desiredGeneration: state?.desired?.services.some((service) => service.serviceId === summary.serviceId)
        ? state.desired?.generation ?? null
        : null,
      currentGeneration: state?.current?.services.some((service) => service.serviceId === summary.serviceId)
        ? state.current?.generation ?? null
        : null,
      currentStatus: state?.current?.services.some((service) => service.serviceId === summary.serviceId)
        ? state.current?.status ?? null
        : null,
      appliedGeneration: state?.applied?.services.some((service) => service.serviceId === summary.serviceId)
        ? state.applied?.generation ?? null
        : null,
      runtime: session
        ? {
            healthy: isSessionHealthy(session, edgeEnv.HEARTBEAT_GRACE_MS),
            lastHeartbeatAt: session.lastHeartbeatAt,
            disconnectedAt: session.disconnectedAt,
          }
        : null,
    } satisfies ControlPlaneServiceReachabilitySummary
  })
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
