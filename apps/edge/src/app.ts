import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { parseEdgeEnv } from '@utunnel/config'
import {
  type HostSessionRecord,
  type HttpRequestMessage,
  serviceDefinitionSchema,
  type WebSocketOpenMessage,
  serviceBindingPayloadSchema,
  type RoutingEntry,
  type ServiceBindingPayload,
  configDispatchMessageSchema,
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
import {
  getAuthenticatedControlShellUser,
  loginControlShell,
  logoutControlShell,
  summarizeDashboard,
} from './control-shell'
import {
  applyDesiredHostServices,
  createControlApiToken,
  deleteHostControlState,
  claimHostBootstrap,
  getDesiredHostConfig,
  issueHostBootstrap,
  listAppliedRouteProjections,
  listControlApiTokens,
  listControlPlaneHosts,
  listServiceReachabilitySummaries,
  promoteAppliedHostConfig,
  reportCurrentHostConfig,
  revokeControlApiToken,
  rotateControlApiToken,
  verifyControlApiToken,
  verifyHostAccessToken,
} from './control-plane'
import { attachTrpc } from './trpc-handler'
import type { EdgeBindings, FetchStub, HonoEnv } from './types'

const toJsonRequest = (url: string, body: unknown, method = 'POST') => {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const unauthorized = (reason = 'unauthorized') => Response.json({ ok: false, reason }, { status: 401 })
const badRequest = (reason: string) => Response.json({ ok: false, reason }, { status: 400 })

type ExecutionContextLike = {
  waitUntil?: (promise: Promise<unknown>) => void
}

type ReachabilityObservationInput = {
  hostId: string
  serviceId: string
  hostname: string
  method: string
  path: string
  checkedAt: number
  success: boolean
  statusCode?: number
  latencyMs?: number
  failureKind?: 'status-code' | 'edge'
}

const getRoutingStub = (env: EdgeBindings) => {
  return env.ROUTING_DIRECTORY.get(env.ROUTING_DIRECTORY.idFromName('global'))
}

const getHostStub = (env: EdgeBindings, hostId: string) => {
  return env.HOST_SESSION.get(env.HOST_SESSION.idFromName(hostId))
}

const logReachabilityObservation = (observation: ReachabilityObservationInput) => {
  if (typeof process !== 'undefined' && process.env.NODE_ENV === 'test') {
    return
  }

  console.log(
    JSON.stringify({
      kind: 'utunnel_reachability_observation',
      ...observation,
    }),
  )
}

const persistReachabilityObservation = async (
  env: EdgeBindings,
  observation: ReachabilityObservationInput,
) => {
  const record = observation.success
    ? {
        hostId: observation.hostId,
        serviceId: observation.serviceId,
        checkedAt: observation.checkedAt,
        success: true,
        statusCode: observation.statusCode,
        latencyMs: observation.latencyMs,
      }
    : {
        hostId: observation.hostId,
        serviceId: observation.serviceId,
        checkedAt: observation.checkedAt,
        success: false,
        statusCode: observation.statusCode,
        latencyMs: observation.latencyMs,
        failureKind: observation.failureKind ?? 'edge',
      }

  logReachabilityObservation(observation)

  try {
    await getRoutingStub(env).fetch(toJsonRequest('https://routing.internal/control/probes/record', record))
  } catch (error) {
    console.error('reachability_observation_persist_failed', {
      hostId: observation.hostId,
      serviceId: observation.serviceId,
      reason: error instanceof Error ? error.message : 'unknown_error',
    })
  }
}

const waitOrRun = async (executionCtx: ExecutionContextLike | undefined, task: Promise<unknown>) => {
  if (executionCtx?.waitUntil) {
    executionCtx.waitUntil(task)
    return
  }

  await task
}

const requireHostAuthorization = async (request: Request, hostId: string, env: EdgeBindings) => {
  const token = extractBearerToken(request.headers.get('authorization'))
  if (await verifyHostAccessToken(env, hostId, token)) {
    return true
  }
  return isHostAuthorized(token, hostId, env.OPERATOR_TOKEN)
}

const requireOperatorAuthorization = async (request: Request, env: EdgeBindings) => {
  const token = extractBearerToken(request.headers.get('authorization'))
  if (isOperatorAuthorized(token, env.OPERATOR_TOKEN)) {
    return true
  }
  return verifyControlApiToken(env, token)
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

const dispatchDesiredConfigToHost = async (env: EdgeBindings, hostId: string) => {
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

  const hostStub = getHostStub(env, hostId)
  const response = await hostStub.fetch(
    toJsonRequest('https://host.internal/control/dispatch', message),
  )

  if (!response.ok) {
    return { ok: false as const, status: response.status }
  }

  return { ok: true as const, dispatched: true as const, generation: desired.generation }
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

export const handleTunnelRequest = async (
  request: Request,
  env: EdgeBindings,
  executionCtx?: ExecutionContextLike,
) => {
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

  const startedAt = Date.now()
  try {
    const response = await hostStub.fetch(toJsonRequest('https://host.internal/relay-http', relayRequest))
    const checkedAt = Date.now()
    const statusCode = response.status
    const success = statusCode < 500
    const observation = success
      ? persistReachabilityObservation(env, {
          hostId: route.hostId,
          serviceId: route.serviceId,
          hostname,
          method: request.method,
          path: relayPath,
          checkedAt,
          success: true,
          statusCode,
          latencyMs: checkedAt - startedAt,
        })
      : persistReachabilityObservation(env, {
          hostId: route.hostId,
          serviceId: route.serviceId,
          hostname,
          method: request.method,
          path: relayPath,
          checkedAt,
          success: false,
          statusCode,
          latencyMs: checkedAt - startedAt,
          failureKind: 'status-code',
        })
    await waitOrRun(executionCtx, observation)
    return response
  } catch (error) {
    const checkedAt = Date.now()
    await waitOrRun(
      executionCtx,
      persistReachabilityObservation(env, {
        hostId: route.hostId,
        serviceId: route.serviceId,
        hostname,
        method: request.method,
        path: relayPath,
        checkedAt,
        success: false,
        latencyMs: checkedAt - startedAt,
        failureKind: 'edge',
      }),
    )
    throw error
  }
}

export const createEdgeApp = () => {
  const app = new Hono<HonoEnv>()

  attachTrpc(app)

  app.get('/', (c) => c.json({ name: 'utunnel-edge', status: 'ok' }))

  app.post('/api/auth/login', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { password?: string } | null
    const result = await loginControlShell(c.env, body?.password ?? '')
    if (!result.ok) {
      if (result.reason === 'control_shell_not_configured') {
        return Response.json({ ok: false, reason: result.reason }, { status: 404 })
      }
      return unauthorized(result.reason)
    }

    c.header('set-cookie', result.setCookie)
    return c.json({ ok: true, user: result.user })
  })

  app.get('/api/auth/me', async (c) => {
    const user = await getAuthenticatedControlShellUser(c.req.raw, c.env)
    if (!user) {
      return unauthorized('invalid_session')
    }

    return c.json({ ok: true, user })
  })

  app.post('/api/auth/logout', async (c) => {
    const result = logoutControlShell(c.env)
    if (!result.ok) {
      return Response.json({ ok: false, reason: result.reason }, { status: 404 })
    }

    c.header('set-cookie', result.setCookie)
    return c.json({ ok: true })
  })

  app.get('/api/dashboard/summary', async (c) => {
    const user = await getAuthenticatedControlShellUser(c.req.raw, c.env)
    if (!user) {
      return unauthorized('invalid_session')
    }

    return c.json(await summarizeDashboard(c.env))
  })

  app.post('/api/control/hosts/:hostId/desired', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    const hostId = c.req.param('hostId')
    try {
      const result = await applyDesiredHostServices(c.env, hostId, (await c.req.json().catch(() => null))?.services ?? [])
      if (!result.ok) {
        return Response.json({ ok: false, reason: result.reason }, { status: result.status })
      }
      return c.json(result.value)
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : 'invalid_desired_payload')
    }
  })

  app.post('/api/control/hosts/:hostId/bootstrap', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    const hostId = c.req.param('hostId')
    try {
      const body = (await c.req.json().catch(() => null)) as {
        hostname?: string
        edgeBaseUrl?: string
        expiresInMs?: number
      } | null
      const hostname = z.string().min(1).parse(body?.hostname)
      const edgeBaseUrl = z.string().url().parse(body?.edgeBaseUrl)
      const bootstrapInput = body?.expiresInMs === undefined
        ? { hostId, hostname, edgeBaseUrl }
        : { hostId, hostname, edgeBaseUrl, expiresInMs: body.expiresInMs }
      const result = await issueHostBootstrap(c.env, bootstrapInput)
      if (!result.ok) {
        return Response.json({ ok: false, reason: result.reason }, { status: result.status })
      }
      return c.json(result.value)
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : 'invalid_bootstrap_payload')
    }
  })

  app.post('/api/control/hosts/:hostId/current', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    const hostId = c.req.param('hostId')
    try {
      const body = (await c.req.json()) as {
        generation?: number
        status?: 'pending' | 'acknowledged' | 'error'
        services?: unknown
        error?: string
      }
      const services = z.array(serviceDefinitionSchema).parse(body.services ?? [])
      const result = await reportCurrentHostConfig(c.env, hostId, {
        generation: z.number().int().positive().parse(body.generation),
        status: z.enum(['pending', 'acknowledged', 'error']).parse(body.status),
        services,
        error: body.error,
      })
      if (!result.ok) {
        return Response.json({ ok: false, reason: result.reason }, { status: result.status })
      }
      return c.json(result.value)
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : 'invalid_current_payload')
    }
  })

  app.post('/api/control/hosts/:hostId/applied', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    const hostId = c.req.param('hostId')
    try {
      const body = (await c.req.json()) as {
        generation?: number
        services?: unknown
      }
      const services = z.array(serviceDefinitionSchema).parse(body.services ?? [])
      const result = await promoteAppliedHostConfig(c.env, hostId, {
        generation: z.number().int().positive().parse(body.generation),
        services,
      })
      if (!result.ok) {
        return Response.json({ ok: false, reason: result.reason }, { status: result.status })
      }
      return c.json(result.value)
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : 'invalid_applied_payload')
    }
  })

  app.get('/api/control/hosts/:hostId', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    const hostId = c.req.param('hostId')
    const host = (await listControlPlaneHosts(c.env)).find((entry) => entry.hostId === hostId) ?? null
    if (!host) {
      return Response.json({ ok: false, reason: 'host_not_found' }, { status: 404 })
    }

    return c.json(host)
  })

  app.get('/api/control/hosts', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    return c.json(await listControlPlaneHosts(c.env))
  })

  app.get('/api/control/tokens', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    return c.json(await listControlApiTokens(c.env))
  })

  app.post('/api/control/tokens', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    const body = (await c.req.json().catch(() => null)) as { label?: string } | null
    const input = body?.label ? { label: body.label } : {}
    const result = await createControlApiToken(c.env, input)
    if (!result.ok) {
      return Response.json({ ok: false, reason: result.reason }, { status: result.status })
    }
    return c.json(result.value)
  })

  app.post('/api/control/tokens/:tokenId/rotate', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    const result = await rotateControlApiToken(c.env, c.req.param('tokenId'))
    if (!result.ok) {
      return Response.json({ ok: false, reason: result.reason }, { status: result.status })
    }
    return c.json(result.value)
  })

  app.post('/api/control/tokens/:tokenId/revoke', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    const result = await revokeControlApiToken(c.env, c.req.param('tokenId'))
    if (!result.ok) {
      return Response.json({ ok: false, reason: result.reason }, { status: result.status })
    }
    return c.json(result.value)
  })

  app.delete('/api/control/hosts/:hostId', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    const result = await deleteHostControlState(c.env, c.req.param('hostId'))
    if (!result.ok) {
      return Response.json({ ok: false, reason: result.reason }, { status: result.status })
    }

    return c.json(result.value)
  })


  app.get('/api/control/routes', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    return c.json(await listAppliedRouteProjections(c.env))
  })

  app.get('/api/control/services/reachability', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    return c.json(await listServiceReachabilitySummaries(c.env))
  })

  app.post('/api/bootstrap/claim', async (c) => {
    try {
      const body = (await c.req.json().catch(() => null)) as {
        hostId?: string
        hostname?: string
        bootstrapToken?: string
      } | null
      const hostId = z.string().min(1).parse(body?.hostId)
      const hostname = z.string().min(1).parse(body?.hostname)
      const bootstrapToken = z.string().min(1).parse(body?.bootstrapToken)
      const result = await claimHostBootstrap(c.env, {
        hostId,
        hostname,
        bootstrapToken,
      })
      if (!result.ok) {
        return Response.json({ ok: false, reason: result.reason }, { status: result.status })
      }
      return c.json(result.value)
    } catch (error) {
      return badRequest(error instanceof Error ? error.message : 'invalid_bootstrap_claim')
    }
  })

  app.get('/api/hosts/:hostId/desired', async (c) => {
    const hostId = c.req.param('hostId')
    if (!(await requireHostAuthorization(c.req.raw, hostId, c.env))) {
      return unauthorized('invalid_host_token')
    }

    return c.json({ desired: await getDesiredHostConfig(c.env, hostId) })
  })

  app.post('/api/hosts/:hostId/token/verify', async (c) => {
    const hostId = c.req.param('hostId')
    if (!(await requireHostAuthorization(c.req.raw, hostId, c.env))) {
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
    if (!(await requireHostAuthorization(c.req.raw, hostId, c.env))) {
      return unauthorized('invalid_host_token')
    }

    const hostStub = getHostStub(c.env, hostId)
    return hostStub.fetch(c.req.raw)
  })

  app.post('/api/hosts/:hostId/services', async (c) => {
    const hostId = c.req.param('hostId')
    if (!(await requireHostAuthorization(c.req.raw, hostId, c.env))) {
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

    await dispatchDesiredConfigToHost(c.env, hostId)
    return c.json({ ok: true, count: payload.services.length, mode: 'register' })
  })

  app.post('/api/hosts/:hostId/rebind', async (c) => {
    const hostId = c.req.param('hostId')
    if (!(await requireHostAuthorization(c.req.raw, hostId, c.env))) {
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

    await dispatchDesiredConfigToHost(c.env, hostId)
    return c.json({ ok: true, count: payload.services.length, mode: 'rebind' })
  })

  app.post('/api/hosts/:hostId/disconnect', async (c) => {
    const hostId = c.req.param('hostId')
    if (!(await requireHostAuthorization(c.req.raw, hostId, c.env))) {
      return unauthorized('invalid_host_token')
    }

    const hostStub = getHostStub(c.env, hostId)
    return hostStub.fetch('https://host.internal/disconnect', { method: 'POST' })
  })

  app.post('/api/hosts/:hostId/cleanup-stale', async (c) => {
    const hostId = c.req.param('hostId')
    if (!(await requireHostAuthorization(c.req.raw, hostId, c.env))) {
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
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
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
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    const routing = getRoutingStub(c.env)
    return routing.fetch('https://routing.internal/list')
  })

  app.get('/api/hosts/:hostId/session', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
      return unauthorized('invalid_operator_token')
    }

    const hostStub = getHostStub(c.env, c.req.param('hostId'))
    return hostStub.fetch('https://host.internal/session')
  })

  app.get('/api/hosts/:hostId/health', async (c) => {
    if (!(await requireOperatorAuthorization(c.req.raw, c.env))) {
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
