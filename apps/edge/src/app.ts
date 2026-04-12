import { Hono, type Context } from 'hono'
import { parseEdgeEnv } from '@utunnel/config'
import {
  type HostSessionRecord,
  type HttpRequestMessage,
  type WebSocketOpenMessage,
  serviceBindingPayloadSchema,
  type RoutingEntry,
  type ServiceBindingPayload,
} from '@utunnel/protocol'
import {
  buildHostSessionRecord,
  buildRoutingEntry,
  extractBearerToken,
  extractHostnameFromRequest,
  isHostAuthorized,
  isHostnameInRootDomain,
  isLocalDevHostname,
  isOperatorAuthorized,
  isSessionHealthy,
  normalizeServiceDefinitions,
  shouldCleanupStaleRoute,
} from './lib'

export type FetchStub = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export type NamespaceLike<T extends FetchStub> = {
  idFromName(name: string): string
  get(id: string): T
}

export type EdgeBindings = {
  ROOT_DOMAIN: string
  OPERATOR_TOKEN: string
  STALE_ROUTE_GRACE_MS: string
  HEARTBEAT_GRACE_MS: string
  ROUTING_DIRECTORY: NamespaceLike<FetchStub>
  HOST_SESSION: NamespaceLike<FetchStub>
}

type HonoEnv = { Bindings: EdgeBindings }

const toJsonRequest = (url: string, body: unknown, method = 'POST') => {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const unauthorized = (reason = 'unauthorized') => Response.json({ ok: false, reason }, { status: 401 })
const badRequest = (reason: string) => Response.json({ ok: false, reason }, { status: 400 })

const getRoutingStub = (env: EdgeBindings) => {
  return env.ROUTING_DIRECTORY.get(env.ROUTING_DIRECTORY.idFromName('global'))
}

const getHostStub = (env: EdgeBindings, hostId: string) => {
  return env.HOST_SESSION.get(env.HOST_SESSION.idFromName(hostId))
}

const requireHostAuthorization = (request: Request, hostId: string, env: EdgeBindings) => {
  const token = extractBearerToken(request.headers.get('authorization'))
  return isHostAuthorized(token, hostId, env.OPERATOR_TOKEN)
}

const requireOperatorAuthorization = (request: Request, env: EdgeBindings) => {
  const token = extractBearerToken(request.headers.get('authorization'))
  return isOperatorAuthorized(token, env.OPERATOR_TOKEN)
}

const parseAndValidatePayload = async (request: Request, env: EdgeBindings) => {
  const rawPayload = serviceBindingPayloadSchema.parse(await request.json())
  const services = normalizeServiceDefinitions(rawPayload.services)

  for (const service of services) {
    if (!isHostnameInRootDomain(service.subdomain, env.ROOT_DOMAIN)) {
      throw new Error(`service_outside_root_domain:${service.subdomain}`)
    }
  }

  return {
    ...rawPayload,
    services,
  } satisfies ServiceBindingPayload
}

const pruneRemovedHostRoutes = async (routing: FetchStub, hostId: string, keepHostnames: string[]) => {
  const routesResponse = await routing.fetch('https://routing.internal/list')
  if (!routesResponse.ok) {
    return routesResponse
  }

  const keep = new Set(keepHostnames)
  const routes = (await routesResponse.json()) as RoutingEntry[]
  for (const route of routes) {
    if (route.hostId !== hostId || keep.has(route.hostname)) {
      continue
    }

    const unbindResponse = await routing.fetch(
      toJsonRequest('https://routing.internal/unbind-stale', {
        hostname: route.hostname,
        deadline: Date.now(),
      }),
    )
    if (!unbindResponse.ok) {
      return unbindResponse
    }
  }

  return null
}

const isBlockedRelayRequestHeader = (name: string) => {
  const normalized = name.toLowerCase()
  return (
    normalized === 'host' ||
    normalized === 'content-length' ||
    normalized === 'connection' ||
    normalized === 'keep-alive' ||
    normalized === 'transfer-encoding' ||
    normalized === 'upgrade' ||
    normalized === 'te' ||
    normalized === 'trailer' ||
    normalized === 'forwarded' ||
    normalized === 'x-real-ip' ||
    normalized.startsWith('x-forwarded-') ||
    normalized === 'x-utunnel-route-host' ||
    normalized.startsWith('proxy-')
  )
}

const buildRelayRequestHeaders = (request: Request) => {
  return Object.fromEntries(
    Array.from(request.headers.entries()).filter(([name]) => !isBlockedRelayRequestHeader(name)),
  ) satisfies Record<string, string>
}

const resolveIngressHostname = (
  requestUrl: string,
  hostHeader?: string | null,
  overrideHostnameHeader?: string | null,
) => {
  const url = new URL(requestUrl)
  const queryOverrideHostname = url.searchParams.get('__utunnel_host')
  const pathOverrideHostname = (() => {
    const match = url.pathname.match(/^\/tunnel\/__utunnel_host\/([^/]+)(?:\/|$)/)
    return match ? decodeURIComponent(match[1]!) : null
  })()
  const requestHostname = extractHostnameFromRequest(requestUrl)
  const isLocalIngress = (hostHeader ? isLocalDevHostname(hostHeader) : false) || isLocalDevHostname(requestHostname)

  if (isLocalIngress) {
    const localOverrideHostname = overrideHostnameHeader ?? queryOverrideHostname ?? pathOverrideHostname
    if (localOverrideHostname) {
      return extractHostnameFromRequest(requestUrl, localOverrideHostname)
    }
  }

  return extractHostnameFromRequest(requestUrl, hostHeader)
}

const assertRelayPath = (path: string) => {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('invalid_relay_path')
  }

  const decodedPath = decodeURIComponent(path)
  if (decodedPath.startsWith('//')) {
    throw new Error('invalid_relay_path')
  }
}

