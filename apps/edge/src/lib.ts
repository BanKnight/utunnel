import { createHash } from 'node:crypto'
import type { HostSessionRecord, RoutingEntry, ServiceBindingPayload, ServiceDefinition } from '@utunnel/protocol'

export const normalizeHostname = (hostname: string): string => {
  const trimmed = hostname.trim().toLowerCase().replace(/\.$/, '')
  const withoutPort = trimmed.split(':')[0] ?? ''
  return withoutPort
}

export const isHostnameInRootDomain = (hostname: string, rootDomain: string): boolean => {
  const normalizedHostname = normalizeHostname(hostname)
  const normalizedRootDomain = normalizeHostname(rootDomain)

  return (
    normalizedHostname.length > normalizedRootDomain.length &&
    normalizedHostname.endsWith(`.${normalizedRootDomain}`)
  )
}

export const normalizeServiceDefinition = (service: ServiceDefinition): ServiceDefinition => ({
  ...service,
  subdomain: normalizeHostname(service.subdomain),
})

export const normalizeServiceDefinitions = (services: ServiceDefinition[]): ServiceDefinition[] => {
  return services.map(normalizeServiceDefinition)
}

export const buildHostToken = (hostId: string, operatorToken: string): string => {
  return createHash('sha256').update(`${hostId}:${operatorToken}`).digest('hex')
}

export const extractBearerToken = (authorizationHeader?: string | null): string | null => {
  if (!authorizationHeader) {
    return null
  }

  return authorizationHeader.replace(/^Bearer\s+/i, '').trim()
}

export const isHostAuthorized = (token: string | null, hostId: string, operatorToken: string): boolean => {
  return token === buildHostToken(hostId, operatorToken)
}

export const isOperatorAuthorized = (token: string | null, operatorToken: string): boolean => {
  return token === operatorToken
}

export const hasHostnameConflict = (existing: RoutingEntry | null | undefined, next: RoutingEntry): boolean => {
  if (!existing) {
    return false
  }

  return existing.hostId !== next.hostId || existing.serviceId !== next.serviceId
}

export const buildRoutingEntry = (
  hostId: string,
  payload: ServiceBindingPayload,
  service: ServiceDefinition,
  now = Date.now(),
): RoutingEntry => ({
  hostname: normalizeHostname(service.subdomain),
  hostId,
  serviceId: service.serviceId,
  sessionId: payload.sessionId,
  version: payload.version,
  updatedAt: now,
})

export const buildHostSessionRecord = (
  hostId: string,
  payload: ServiceBindingPayload,
  now = Date.now(),
): HostSessionRecord => ({
  hostId,
  sessionId: payload.sessionId,
  version: payload.version,
  services: normalizeServiceDefinitions(payload.services),
  connectedAt: now,
  lastHeartbeatAt: now,
  disconnectedAt: null,
})

export const markSessionHeartbeat = (
  session: HostSessionRecord,
  now = Date.now(),
): HostSessionRecord => ({
  ...session,
  lastHeartbeatAt: now,
})

export const markSessionDisconnected = (
  session: HostSessionRecord,
  now = Date.now(),
): HostSessionRecord => ({
  ...session,
  disconnectedAt: now,
})

export const shouldCleanupStaleRoute = (
  session: HostSessionRecord | null,
  staleRouteGraceMs: number,
  now = Date.now(),
): boolean => {
  if (!session || session.disconnectedAt === null) {
    return false
  }

  return now - session.disconnectedAt >= staleRouteGraceMs
}

export const isSessionHealthy = (
  session: HostSessionRecord | null,
  heartbeatGraceMs: number,
  now = Date.now(),
): boolean => {
  if (!session || session.disconnectedAt !== null) {
    return false
  }

  return now - session.lastHeartbeatAt <= heartbeatGraceMs
}

export const isLocalDevHostname = (hostname: string): boolean => {
  const normalized = normalizeHostname(hostname)
  return normalized === 'localhost' || normalized === '127.0.0.1'
}

export const extractHostnameFromRequest = (requestUrl: string, hostHeader?: string | null): string => {

  if (hostHeader && hostHeader.length > 0) {
    return normalizeHostname(hostHeader)
  }

  const url = new URL(requestUrl)
  return normalizeHostname(url.hostname)
}
