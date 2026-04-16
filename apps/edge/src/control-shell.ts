import { parseEdgeEnv } from '@utunnel/config'
import type { RoutingEntry, ServiceReachability } from '@utunnel/protocol'
import {
  listControlPlaneHosts,
  listServiceReachabilitySummaries,
  type ControlPlaneServiceReachabilitySummary,
} from './control-plane'
import type { EdgeBindings } from './types'

const SESSION_COOKIE_NAME = 'utunnel_session'
const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000

export type ControlShellConfig = {
  uiPassword: string
  sessionSecret: string
  sessionTtlMs: number
}

export type ControlShellUser = {
  id: string
}

type ControlShellSession = {
  userId: string
  expiresAt: number
}

export type DashboardSummary = {
  hostCount: number
  onlineHostCount: number
  routeCount: number
  unhealthyHostCount: number
  pendingBootstrapCount: number
  desiredDriftCount: number
  reachableServiceCount: number
  degradedServiceCount: number
  unreachableServiceCount: number
  staleServiceCount: number
  recentHosts: Array<{
    hostId: string
    healthy: boolean
    disconnectedAt: number | null
    lastHeartbeatAt: number | null
    serviceCount: number
    desiredGeneration: number | null
    currentGeneration: number | null
    currentStatus: 'pending' | 'acknowledged' | 'error' | null
    appliedGeneration: number | null
    projectedRouteCount: number
    problematicServiceCount: number
    staleServiceCount: number
  }>
  problemServices: Array<{
    hostId: string
    serviceId: string
    serviceName: string
    subdomain: string
    reachability: ServiceReachability
    checkedAt: number | null
    currentStatus: 'pending' | 'acknowledged' | 'error' | null
    runtimeHealthy: boolean | null
  }>
}

const getRoutingStub = (env: EdgeBindings) => {
  return env.ROUTING_DIRECTORY.get(env.ROUTING_DIRECTORY.idFromName('global'))
}


const REACHABILITY_STALE_MS = 15 * 60 * 1000

const isReachabilityStale = (checkedAt: number | null) => {
  if (checkedAt === null) {
    return false
  }
  return Date.now() - checkedAt > REACHABILITY_STALE_MS
}

const countProblematicServices = (summaries: ControlPlaneServiceReachabilitySummary[]) => {
  return summaries.filter((summary) => {
    if (isReachabilityStale(summary.checkedAt)) {
      return true
    }
    return summary.reachability === 'degraded' || summary.reachability === 'unreachable'
  }).length
}

const countStaleServices = (summaries: ControlPlaneServiceReachabilitySummary[]) => {
  return summaries.filter((summary) => isReachabilityStale(summary.checkedAt)).length
}

const encodeBase64Url = (value: string) => {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

const decodeBase64Url = (value: string) => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  return atob(padded)
}

const signSessionPayload = async (payload: string, secret: string) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

const constantTimeEqual = (left: string, right: string) => {
  if (left.length !== right.length) {
    return false
  }

  let diff = 0
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }

  return diff === 0
}

const readCookie = (request: Request, name: string) => {
  const cookieHeader = request.headers.get('cookie')
  if (!cookieHeader) {
    return null
  }

  for (const part of cookieHeader.split(';')) {
    const [cookieName, ...cookieValueParts] = part.trim().split('=')
    if (cookieName === name) {
      return cookieValueParts.join('=')
    }
  }

  return null
}

const createSessionToken = async (userId: string, secret: string, ttlMs: number, now = Date.now()) => {
  const payload = encodeBase64Url(
    JSON.stringify({
      userId,
      expiresAt: now + ttlMs,
    } satisfies ControlShellSession),
  )
  const signature = await signSessionPayload(payload, secret)
  return `${payload}.${signature}`
}

const verifySessionToken = async (token: string, secret: string, now = Date.now()): Promise<ControlShellSession | null> => {
  const [payload, signature] = token.split('.')
  if (!payload || !signature) {
    return null
  }

  const expectedSignature = await signSessionPayload(payload, secret)
  if (!constantTimeEqual(signature, expectedSignature)) {
    return null
  }

  try {
    const session = JSON.parse(decodeBase64Url(payload)) as ControlShellSession
    if (session.expiresAt <= now || session.userId.length === 0) {
      return null
    }
    return session
  } catch {
    return null
  }
}

export const getControlShellConfig = (env: EdgeBindings): ControlShellConfig | null => {
  const parsed = parseEdgeEnv(env)
  if (!parsed.UI_PASSWORD || !parsed.SESSION_SECRET) {
    return null
  }

  return {
    uiPassword: parsed.UI_PASSWORD,
    sessionSecret: parsed.SESSION_SECRET,
    sessionTtlMs: parsed.SESSION_TTL_MS ?? DEFAULT_SESSION_TTL_MS,
  }
}