const buildRelayRequestPath = (requestUrl: string) => {
  const url = new URL(requestUrl)
  url.searchParams.delete('__utunnel_host')
  const pathWithOverrideRemoved = url.pathname.replace(/^\/tunnel\/__utunnel_host\/[^/]+(?=\/|$)/, '/tunnel')
  const relayPath = pathWithOverrideRemoved.replace(/^\/tunnel/, '') || '/'
  const nextPath = `${relayPath}${url.search}`
  assertRelayPath(nextPath)
  return nextPath
}

type RelayHttpRequest = {
  expectedSessionId: string
  expectedVersion: number
  request: HttpRequestMessage
}

type RelayWebSocketRequest = {
  expectedSessionId: string
  expectedVersion: number
  request: WebSocketOpenMessage
}

export const handleTunnelRequest = async (request: Request, env: EdgeBindings) => {
  const hostname = resolveIngressHostname(request.url, request.headers.get('host'), request.headers.get('x-utunnel-route-host'))
  if (!isHostnameInRootDomain(hostname, env.ROOT_DOMAIN)) {
    return Response.json({ error: 'host_outside_root_domain' }, { status: 404 })
  }

  const relayPath = (() => {
    try {
      return buildRelayRequestPath(request.url)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid_relay_path'
      return message
    }
  })()

  if (relayPath === 'invalid_relay_path') {
    return Response.json({ error: 'invalid_relay_path' }, { status: 400 })
  }

  const routing = getRoutingStub(env)
  const resolveRes = await routing.fetch(`https://routing.internal/resolve?hostname=${encodeURIComponent(hostname)}`)

  if (!resolveRes.ok) {
    return Response.json({ error: 'route_not_found' }, { status: 404 })
  }

  const route = (await resolveRes.json()) as RoutingEntry
  const hostStub = getHostStub(env, route.hostId)

  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
    const relayRequest: RelayWebSocketRequest = {
      expectedSessionId: route.sessionId,
      expectedVersion: route.version,
      request: {
        type: 'ws_open',
        payload: {
          streamId: crypto.randomUUID(),
          serviceId: route.serviceId,
          path: relayPath,
          headers: buildRelayRequestHeaders(request),
        },
      },
    }

    return hostStub.fetch(
      new Request('https://host.internal/relay-ws', {
        method: 'GET',
        headers: new Headers({
          Upgrade: 'websocket',
          'x-utunnel-relay-payload': JSON.stringify(relayRequest),
        }),
      }),
    )
  }

  const relayRequest: RelayHttpRequest = {
    expectedSessionId: route.sessionId,
    expectedVersion: route.version,
    request: {
      type: 'http_request',
      payload: {
        streamId: crypto.randomUUID(),
        serviceId: route.serviceId,
        method: request.method,
        path: relayPath,
        headers: buildRelayRequestHeaders(request),
        body: ['GET', 'HEAD'].includes(request.method.toUpperCase()) ? '' : await request.text(),
      },
    },
  }

  return hostStub.fetch(toJsonRequest('https://host.internal/relay-http', relayRequest))
}

