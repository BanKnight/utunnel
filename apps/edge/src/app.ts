import { Hono } from 'hono'
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
  isOperatorAuthorized,
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
    normalized.startsWith('proxy-')
  )
}

const buildRelayRequestHeaders = (request: Request) => {
  return Object.fromEntries(
    Array.from(request.headers.entries()).filter(([name]) => !isBlockedRelayRequestHeader(name)),
  ) satisfies Record<string, string>
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
  const relayPath = url.pathname.replace(/^\/tunnel/, '') || '/'
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

  app.all('/tunnel/*', async (c) => {
    const hostname = extractHostnameFromRequest(c.req.url, c.req.header('host'))
    if (!isHostnameInRootDomain(hostname, c.env.ROOT_DOMAIN)) {
      return c.json({ error: 'host_outside_root_domain' }, 404)
    }

    const relayPath = (() => {
      try {
        return buildRelayRequestPath(c.req.url)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'invalid_relay_path'
        return message
      }
    })()

    if (relayPath === 'invalid_relay_path') {
      return c.json({ error: 'invalid_relay_path' }, 400)
    }

    const routing = getRoutingStub(c.env)
    const resolveRes = await routing.fetch(`https://routing.internal/resolve?hostname=${encodeURIComponent(hostname)}`)

    if (!resolveRes.ok) {
      return c.json({ error: 'route_not_found' }, 404)
    }

    const route = (await resolveRes.json()) as RoutingEntry
    const hostStub = getHostStub(c.env, route.hostId)

    if (c.req.header('Upgrade')?.toLowerCase() === 'websocket') {
      const relayRequest: RelayWebSocketRequest = {
        expectedSessionId: route.sessionId,
        expectedVersion: route.version,
        request: {
          type: 'ws_open',
          payload: {
            streamId: crypto.randomUUID(),
            serviceId: route.serviceId,
            path: relayPath,
            headers: buildRelayRequestHeaders(c.req.raw),
          },
        },
      }

      return hostStub.fetch(
        new Request('https://host.internal/relay-ws', {
          method: 'POST',
          headers: c.req.raw.headers,
          body: JSON.stringify(relayRequest),
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
          method: c.req.method,
          path: relayPath,
          headers: buildRelayRequestHeaders(c.req.raw),
          body: ['GET', 'HEAD'].includes(c.req.method.toUpperCase()) ? '' : await c.req.raw.text(),
        },
      },
    }

    return hostStub.fetch(toJsonRequest('https://host.internal/relay-http', relayRequest))
  })

  return app
}

export const app = createEdgeApp()