export const buildSessionCookie = (token: string, ttlMs: number) => {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}`
}

export const buildClearedSessionCookie = () => {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

export const loginControlShell = async (env: EdgeBindings, password: string) => {
  const config = getControlShellConfig(env)
  if (!config) {
    return { ok: false as const, reason: 'control_shell_not_configured' }
  }

  if (password !== config.uiPassword) {
    return { ok: false as const, reason: 'invalid_credentials' }
  }

  const user: ControlShellUser = { id: 'personal' }
  const token = await createSessionToken(user.id, config.sessionSecret, config.sessionTtlMs)

  return {
    ok: true as const,
    user,
    setCookie: buildSessionCookie(token, config.sessionTtlMs),
  }
}

export const logoutControlShell = (env: EdgeBindings) => {
  const config = getControlShellConfig(env)
  if (!config) {
    return { ok: false as const, reason: 'control_shell_not_configured' }
  }

  return {
    ok: true as const,
    setCookie: buildClearedSessionCookie(),
  }
}

export const getAuthenticatedControlShellUser = async (request: Request, env: EdgeBindings): Promise<ControlShellUser | null> => {
  const config = getControlShellConfig(env)
  if (!config) {
    return null
  }

  const token = readCookie(request, SESSION_COOKIE_NAME)
  if (!token) {
    return null
  }

  const session = await verifySessionToken(token, config.sessionSecret)
  if (!session) {
    return null
  }

  return { id: session.userId }
}

export const summarizeDashboard = async (env: EdgeBindings): Promise<DashboardSummary> => {
  const hosts = await listControlPlaneHosts(env)
  const reachabilitySummaries = await listServiceReachabilitySummaries(env)
  const routesResponse = await getRoutingStub(env).fetch('https://routing.internal/list')
  const routes = (await routesResponse.json()) as RoutingEntry[]

  const reachabilityByHostId = new Map<string, ControlPlaneServiceReachabilitySummary[]>()
  for (const summary of reachabilitySummaries) {
    const current = reachabilityByHostId.get(summary.hostId)
    if (current) {
      current.push(summary)
    } else {
      reachabilityByHostId.set(summary.hostId, [summary])
    }
  }

  const recentHosts = [...hosts]
    .map((host) => {
      const hostSummaries = reachabilityByHostId.get(host.hostId) ?? []
      const lastSeenAt = Math.max(
        host.runtime?.disconnectedAt ?? 0,
        host.runtime?.lastHeartbeatAt ?? 0,
        host.bootstrap?.claimedAt ?? 0,
        host.bootstrap?.issuedAt ?? 0,
        host.applied?.appliedAt ?? 0,
        host.current?.reportedAt ?? 0,
      )

      return {
        hostId: host.hostId,
        healthy: host.runtime?.healthy ?? false,
        disconnectedAt: host.runtime?.disconnectedAt ?? null,
        lastHeartbeatAt: host.runtime?.lastHeartbeatAt ?? null,
        serviceCount: host.runtime?.serviceCount ?? host.applied?.services.length ?? host.desired?.services.length ?? 0,
        desiredGeneration: host.desired?.generation ?? null,
        currentGeneration: host.current?.generation ?? null,
        currentStatus: host.current?.status ?? null,
        appliedGeneration: host.applied?.generation ?? null,
        projectedRouteCount: host.projectedRoutes.length,
        problematicServiceCount: countProblematicServices(hostSummaries),
        staleServiceCount: countStaleServices(hostSummaries),
        lastSeenAt,
      }
    })
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .map(({ lastSeenAt: _lastSeenAt, ...host }) => host)

  const problemServices = reachabilitySummaries
    .filter((summary) => {
      if (isReachabilityStale(summary.checkedAt)) {
        return true
      }
      return summary.reachability === 'degraded' || summary.reachability === 'unreachable'
    })
    .sort((left, right) => {
      const leftScore = isReachabilityStale(left.checkedAt) ? 2 : left.reachability === 'unreachable' ? 1 : 0
      const rightScore = isReachabilityStale(right.checkedAt) ? 2 : right.reachability === 'unreachable' ? 1 : 0
      if (rightScore !== leftScore) {
        return rightScore - leftScore
      }
      return (right.checkedAt ?? 0) - (left.checkedAt ?? 0)
    })
    .slice(0, 8)
    .map((summary) => ({
      hostId: summary.hostId,
      serviceId: summary.serviceId,
      serviceName: summary.serviceName,
      subdomain: summary.subdomain,
      reachability: isReachabilityStale(summary.checkedAt) ? 'unknown' : summary.reachability,
      checkedAt: summary.checkedAt,
      currentStatus: summary.currentStatus,
      runtimeHealthy: summary.runtime?.healthy ?? null,
    }))

  return {
    hostCount: hosts.length,
    onlineHostCount: hosts.filter((host) => host.runtime?.healthy).length,
    routeCount: routes.length,
    unhealthyHostCount: hosts.filter((host) => host.runtime && !host.runtime.healthy).length,
    pendingBootstrapCount: hosts.filter((host) => host.bootstrap && host.bootstrap.claimedAt === null).length,
    desiredDriftCount: hosts.filter((host) => {
      if (!host.desired) {
        return false
      }
      if (!host.applied) {
        return true
      }
      return host.desired.generation !== host.applied.generation
    }).length,
    reachableServiceCount: reachabilitySummaries.filter((summary) => !isReachabilityStale(summary.checkedAt) && summary.reachability === 'reachable').length,
    degradedServiceCount: reachabilitySummaries.filter((summary) => !isReachabilityStale(summary.checkedAt) && summary.reachability === 'degraded').length,
    unreachableServiceCount: reachabilitySummaries.filter((summary) => !isReachabilityStale(summary.checkedAt) && summary.reachability === 'unreachable').length,
    staleServiceCount: countStaleServices(reachabilitySummaries),
    recentHosts,
    problemServices,
  }
}
