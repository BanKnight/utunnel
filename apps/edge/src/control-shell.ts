import { parseEdgeEnv } from '@utunnel/config'
import type { HostSessionRecord, RoutingEntry } from '@utunnel/protocol'
import { isSessionHealthy } from './lib'
import type { EdgeBindings, FetchStub } from './types'

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
  recentHosts: Array<{
    hostId: string
    healthy: boolean
    disconnectedAt: number | null
    lastHeartbeatAt: number | null
    serviceCount: number
  }>
}

const getRoutingStub = (env: EdgeBindings) => {
  return env.ROUTING_DIRECTORY.get(env.ROUTING_DIRECTORY.idFromName('global'))
}

const getHostStub = (env: EdgeBindings, hostId: string) => {
  return env.HOST_SESSION.get(env.HOST_SESSION.idFromName(hostId))
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
  const edgeEnv = parseEdgeEnv(env)
  const routing = getRoutingStub(env)
  const routesResponse = await routing.fetch('https://routing.internal/list')
  const routes = (await routesResponse.json()) as RoutingEntry[]
  const hostIds = Array.from(new Set(routes.map((route) => route.hostId)))

  const hosts = await Promise.all(
    hostIds.map(async (hostId) => {
      const hostStub = getHostStub(env, hostId)
      const response = await hostStub.fetch('https://host.internal/session')
      const session = (await response.json()) as HostSessionRecord | null
      const healthy = isSessionHealthy(session, edgeEnv.HEARTBEAT_GRACE_MS)
      const lastSeenAt = Math.max(session?.disconnectedAt ?? 0, session?.lastHeartbeatAt ?? 0, session?.connectedAt ?? 0)

      return {
        hostId,
        healthy,
        disconnectedAt: session?.disconnectedAt ?? null,
        lastHeartbeatAt: session?.lastHeartbeatAt ?? null,
        serviceCount: session?.services.length ?? 0,
        lastSeenAt,
      }
    }),
  )

  return {
    hostCount: hostIds.length,
    onlineHostCount: hosts.filter((host) => host.healthy).length,
    routeCount: routes.length,
    unhealthyHostCount: hosts.filter((host) => !host.healthy).length,
    recentHosts: hosts
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
      .map(({ lastSeenAt: _lastSeenAt, ...host }) => host),
  }
}