export const createEdgeApp = () => {
  const app = new Hono<HonoEnv>()

  app.get('/', (c) => c.json({ name: 'utunnel-edge', status: 'ok' }))

  app.post('/api/hosts/:hostId/token/verify', async (c) => {
    const hostId = c.req.param('hostId')
    if (!requireHostAuthorization(c.req.raw, hostId, c.env)) {
      return unauthorized('invalid_host_token')
    }

    return c.json({ ok: true })
  })

  app.get('/connect', async (c) => {
    const hostId = c.req.query('hostId')
    if (!hostId) return badRequest('host_id_required')
    if (c.req.header('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }
    if (!requireHostAuthorization(c.req.raw, hostId, c.env)) {
      return unauthorized('invalid_host_token')
    }

    const hostStub = getHostStub(c.env, hostId)
    return hostStub.fetch(c.req.raw)
  })

  app.post('/api/hosts/:hostId/services', async (c) => {
    const hostId = c.req.param('hostId')
    if (!requireHostAuthorization(c.req.raw, hostId, c.env)) {
      return unauthorized('invalid_host_token')
    }

    let payload: ServiceBindingPayload
    try {
      payload = await parseAndValidatePayload(c.req.raw, c.env)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid_payload'
      return badRequest(message)
    }

    const routing = getRoutingStub(c.env)
    for (const service of payload.services) {
      const bindResponse = await routing.fetch(
        toJsonRequest('https://routing.internal/bind', buildRoutingEntry(hostId, payload, service)),
      )
      if (!bindResponse.ok) {
        return bindResponse
      }
    }

    const hostStub = getHostStub(c.env, hostId)
    const registerResponse = await hostStub.fetch(
      toJsonRequest('https://host.internal/register', buildHostSessionRecord(hostId, payload)),
    )
    if (!registerResponse.ok) {
      return registerResponse
    }

    const pruneResponse = await pruneRemovedHostRoutes(
      routing,
      hostId,
      payload.services.map((service) => service.subdomain),
    )
    if (pruneResponse) {
      return pruneResponse
    }

    return c.json({ ok: true, count: payload.services.length, mode: 'register' })
  })

  app.post('/api/hosts/:hostId/rebind', async (c) => {
    const hostId = c.req.param('hostId')
    if (!requireHostAuthorization(c.req.raw, hostId, c.env)) {
      return unauthorized('invalid_host_token')
    }

    const body = (await c.req.json()) as ServiceBindingPayload & { previousSessionId?: string }
    let payload: ServiceBindingPayload
    try {
      payload = {
        ...serviceBindingPayloadSchema.parse(body),
        services: normalizeServiceDefinitions(body.services),
      }
      for (const service of payload.services) {
        if (!isHostnameInRootDomain(service.subdomain, c.env.ROOT_DOMAIN)) {
          throw new Error(`service_outside_root_domain:${service.subdomain}`)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid_payload'
      return badRequest(message)
    }

    const hostStub = getHostStub(c.env, hostId)
    const sessionResponse = await hostStub.fetch('https://host.internal/session')
    const currentSession = (await sessionResponse.json()) as HostSessionRecord | null

    if (currentSession && !body.previousSessionId) {
      return Response.json({ ok: false, reason: 'previous_session_required' }, { status: 409 })
    }

    if (currentSession && body.previousSessionId !== currentSession.sessionId) {
      return Response.json({ ok: false, reason: 'previous_session_mismatch' }, { status: 409 })
    }

    const routing = getRoutingStub(c.env)
    for (const service of payload.services) {
      const bindResponse = await routing.fetch(
        toJsonRequest('https://routing.internal/bind', buildRoutingEntry(hostId, payload, service)),
      )
      if (!bindResponse.ok) {
        return bindResponse
      }
    }

    const registerResponse = await hostStub.fetch(
      toJsonRequest('https://host.internal/register', buildHostSessionRecord(hostId, payload)),
    )
    if (!registerResponse.ok) {
      return registerResponse
    }

    const pruneResponse = await pruneRemovedHostRoutes(
      routing,
      hostId,
      payload.services.map((service) => service.subdomain),
    )
    if (pruneResponse) {
      return pruneResponse
    }

    return c.json({ ok: true, count: payload.services.length, mode: 'rebind' })
  })

  app.post('/api/hosts/:hostId/disconnect', async (c) => {
    const hostId = c.req.param('hostId')
    if (!requireHostAuthorization(c.req.raw, hostId, c.env)) {
      return unauthorized('invalid_host_token')
    }

    const hostStub = getHostStub(c.env, hostId)
    return hostStub.fetch('https://host.internal/disconnect', { method: 'POST' })
  })

  app.post('/api/hosts/:hostId/cleanup-stale', async (c) => {
    const hostId = c.req.param('hostId')
    if (!requireHostAuthorization(c.req.raw, hostId, c.env)) {
      return unauthorized('invalid_host_token')
    }

    const edgeEnv = parseEdgeEnv(c.env)
    const hostStub = getHostStub(c.env, hostId)
    const hostSessionResponse = await hostStub.fetch('https://host.internal/session')
    const session = (await hostSessionResponse.json()) as HostSessionRecord | null

    if (!shouldCleanupStaleRoute(session, edgeEnv.STALE_ROUTE_GRACE_MS)) {
      return c.json({ ok: false, reason: 'grace_period_not_elapsed_or_not_disconnected' }, 400)
    }

    if (!session) {
      return c.json({ ok: false, reason: 'session_not_found' }, 404)
    }

    const routing = getRoutingStub(c.env)
    for (const service of session.services) {
      await routing.fetch(
        toJsonRequest('https://routing.internal/unbind-stale', {
          hostname: service.subdomain,
          deadline: Date.now(),
        }),
      )
    }

    await hostStub.fetch('https://host.internal/clear', { method: 'POST' })
    return c.json({ ok: true, removed: session.services.length })
  })

  app.get('/api/routes/resolve', async (c) => {
    if (!requireOperatorAuthorization(c.req.raw, c.env)) {
      return unauthorized('invalid_operator_token')
    }

    const hostname = c.req.query('hostname')
    if (!hostname) return c.json({ error: 'hostname_required' }, 400)

    const routing = getRoutingStub(c.env)
    return routing.fetch(
      `https://routing.internal/resolve?hostname=${encodeURIComponent(extractHostnameFromRequest(`https://${hostname}`))}`,
    )
  })

  app.get('/api/routes', async (c) => {
    if (!requireOperatorAuthorization(c.req.raw, c.env)) {
      return unauthorized('invalid_operator_token')
    }

    const routing = getRoutingStub(c.env)
    return routing.fetch('https://routing.internal/list')
  })

  app.get('/api/hosts/:hostId/session', async (c) => {
    if (!requireOperatorAuthorization(c.req.raw, c.env)) {
      return unauthorized('invalid_operator_token')
    }

    const hostStub = getHostStub(c.env, c.req.param('hostId'))
    return hostStub.fetch('https://host.internal/session')
  })

  app.get('/api/hosts/:hostId/health', async (c) => {
    if (!requireOperatorAuthorization(c.req.raw, c.env)) {
      return unauthorized('invalid_operator_token')
    }

    const edgeEnv = parseEdgeEnv(c.env)
    const hostStub = getHostStub(c.env, c.req.param('hostId'))
    const sessionResponse = await hostStub.fetch('https://host.internal/session')
    const session = (await sessionResponse.json()) as HostSessionRecord | null

    if (!session) {
      return c.json({ ok: false, reason: 'session_not_found' }, 404)
    }

    return c.json({
      hostId: session.hostId,
      sessionId: session.sessionId,
      version: session.version,
      healthy: isSessionHealthy(session, edgeEnv.HEARTBEAT_GRACE_MS),
      lastHeartbeatAt: session.lastHeartbeatAt,
      disconnectedAt: session.disconnectedAt,
      serviceCount: session.services.length,
    })
  })

  const tunnelHandler = (c: Context<HonoEnv>) => handleTunnelRequest(c.req.raw, c.env)

  app.get('/tunnel/socket', tunnelHandler)
  app.get('/tunnel/__utunnel_host/:hostname/socket', tunnelHandler)
  app.get('/tunnel/*', tunnelHandler)
  app.all('/tunnel/*', tunnelHandler)


  return app
}

export const app = createEdgeApp()
