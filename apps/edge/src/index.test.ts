import { describe, expect, test } from 'bun:test'
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import { app } from './app'
import { handleEdgeFetch } from './worker-entry'
import { deriveServiceReachability } from './reachability'
import { buildHostToken } from './lib'
import type { AppRouter } from './trpc'

type RoutingEntry = {
  hostname: string
  hostId: string
  serviceId: string
  sessionId: string
  version: number
  updatedAt: number
}

class FakeRoutingStub {
  private entries = new Map<string, RoutingEntry>()
  private bootstrap = new Map<string, { hostId: string; hostname: string; bootstrapToken: string; issuedAt: number; expiresAt: number; claimedAt: number | null }>()
  private hostTokens = new Map<string, { token: string; issuedAt: number }>()
  private apiTokens = new Map<string, { tokenId: string; prefix: string; token: string; label?: string; createdAt: number; rotatedAt: number | null; revokedAt: number | null; lastUsedAt: number | null }>()
  private desired = new Map<string, HostControlState['desired']>()
  private current = new Map<string, HostControlState['current']>()
  private applied = new Map<string, HostControlState['applied']>()
  private probeResults = new Map<string, Array<{ checkedAt: number; success: boolean; statusCode?: number; latencyMs?: number; failureKind?: string }>>()

  private readHostState(hostId: string): HostControlState {
    const applied = this.applied.get(hostId) ?? null
    const bootstrap = this.bootstrap.get(hostId) ?? null
    return {
      hostId,
      bootstrap: bootstrap
        ? {
            hostname: bootstrap.hostname,
            issuedAt: bootstrap.issuedAt,
            expiresAt: bootstrap.expiresAt,
            claimedAt: bootstrap.claimedAt,
          }
        : null,
      desired: this.desired.get(hostId) ?? null,
      current: this.current.get(hostId) ?? null,
      applied,
      projectedRoutes: applied
        ? applied.services.map((service) => ({
            hostname: service.subdomain,
            serviceId: service.serviceId,
            hostId,
            generation: applied.generation,
            projectedAt: applied.appliedAt,
          }))
        : [],
    }
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)

    if (request.method === 'POST' && url.pathname === '/bind') {
      const entry = (await request.json()) as RoutingEntry
      const existing = this.entries.get(entry.hostname)
      if (existing && (existing.hostId !== entry.hostId || existing.serviceId !== entry.serviceId)) {
        return Response.json({ ok: false, reason: 'hostname_conflict' }, { status: 409 })
      }
      this.entries.set(entry.hostname, entry)
      return Response.json(entry)
    }

    if (request.method === 'GET' && url.pathname === '/resolve') {
      const hostname = url.searchParams.get('hostname')!
      const entry = this.entries.get(hostname)
      if (!entry) return Response.json({ error: 'not_found' }, { status: 404 })
      return Response.json(entry)
    }

    if (request.method === 'GET' && url.pathname === '/list') {
      return Response.json(Array.from(this.entries.values()))
    }

    if (request.method === 'POST' && url.pathname === '/unbind-stale') {
      const { hostname } = (await request.json()) as { hostname: string }
      this.entries.delete(hostname)
      return Response.json({ removed: true })
    }

    if (request.method === 'GET' && url.pathname === '/control/hosts') {
      const hostIds = Array.from(new Set([...this.bootstrap.keys(), ...this.desired.keys(), ...this.current.keys(), ...this.applied.keys()])).sort()
      return Response.json(hostIds.map((hostId) => this.readHostState(hostId)))
    }

    if (request.method === 'GET' && url.pathname === '/control/routes') {
      const hostIds = Array.from(new Set([...this.bootstrap.keys(), ...this.desired.keys(), ...this.current.keys(), ...this.applied.keys()])).sort()
      return Response.json(hostIds.flatMap((hostId) => this.readHostState(hostId).projectedRoutes))
    }

    if (request.method === 'GET' && url.pathname === '/control/services/reachability') {
      const hostIds = Array.from(new Set([...this.bootstrap.keys(), ...this.desired.keys(), ...this.current.keys(), ...this.applied.keys()])).sort()
      return Response.json(
        hostIds.flatMap((hostId) => {
          const state = this.readHostState(hostId)
          const services = state.applied?.services ?? []
          return services.map((service) => {
            const recentResults = this.probeResults.get(`${hostId}:${service.serviceId}`) ?? []
            const lastSuccess = recentResults.find((result) => result.success) ?? null
            const lastFailure = recentResults.find((result) => !result.success) ?? null
            return {
              hostId,
              serviceId: service.serviceId,
              serviceName: service.serviceName,
              subdomain: service.subdomain,
              protocol: service.protocol,
              reachability: recentResults[0]?.success ? 'reachable' : recentResults.length > 0 ? 'unreachable' : 'unknown',
              checkedAt: recentResults[0]?.checkedAt ?? null,
              lastSuccessAt: lastSuccess?.checkedAt ?? null,
              lastFailureAt: lastFailure?.checkedAt ?? null,
              recentResults,
            }
          })
        }),
      )
    }

    if (request.method === 'POST' && url.pathname === '/control/probes/record') {
      const body = (await request.json()) as {
        hostId: string
        serviceId: string
        checkedAt: number
        success: boolean
        statusCode?: number
        latencyMs?: number
        failureKind?: string
      }
      const key = `${body.hostId}:${body.serviceId}`
      const nextResults = [body, ...(this.probeResults.get(key) ?? [])]
        .sort((left, right) => right.checkedAt - left.checkedAt)
        .slice(0, 5)
      this.probeResults.set(key, nextResults)
      return Response.json({ ok: true })
    }

    if (request.method === 'GET' && url.pathname === '/control/tokens') {
      return Response.json(
        Array.from(this.apiTokens.values()).map(({ token: _token, ...metadata }) => metadata),
      )
    }

    if (request.method === 'POST' && url.pathname === '/control/tokens') {
      const body = (await request.json().catch(() => null)) as { label?: string } | null
      const tokenId = `token-${this.apiTokens.size + 1}`
      const token = `utapi_${tokenId}`
      const record = body?.label
        ? {
            tokenId,
            prefix: token.slice(0, 12),
            token,
            label: body.label,
            createdAt: Date.now(),
            rotatedAt: null,
            revokedAt: null,
            lastUsedAt: null,
          }
        : {
            tokenId,
            prefix: token.slice(0, 12),
            token,
            createdAt: Date.now(),
            rotatedAt: null,
            revokedAt: null,
            lastUsedAt: null,
          }
      this.apiTokens.set(tokenId, record)
      return Response.json(record)
    }

    if (request.method === 'POST' && url.pathname === '/control/tokens/verify') {
      const body = (await request.json().catch(() => null)) as { token?: string } | null
      const record = Array.from(this.apiTokens.values()).find((item) => item.revokedAt === null && item.token === body?.token)
      if (!record) {
        return Response.json({ ok: false })
      }
      record.lastUsedAt = Date.now()
      return Response.json({ ok: true, tokenId: record.tokenId })
    }

    const controlTokenMatch = url.pathname.match(/^\/control\/tokens\/([^/]+?)\/(rotate|revoke)$/)
    if (controlTokenMatch && request.method === 'POST') {
      const tokenId = decodeURIComponent(controlTokenMatch[1]!)
      const action = controlTokenMatch[2]
      const record = this.apiTokens.get(tokenId)
      if (!record) {
        return Response.json({ ok: false, reason: 'token_not_found' }, { status: 404 })
      }

      if (action === 'rotate') {
        const nextToken = `utapi_${tokenId}-rotated`
        record.token = nextToken
        record.prefix = nextToken.slice(0, 12)
        record.rotatedAt = Date.now()
        record.lastUsedAt = null
        return Response.json(record)
      }

      record.revokedAt = Date.now()
      const { token: _token, ...metadata } = record
      return Response.json(metadata)
    }

    const bootstrapMatch = url.pathname.match(/^\/control\/hosts\/([^/]+?)\/bootstrap$/)
    if (bootstrapMatch && request.method === 'POST') {
      const hostId = decodeURIComponent(bootstrapMatch[1]!)
      const body = (await request.json()) as { hostname: string; expiresInMs?: number }
      const issuedAt = Date.now()
      const record = {
        hostId,
        hostname: body.hostname,
        bootstrapToken: `bootstrap-${hostId}`,
        issuedAt,
        expiresAt: issuedAt + (body.expiresInMs ?? 10 * 60 * 1000),
        claimedAt: null,
      }
      this.bootstrap.set(hostId, record)
      return Response.json(record)
    }

    const claimMatch = url.pathname.match(/^\/control\/hosts\/([^/]+?)\/claim$/)
    if (claimMatch && request.method === 'POST') {
      const hostId = decodeURIComponent(claimMatch[1]!)
      const body = (await request.json()) as { hostname: string; bootstrapToken: string }
      const bootstrap = this.bootstrap.get(hostId)
      if (!bootstrap) {
        return Response.json({ ok: false, reason: 'bootstrap_not_found' }, { status: 404 })
      }
      if (bootstrap.claimedAt !== null) {
        return Response.json({ ok: false, reason: 'bootstrap_already_used' }, { status: 409 })
      }
      if (Date.now() > bootstrap.expiresAt) {
        return Response.json({ ok: false, reason: 'bootstrap_expired' }, { status: 409 })
      }
      if (body.hostname !== bootstrap.hostname) {
        return Response.json({ ok: false, reason: 'hostname_mismatch' }, { status: 409 })
      }
      if (body.bootstrapToken !== bootstrap.bootstrapToken) {
        return Response.json({ ok: false, reason: 'invalid_bootstrap_token' }, { status: 401 })
      }
      const claimedAt = Date.now()
      bootstrap.claimedAt = claimedAt
      const token = `host-token-${hostId}`
      this.hostTokens.set(hostId, { token, issuedAt: claimedAt })
      return Response.json({ ok: true, hostId, token, claimedAt })
    }

    const hostTokenVerifyMatch = url.pathname.match(/^\/control\/hosts\/([^/]+?)\/token\/verify$/)
    if (hostTokenVerifyMatch && request.method === 'POST') {
      const hostId = decodeURIComponent(hostTokenVerifyMatch[1]!)
      const body = (await request.json()) as { token: string }
      return Response.json({ ok: body.token === this.hostTokens.get(hostId)?.token })
    }

    const controlMatch = url.pathname.match(/^\/control\/hosts\/([^/]+?)(?:\/(desired|current|applied))?$/)
    if (controlMatch) {
      const hostId = decodeURIComponent(controlMatch[1]!)
      const action = controlMatch[2] ?? null

      if (request.method === 'GET' && action === null) {
        const state = this.readHostState(hostId)
        if (!state.bootstrap && !state.desired && !state.current && !state.applied) {
          return Response.json({ ok: false, reason: 'host_not_found' }, { status: 404 })
        }
        return Response.json(state)
      }

      if (request.method === 'DELETE' && action === null) {
        this.bootstrap.delete(hostId)
        this.hostTokens.delete(hostId)
        this.desired.delete(hostId)
        this.current.delete(hostId)
        this.applied.delete(hostId)
        return Response.json({ ok: true })
      }

      if (request.method === 'PUT' && action === 'desired') {
        const body = (await request.json()) as { services: NonNullable<HostControlState['desired']>['services'] }
        const desired = {
          hostId,
          generation: (this.desired.get(hostId)?.generation ?? 0) + 1,
          services: body.services,
          updatedAt: Date.now(),
        }
        this.desired.set(hostId, desired)
        return Response.json(desired)
      }

      if (request.method === 'POST' && action === 'current') {
        const desired = this.desired.get(hostId)
        if (!desired) {
          return Response.json({ ok: false, reason: 'desired_not_found' }, { status: 409 })
        }
        const body = (await request.json()) as NonNullable<HostControlState['current']>
        if (body.generation !== desired.generation) {
          return Response.json({ ok: false, reason: 'generation_mismatch' }, { status: 409 })
        }
        const current = {
          hostId,
          generation: body.generation,
          status: body.status,
          services: body.services,
          error: body.error,
          reportedAt: Date.now(),
        }
        this.current.set(hostId, current)
        return Response.json(current)
      }

      if (request.method === 'POST' && action === 'applied') {
        const desired = this.desired.get(hostId)
        const current = this.current.get(hostId)
        if (!desired) {
          return Response.json({ ok: false, reason: 'desired_not_found' }, { status: 409 })
        }
        if (!current) {
          return Response.json({ ok: false, reason: 'current_not_found' }, { status: 409 })
        }
        if (current.status !== 'acknowledged') {
          return Response.json({ ok: false, reason: 'current_not_acknowledged' }, { status: 409 })
        }
        const body = (await request.json()) as { generation: number; services: NonNullable<HostControlState['applied']>['services'] }
        if (body.generation !== desired.generation || body.generation !== current.generation) {
          return Response.json({ ok: false, reason: 'generation_mismatch' }, { status: 409 })
        }
        const applied = {
          hostId,
          generation: body.generation,
          services: body.services,
          appliedAt: Date.now(),
        }
        this.applied.set(hostId, applied)
        for (const service of body.services) {
          this.probeResults.set(`${hostId}:${service.serviceId}`, [
            {
              checkedAt: Date.now(),
              success: true,
              statusCode: 200,
              latencyMs: 42,
            },
            {
              checkedAt: Date.now() - 60_000,
              success: false,
              failureKind: 'timeout',
              latencyMs: 1500,
            },
          ])
        }
        return Response.json(applied)
      }
    }

    return Response.json({ error: 'not_found' }, { status: 404 })
  }
}

class FakeRoutingNamespace {
  constructor(private readonly stub: FakeRoutingStub) {}
  idFromName(name: string) {
    return name
  }
  get() {
    return this.stub
  }
}

type SessionRecord = {
  hostId: string
  sessionId: string
  version: number
  services: Array<{ subdomain: string; serviceId: string }>
  connectedAt: number
  lastHeartbeatAt: number
  disconnectedAt: number | null
}

class FakeHostStub {
  session: SessionRecord | null = null
  httpDelayMsByServiceId = new Map<string, number>()
  relayHttpHistory: Array<{
    expectedSessionId: string
    expectedVersion: number
    request: {
      payload: {
        method: string
        path: string
        serviceId: string
        streamId: string
        headers: Record<string, string>
      }
    }
  }> = []
  lastRelayHttp: {
    expectedSessionId: string
    expectedVersion: number
    request: {
      payload: {
        method: string
        path: string
        serviceId: string
        streamId: string
        headers: Record<string, string>
      }
    }
  } | null = null
  lastRelayWs: {
    expectedSessionId: string
    expectedVersion: number
    request: {
      payload: {
        serviceId: string
        streamId: string
        path: string
      }
    }
  } | null = null

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)

    if (request.headers.get('Upgrade') === 'websocket' && url.pathname === '/connect') {
      return new Response('connected')
    }

    if (request.method === 'POST' && url.pathname === '/register') {
      this.session = (await request.json()) as SessionRecord
      if (this.session.lastHeartbeatAt === undefined) {
        this.session = { ...this.session, lastHeartbeatAt: this.session.connectedAt }
      }
      return Response.json(this.session)
    }

    if (request.method === 'POST' && url.pathname === '/relay-http') {
      const relay = (await request.json()) as {
        expectedSessionId: string
        expectedVersion: number
        request: {
          payload: {
            method: string
            path: string
            serviceId: string
            streamId: string
            headers: Record<string, string>
          }
        }
      }

      this.lastRelayHttp = relay
      this.relayHttpHistory.push(relay)

      if (
        !this.session ||
        this.session.disconnectedAt !== null ||
        this.session.sessionId !== relay.expectedSessionId ||
        this.session.version !== relay.expectedVersion
      ) {
        return Response.json({ ok: false, reason: 'stale_session_binding' }, { status: 409 })
      }

      const delayMs = this.httpDelayMsByServiceId.get(relay.request.payload.serviceId) ?? 0
      if (delayMs > 0) {
        await Bun.sleep(delayMs)
      }

      return Response.json(
        {
          ok: true,
          serviceId: relay.request.payload.serviceId,
          path: relay.request.payload.path,
          method: relay.request.payload.method,
          streamId: relay.request.payload.streamId,
          forwardedHostHeader: relay.request.payload.headers.host ?? null,
          forwardedXffHeader: relay.request.payload.headers['x-forwarded-for'] ?? null,
          forwardedPortHeader: relay.request.payload.headers['x-forwarded-port'] ?? null,
          proxyAuthorizationHeader: relay.request.payload.headers['proxy-authorization'] ?? null,
        },
        {
          headers: {
            'x-utunnel-relay': 'fake-host',
          },
        },
      )
    }

    if (request.method === 'GET' && url.pathname === '/relay-ws') {
      const relayHeader = request.headers.get('x-utunnel-relay-payload')
      if (!relayHeader) {
        return Response.json({ ok: false, reason: 'missing_relay_payload' }, { status: 400 })
      }

      const relay = JSON.parse(relayHeader) as {
        expectedSessionId: string
        expectedVersion: number
        request: {
          payload: {
            serviceId: string
            streamId: string
            path: string
          }
        }
      }

      this.lastRelayWs = relay

      if (
        !this.session ||
        this.session.disconnectedAt !== null ||
        this.session.sessionId !== relay.expectedSessionId ||
        this.session.version !== relay.expectedVersion
      ) {
        return Response.json({ ok: false, reason: 'stale_session_binding' }, { status: 409 })
      }

      return new Response(null, { status: 101 })
    }

    if (request.method === 'POST' && url.pathname === '/disconnect') {
      if (!this.session) {
        return Response.json({ error: 'session_not_found' }, { status: 404 })
      }
      this.session = { ...this.session, disconnectedAt: Date.now() - 1000 }
      return Response.json(this.session)
    }

    if (request.method === 'POST' && url.pathname === '/clear') {
      this.session = null
      return Response.json({ ok: true })
    }

    if (request.method === 'POST' && url.pathname === '/control/dispatch') {
      return Response.json({ ok: true })
    }

    if (request.method === 'GET' && url.pathname === '/session') {
      return Response.json(this.session)
    }

    return Response.json({ error: 'not_found' }, { status: 404 })
  }
}

class FakeHostNamespace {
  private stubs = new Map<string, FakeHostStub>()

  idFromName(name: string) {
    return name
  }

  get(id: string) {
    if (!this.stubs.has(id)) {
      this.stubs.set(id, new FakeHostStub())
    }
    return this.stubs.get(id)!
  }
}

class FakeAssetsStub {
  lastPathname: string | null = null

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    this.lastPathname = url.pathname
    return new Response(`asset:${url.pathname}`, {
      headers: { 'content-type': 'text/html' },
    })
  }
}

const createEnv = () => {
  const routingStub = new FakeRoutingStub()
  const routing = new FakeRoutingNamespace(routingStub)
  const hosts = new FakeHostNamespace()
  const assets = new FakeAssetsStub()

  return {
    ROOT_DOMAIN: 'example.test',
    OPERATOR_TOKEN: 'dev-operator-token',
    STALE_ROUTE_GRACE_MS: '100',
    HEARTBEAT_GRACE_MS: '1000',
    ROUTING_DIRECTORY: routing,
    HOST_SESSION: hosts,
    ASSETS: assets,
  }
}

type HostControlState = {
  hostId: string
  bootstrap: {
    hostname: string
    issuedAt: number
    expiresAt: number
    claimedAt: number | null
  } | null
  desired: {
    generation: number
    services: Array<{ serviceId: string; serviceName: string; subdomain: string; protocol: 'http' | 'websocket' }>
  } | null
  current: {
    generation: number
    status: 'pending' | 'acknowledged' | 'error'
    services: Array<{ serviceId: string; serviceName: string; subdomain: string; protocol: 'http' | 'websocket' }>
    error?: string | undefined
  } | null
  applied: {
    generation: number
    appliedAt: number
    services: Array<{ serviceId: string; serviceName: string; subdomain: string; protocol: 'http' | 'websocket' }>
  } | null
  projectedRoutes: Array<{ hostname: string; serviceId: string; hostId: string; generation: number; projectedAt: number }>
}

describe('edge app integration', () => {
  test('derives reachable, degraded, unreachable, and unknown reachability states', () => {
    expect(deriveServiceReachability([])).toBe('unknown')

    expect(
      deriveServiceReachability([
        { hostId: 'host-1', serviceId: 'svc-1', checkedAt: 3, success: false, failureKind: 'timeout' },
        { hostId: 'host-1', serviceId: 'svc-1', checkedAt: 2, success: true, statusCode: 200 },
      ]),
    ).toBe('degraded')

    expect(
      deriveServiceReachability([
        { hostId: 'host-1', serviceId: 'svc-1', checkedAt: 3, success: false, failureKind: 'timeout' },
        { hostId: 'host-1', serviceId: 'svc-1', checkedAt: 2, success: false, failureKind: 'status-code', statusCode: 503 },
      ]),
    ).toBe('unreachable')

    expect(
      deriveServiceReachability([
        { hostId: 'host-1', serviceId: 'svc-1', checkedAt: 3, success: true, statusCode: 200 },
        { hostId: 'host-1', serviceId: 'svc-1', checkedAt: 2, success: false, failureKind: 'timeout' },
      ]),
    ).toBe('reachable')
  })
  test('serves control shell asset fallback for browser routes', async () => {
    const env = createEnv()
    const executionCtx = {
      waitUntil() {},
      passThroughOnException() {},
    }

    const rootResponse = await handleEdgeFetch(new Request('http://edge.test/'), env, executionCtx)
    const loginResponse = await handleEdgeFetch(new Request('http://edge.test/login'), env, executionCtx)

    expect(rootResponse.status).toBe(200)
    expect(await rootResponse.text()).toBe('asset:/index.html')
    expect(loginResponse.status).toBe(200)
    expect(await loginResponse.text()).toBe('asset:/index.html')
    expect(env.ASSETS.lastPathname).toBe('/index.html')
  })


  test('supports control API tokens for REST and rejects them for host routes', async () => {
    const env = {
      ...createEnv(),
      UI_PASSWORD: 'console-password',
      SESSION_SECRET: 'session-secret',
      SESSION_TTL_MS: '3600000',
    }

    const login = await app.request(
      'http://edge.test/api/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'console-password' }),
      },
      env,
    )
    const sessionCookie = login.headers.get('set-cookie')!

    const createToken = await app.request(
      'http://edge.test/api/control/tokens',
      {
        method: 'POST',
        headers: {
          cookie: sessionCookie,
          authorization: 'Bearer dev-operator-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ label: 'cli' }),
      },
      env,
    )
    const createTokenJson = (await createToken.json()) as {
      tokenId: string
      prefix: string
      token: string
      label?: string
    }

    expect(createToken.status).toBe(200)
    expect(createTokenJson.tokenId).toBeTypeOf('string')
    expect(createTokenJson.token).toContain('utapi_')

    const listWithApiToken = await app.request(
      'http://edge.test/api/control/tokens',
      {
        headers: {
          authorization: `Bearer ${createTokenJson.token}`,
        },
      },
      env,
    )
    expect(listWithApiToken.status).toBe(200)

    const trpcWithApiToken = await handleEdgeFetch(
      new Request('http://edge.test/trpc/auth.me?batch=1&input=%7B%7D', {
        headers: {
          authorization: `Bearer ${createTokenJson.token}`,
        },
      }),
      env,
      { waitUntil() {}, passThroughOnException() {} },
    )
    expect(trpcWithApiToken.status).toBe(401)

    const hostRouteWithApiToken = await app.request(
      'http://edge.test/api/hosts/host-token-only/token/verify',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${createTokenJson.token}`,
        },
      },
      env,
    )
    expect(hostRouteWithApiToken.status).toBe(401)

    const operatorRestWithSessionOnly = await app.request(
      'http://edge.test/api/control/tokens',
      {
        headers: { cookie: sessionCookie },
      },
      env,
    )
    expect(operatorRestWithSessionOnly.status).toBe(401)
  })

  test('rotates and revokes control API tokens', async () => {
    const env = createEnv()

    const createToken = await app.request(
      'http://edge.test/api/control/tokens',
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer dev-operator-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ label: 'rotate-me' }),
      },
      env,
    )
    const created = (await createToken.json()) as { tokenId: string; token: string }
    expect(createToken.status).toBe(200)

    const rotate = await app.request(
      `http://edge.test/api/control/tokens/${created.tokenId}/rotate`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer dev-operator-token' },
      },
      env,
    )
    const rotated = (await rotate.json()) as { tokenId: string; token: string }
    expect(rotate.status).toBe(200)
    expect(rotated.tokenId).toBe(created.tokenId)
    expect(rotated.token).not.toBe(created.token)

    const oldTokenDenied = await app.request(
      'http://edge.test/api/control/tokens',
      {
        headers: { authorization: `Bearer ${created.token}` },
      },
      env,
    )
    expect(oldTokenDenied.status).toBe(401)

    const revoke = await app.request(
      `http://edge.test/api/control/tokens/${created.tokenId}/revoke`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer dev-operator-token' },
      },
      env,
    )
    expect(revoke.status).toBe(200)

    const revokedDenied = await app.request(
      'http://edge.test/api/control/tokens',
      {
        headers: { authorization: `Bearer ${rotated.token}` },
      },
      env,
    )
    expect(revokedDenied.status).toBe(401)
  })

  test('shares desired validation between REST and tRPC static config import preview', async () => {
    const env = {
      ...createEnv(),
      UI_PASSWORD: 'console-password',
      SESSION_SECRET: 'session-secret',
      SESSION_TTL_MS: '3600000',
    }

    const executionCtx = { waitUntil() {}, passThroughOnException() {} }
    let cookieHeader: string | null = null

    const client = createTRPCProxyClient<AppRouter>({
      links: [
        httpBatchLink({
          url: 'http://edge.test/trpc',
          fetch: async (url, options) => {
            const headers = new Headers(options?.headers)
            if (cookieHeader) {
              headers.set('cookie', cookieHeader)
            }

            const requestInit: RequestInit = {
              method: options?.method ?? 'GET',
              headers,
            }
            if (options && 'body' in options) {
              requestInit.body = options.body ?? null
            }

            const response = await handleEdgeFetch(new Request(String(url), requestInit), env, executionCtx)
            const setCookie = response.headers.get('set-cookie')
            if (setCookie) {
              cookieHeader = setCookie.split(';')[0] ?? null
            }
            return response
          },
        }),
      ],
    })

    await client.auth.login.mutate({ password: 'console-password' })

    await expect(
      client.hosts.importStaticConfig.mutate({
        hostId: 'host-import',
        services: [
          {
            serviceId: 'svc-bad',
            serviceName: 'bad',
            localUrl: 'http://127.0.0.1:3001',
            protocol: 'http',
            subdomain: 'bad.other.test',
          },
        ],
      }),
    ).rejects.toThrow()

    const imported = await client.hosts.importStaticConfig.mutate({
      hostId: 'host-import',
      services: [
        {
          serviceId: ' svc-good ',
          serviceName: ' good ',
          localUrl: 'http://127.0.0.1:3001',
          protocol: 'http',
          subdomain: 'GOOD.EXAMPLE.TEST:443',
        },
      ],
    })

    expect(imported.services).toEqual([
      {
        serviceId: ' svc-good ',
        serviceName: ' good ',
        localUrl: 'http://127.0.0.1:3001',
        protocol: 'http',
        subdomain: 'good.example.test',
      },
    ])

    const desired = await app.request(
      'http://edge.test/api/control/hosts',
      { headers: { authorization: 'Bearer dev-operator-token' } },
      env,
    )
    const desiredJson = (await desired.json()) as HostControlState[]
    expect(desiredJson).toHaveLength(0)
  })


  test('supports control shell tRPC login, me, summary, and logout flow', async () => {
    const env = {
      ...createEnv(),
      UI_PASSWORD: 'console-password',
      SESSION_SECRET: 'session-secret',
      SESSION_TTL_MS: '3600000',
    }

    const registerHost = async (hostId: string, sessionId: string, subdomain: string) => {
      return app.request(
        `http://edge.test/api/hosts/${hostId}/services`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${buildHostToken(hostId, env.OPERATOR_TOKEN)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            sessionId,
            version: 1,
            services: [
              {
                serviceId: `${hostId}-svc`,
                serviceName: hostId,
                localUrl: 'http://127.0.0.1:3001',
                protocol: 'http',
                subdomain,
              },
            ],
          }),
        },
        env,
      )
    }

    expect(await registerHost('host-1', 'session-1', 'one.example.test')).toHaveProperty('status', 200)

    const executionCtx = { waitUntil() {}, passThroughOnException() {} }
    let cookieHeader: string | null = null
    let lastSetCookie: string | null = null

    const client = createTRPCProxyClient<AppRouter>({
      links: [
        httpBatchLink({
          url: 'http://edge.test/trpc',
          fetch: async (url, options) => {
            const headers = new Headers(options?.headers)
            if (cookieHeader) {
              headers.set('cookie', cookieHeader)
            }

            const requestInit: RequestInit = {
              method: options?.method ?? 'GET',
              headers,
            }
            if (options && 'body' in options) {
              requestInit.body = options.body ?? null
            }

            const response = await handleEdgeFetch(new Request(String(url), requestInit), env, executionCtx)
            lastSetCookie = response.headers.get('set-cookie')
            if (lastSetCookie) {
              cookieHeader = lastSetCookie.split(';')[0] ?? null
            }
            return response
          },
        }),
      ],
    })

    const loginResult = await client.auth.login.mutate({ password: 'console-password' })
    expect(loginResult).toEqual({ ok: true, user: { id: 'personal' } })
    expect(cookieHeader ?? '').toContain('utunnel_session=')

    const meResult = await client.auth.me.query()
    expect(meResult).toEqual({ ok: true, user: { id: 'personal' } })

    const summaryResult = await client.dashboard.summary.query()
    expect(summaryResult.hostCount).toBe(1)
    expect(summaryResult.routeCount).toBe(1)

    const logoutResult = await client.auth.logout.mutate()
    expect(logoutResult).toEqual({ ok: true })
    expect(lastSetCookie ?? '').toContain('Max-Age=0')
  })


  test('issues bootstrap command, claims host, and rejects reuse', async () => {
    const env = createEnv()
    const operatorHeader = {
      authorization: 'Bearer dev-operator-token',
      'content-type': 'application/json',
    }

    const issueResponse = await app.request(
      'http://edge.test/api/control/hosts/host-bootstrap/bootstrap',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({
          hostname: 'machine-bootstrap',
          edgeBaseUrl: 'http://edge.test',
        }),
      },
      env,
    )
    const issueJson = (await issueResponse.json()) as { bootstrapToken: string; command: string }

    expect(issueResponse.status).toBe(200)
    expect(issueJson.bootstrapToken).toBeTypeOf('string')
    expect(issueJson.command).toContain('bootstrapToken')

    const claimResponse = await app.request(
      'http://edge.test/api/bootstrap/claim',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hostId: 'host-bootstrap',
          hostname: 'machine-bootstrap',
          bootstrapToken: issueJson.bootstrapToken,
        }),
      },
      env,
    )
    const claimJson = (await claimResponse.json()) as { ok: true; token: string }

    expect(claimResponse.status).toBe(200)
    expect(claimJson.token).toBeTypeOf('string')

    const verifyResponse = await app.request(
      'http://edge.test/api/hosts/host-bootstrap/token/verify',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${claimJson.token}` },
      },
      env,
    )
    expect(verifyResponse.status).toBe(200)

    const reuseResponse = await app.request(
      'http://edge.test/api/bootstrap/claim',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hostId: 'host-bootstrap',
          hostname: 'machine-bootstrap',
          bootstrapToken: issueJson.bootstrapToken,
        }),
      },
      env,
    )

    expect(reuseResponse.status).toBe(409)
  })

  test('rejects expired bootstrap claim', async () => {
    const env = createEnv()
    const operatorHeader = {
      authorization: 'Bearer dev-operator-token',
      'content-type': 'application/json',
    }

    const issueResponse = await app.request(
      'http://edge.test/api/control/hosts/host-expired/bootstrap',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({
          hostname: 'machine-expired',
          edgeBaseUrl: 'http://edge.test',
          expiresInMs: 1,
        }),
      },
      env,
    )
    const issueJson = (await issueResponse.json()) as { bootstrapToken: string }
    expect(issueResponse.status).toBe(200)

    await Bun.sleep(5)

    const claimResponse = await app.request(
      'http://edge.test/api/bootstrap/claim',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          hostId: 'host-expired',
          hostname: 'machine-expired',
          bootstrapToken: issueJson.bootstrapToken,
        }),
      },
      env,
    )

    expect(claimResponse.status).toBe(409)
  })

  test('stores desired state without projecting routes until applied exists', async () => {
    const env = createEnv()
    const operatorHeader = {
      authorization: 'Bearer dev-operator-token',
      'content-type': 'application/json',
    }

    const desiredResponse = await app.request(
      'http://edge.test/api/control/hosts/host-phase2/desired',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({
          services: [
            {
              serviceId: 'svc-phase2',
              serviceName: 'phase2',
              localUrl: 'http://127.0.0.1:3301',
              protocol: 'http',
              subdomain: 'phase2.example.test',
            },
          ],
        }),
      },
      env,
    )

    expect(desiredResponse.status).toBe(200)

    const hostsResponse = await app.request('http://edge.test/api/control/hosts', { headers: operatorHeader }, env)
    const hosts = (await hostsResponse.json()) as HostControlState[]
    expect(hostsResponse.status).toBe(200)
    expect(hosts).toHaveLength(1)
    expect(hosts[0]?.desired?.generation).toBe(1)
    expect(hosts[0]?.applied).toBeNull()
    expect(hosts[0]?.projectedRoutes).toEqual([])

    const routesResponse = await app.request('http://edge.test/api/control/routes', { headers: operatorHeader }, env)
    const routes = (await routesResponse.json()) as Array<{ hostname: string }>
    expect(routesResponse.status).toBe(200)
    expect(routes).toEqual([])

    const legacyRoutesResponse = await app.request('http://edge.test/api/routes', { headers: operatorHeader }, env)
    const legacyRoutes = (await legacyRoutesResponse.json()) as RoutingEntry[]
    expect(legacyRoutes).toEqual([])
  })

  test('returns single host control state with runtime details', async () => {
    const env = createEnv()
    const operatorHeader = {
      authorization: 'Bearer dev-operator-token',
      'content-type': 'application/json',
    }

    const services = [
      {
        serviceId: 'svc-single-host',
        serviceName: 'single-host',
        localUrl: 'http://127.0.0.1:3310',
        protocol: 'http' as const,
        subdomain: 'single-host.example.test',
      },
    ]

    await app.request(
      'http://edge.test/api/control/hosts/host-single/desired',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ services }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/hosts/host-single/services',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${buildHostToken('host-single', env.OPERATOR_TOKEN)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: 'session-single',
          version: 1,
          services,
        }),
      },
      env,
    )

    const hostResponse = await app.request('http://edge.test/api/control/hosts/host-single', { headers: operatorHeader }, env)
    const host = (await hostResponse.json()) as HostControlState & {
      runtime: {
        sessionId: string
        version: number
        healthy: boolean
        lastHeartbeatAt: number | null
        disconnectedAt: number | null
        serviceCount: number
      } | null
    }

    expect(hostResponse.status).toBe(200)
    expect(host.hostId).toBe('host-single')
    expect(host.desired?.generation).toBe(1)
    expect(host.runtime?.sessionId).toBe('session-single')
    expect(host.runtime?.serviceCount).toBe(1)
  })

  test('projects routes only after current ack and applied promotion', async () => {
    const env = createEnv()
    const operatorHeader = {
      authorization: 'Bearer dev-operator-token',
      'content-type': 'application/json',
    }

    const services = [
      {
        serviceId: 'svc-phase2-applied',
        serviceName: 'phase2-applied',
        localUrl: 'http://127.0.0.1:3302',
        protocol: 'http' as const,
        subdomain: 'phase2-applied.example.test',
      },
    ]

    await app.request(
      'http://edge.test/api/control/hosts/host-phase2/desired',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ services }),
      },
      env,
    )

    const appliedBeforeAck = await app.request(
      'http://edge.test/api/control/hosts/host-phase2/applied',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, services }),
      },
      env,
    )
    expect(appliedBeforeAck.status).toBe(409)

    const currentResponse = await app.request(
      'http://edge.test/api/control/hosts/host-phase2/current',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({
          generation: 1,
          status: 'acknowledged',
          services,
        }),
      },
      env,
    )
    expect(currentResponse.status).toBe(200)

    const appliedResponse = await app.request(
      'http://edge.test/api/control/hosts/host-phase2/applied',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, services }),
      },
      env,
    )
    expect(appliedResponse.status).toBe(200)

    const hostsResponse = await app.request('http://edge.test/api/control/hosts', { headers: operatorHeader }, env)
    const hosts = (await hostsResponse.json()) as HostControlState[]
    expect(hosts[0]?.current?.status).toBe('acknowledged')
    expect(hosts[0]?.applied?.generation).toBe(1)
    expect(hosts[0]?.projectedRoutes[0]?.hostname).toBe('phase2-applied.example.test')

    const routesResponse = await app.request('http://edge.test/api/control/routes', { headers: operatorHeader }, env)
    const routes = (await routesResponse.json()) as HostControlState['projectedRoutes']
    expect(routes).toHaveLength(1)
    expect(routes[0]?.hostname).toBe('phase2-applied.example.test')
    expect(routes[0]?.serviceId).toBe('svc-phase2-applied')
    expect(routes[0]?.hostId).toBe('host-phase2')
    expect(routes[0]?.generation).toBe(1)
  })

  test('returns service reachability summaries for applied services', async () => {
    const env = {
      ...createEnv(),
      UI_PASSWORD: 'console-password',
      SESSION_SECRET: 'session-secret',
      SESSION_TTL_MS: '3600000',
    }
    const operatorHeader = {
      authorization: 'Bearer dev-operator-token',
      'content-type': 'application/json',
    }

    const services = [
      {
        serviceId: 'svc-reachability',
        serviceName: 'reachability',
        localUrl: 'http://127.0.0.1:3303',
        protocol: 'http' as const,
        subdomain: 'reachability.example.test',
      },
    ]

    await app.request(
      'http://edge.test/api/control/hosts/host-reachability/desired',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ services }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-reachability/current',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({
          generation: 1,
          status: 'acknowledged',
          services,
        }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-reachability/applied',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, services }),
      },
      env,
    )

    const restResponse = await app.request(
      'http://edge.test/api/control/services/reachability',
      { headers: operatorHeader },
      env,
    )
    const restSummaries = (await restResponse.json()) as Array<{
      serviceId: string
      reachability: string
      recentResults: Array<{ success: boolean; failureKind?: string }>
      hasProjectedRoute: boolean
      appliedGeneration: number | null
    }>
    expect(restResponse.status).toBe(200)
    expect(restSummaries[0]?.serviceId).toBe('svc-reachability')
    expect(restSummaries[0]?.reachability).toBe('reachable')
    expect(restSummaries[0]?.recentResults).toHaveLength(2)
    expect(restSummaries[0]?.hasProjectedRoute).toBe(true)
    expect(restSummaries[0]?.appliedGeneration).toBe(1)

    const executionCtx = { waitUntil() {}, passThroughOnException() {} }
    let cookieHeader: string | null = null

    const client = createTRPCProxyClient<AppRouter>({
      links: [
        httpBatchLink({
          url: 'http://edge.test/trpc',
          fetch: async (url, options) => {
            const headers = new Headers(options?.headers)
            if (cookieHeader) {
              headers.set('cookie', cookieHeader)
            }

            const requestInit: RequestInit = {
              method: options?.method ?? 'GET',
              headers,
            }
            if (options && 'body' in options) {
              requestInit.body = options.body ?? null
            }

            const response = await handleEdgeFetch(new Request(String(url), requestInit), env, executionCtx)
            const setCookie = response.headers.get('set-cookie')
            if (setCookie) {
              cookieHeader = setCookie.split(';')[0] ?? null
            }
            return response
          },
        }),
      ],
    })

    await client.auth.login.mutate({ password: 'console-password' })
    const trpcSummaries = await client.services.reachability.query()
    expect(trpcSummaries[0]?.serviceId).toBe('svc-reachability')
    expect(trpcSummaries[0]?.recentResults).toHaveLength(2)
  })

  test('returns service reachability summaries from analytics engine when configured', async () => {
    const env = {
      ...createEnv(),
      REACHABILITY_ANALYTICS_ACCOUNT_ID: 'account-123',
      REACHABILITY_ANALYTICS_API_TOKEN: 'token-123',
      REACHABILITY_ANALYTICS_DATASET: 'utunnel_reachability',
    }
    const operatorHeader = {
      authorization: 'Bearer dev-operator-token',
      'content-type': 'application/json',
    }

    const services = [
      {
        serviceId: 'svc-ae',
        serviceName: 'analytics-service',
        localUrl: 'http://127.0.0.1:3304',
        protocol: 'http' as const,
        subdomain: 'ae.example.test',
      },
    ]

    await app.request(
      'http://edge.test/api/control/hosts/host-ae/desired',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ services }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-ae/current',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({
          generation: 1,
          status: 'acknowledged',
          services,
        }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-ae/applied',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, services }),
      },
      env,
    )

    const originalFetch = globalThis.fetch
    let sqlRequestCount = 0

    const mockedFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)

        if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/accounts/account-123/analytics_engine/sql') {
          sqlRequestCount += 1
          expect(request.method).toBe('POST')
          expect(request.headers.get('authorization')).toBe('Bearer token-123')

          const sql = await request.text()
          expect(sql).toContain('FROM utunnel_reachability')
          expect(sql).toContain("blob1 = 'host-ae'")
          expect(sql).toContain("index1 = 'svc-ae'")

          return Response.json({
            meta: { rows: 2 },
            rows: [
              {
                hostId: 'host-ae',
                serviceId: 'svc-ae',
                checkedAt: 2000,
                statusCode: 503,
                latencyMs: 45,
                successState: 'fail',
                failureKind: 'status-code',
              },
              {
                hostId: 'host-ae',
                serviceId: 'svc-ae',
                checkedAt: 1500,
                statusCode: 200,
                latencyMs: 20,
                successState: 'ok',
                failureKind: 'none',
              },
            ],
          })
        }

        throw new Error(`unexpected fetch: ${url.toString()}`)
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    globalThis.fetch = mockedFetch

    try {
      const response = await app.request(
        'http://edge.test/api/control/services/reachability',
        { headers: operatorHeader },
        env,
      )
      const summaries = (await response.json()) as Array<{
        hostId: string
        serviceId: string
        reachability: string
        checkedAt: number | null
        lastSuccessAt: number | null
        lastFailureAt: number | null
        recentResults: Array<{ checkedAt: number; success: boolean; statusCode?: number; latencyMs?: number; failureKind?: string }>
        hasProjectedRoute: boolean
        appliedGeneration: number | null
      }>

      expect(response.status).toBe(200)
      expect(sqlRequestCount).toBe(1)
      expect(summaries[0]?.hostId).toBe('host-ae')
      expect(summaries[0]?.serviceId).toBe('svc-ae')
      expect(summaries[0]?.reachability).toBe('degraded')
      expect(summaries[0]?.checkedAt).toBe(2000)
      expect(summaries[0]?.lastSuccessAt).toBe(1500)
      expect(summaries[0]?.lastFailureAt).toBe(2000)
      expect(summaries[0]?.recentResults).toHaveLength(2)
      expect(summaries[0]?.recentResults[0]).toEqual({
        checkedAt: 2000,
        success: false,
        statusCode: 503,
        latencyMs: 45,
        failureKind: 'status-code',
      })
      expect(summaries[0]?.hasProjectedRoute).toBe(true)
      expect(summaries[0]?.appliedGeneration).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('falls back to DO reachability summaries when analytics dataset is missing', async () => {
    const env = {
      ...createEnv(),
      REACHABILITY_ANALYTICS_ACCOUNT_ID: 'account-123',
      REACHABILITY_ANALYTICS_API_TOKEN: 'token-123',
    }
    const operatorHeader = {
      authorization: 'Bearer dev-operator-token',
      'content-type': 'application/json',
    }

    const services = [
      {
        serviceId: 'svc-partial-config',
        serviceName: 'partial-config-service',
        localUrl: 'http://127.0.0.1:3305',
        protocol: 'http' as const,
        subdomain: 'partial-config.example.test',
      },
    ]

    await app.request(
      'http://edge.test/api/control/hosts/host-partial-config/desired',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ services }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-partial-config/current',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, status: 'acknowledged', services }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-partial-config/applied',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, services }),
      },
      env,
    )

    const originalFetch = globalThis.fetch
    let sqlRequestCount = 0
    const mockedFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        if (url.hostname === 'api.cloudflare.com') {
          sqlRequestCount += 1
          throw new Error('analytics engine should not be called when dataset is missing')
        }
        return originalFetch(input, init)
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    globalThis.fetch = mockedFetch

    try {
      const response = await app.request(
        'http://edge.test/api/control/services/reachability',
        { headers: operatorHeader },
        env,
      )
      const summaries = (await response.json()) as Array<{
        serviceId: string
        reachability: string
        recentResults: Array<{ success: boolean; failureKind?: string }>
      }>

      expect(response.status).toBe(200)
      expect(sqlRequestCount).toBe(0)
      expect(summaries[0]?.serviceId).toBe('svc-partial-config')
      expect(summaries[0]?.reachability).toBe('reachable')
      expect(summaries[0]?.recentResults).toHaveLength(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('falls back to DO reachability summaries when analytics query fails', async () => {
    const env = {
      ...createEnv(),
      REACHABILITY_ANALYTICS_ACCOUNT_ID: 'account-123',
      REACHABILITY_ANALYTICS_API_TOKEN: 'token-123',
      REACHABILITY_ANALYTICS_DATASET: 'utunnel_reachability',
    }
    const operatorHeader = {
      authorization: 'Bearer dev-operator-token',
      'content-type': 'application/json',
    }

    const services = [
      {
        serviceId: 'svc-ae-fallback',
        serviceName: 'ae-fallback-service',
        localUrl: 'http://127.0.0.1:3306',
        protocol: 'http' as const,
        subdomain: 'ae-fallback.example.test',
      },
    ]

    await app.request(
      'http://edge.test/api/control/hosts/host-ae-fallback/desired',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ services }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-ae-fallback/current',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, status: 'acknowledged', services }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-ae-fallback/applied',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, services }),
      },
      env,
    )

    const originalFetch = globalThis.fetch
    let sqlRequestCount = 0
    const mockedFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/accounts/account-123/analytics_engine/sql') {
          sqlRequestCount += 1
          return new Response('boom', { status: 503 })
        }
        return originalFetch(input, init)
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    globalThis.fetch = mockedFetch

    try {
      const response = await app.request(
        'http://edge.test/api/control/services/reachability',
        { headers: operatorHeader },
        env,
      )
      const summaries = (await response.json()) as Array<{
        serviceId: string
        reachability: string
        recentResults: Array<{ success: boolean; failureKind?: string }>
      }>

      expect(response.status).toBe(200)
      expect(sqlRequestCount).toBe(1)
      expect(summaries[0]?.serviceId).toBe('svc-ae-fallback')
      expect(summaries[0]?.reachability).toBe('reachable')
      expect(summaries[0]?.recentResults).toHaveLength(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('escapes quoted identifiers in analytics SQL query', async () => {
    const env = {
      ...createEnv(),
      REACHABILITY_ANALYTICS_ACCOUNT_ID: 'account-123',
      REACHABILITY_ANALYTICS_API_TOKEN: 'token-123',
      REACHABILITY_ANALYTICS_DATASET: 'utunnel_reachability',
    }
    const operatorHeader = {
      authorization: 'Bearer dev-operator-token',
      'content-type': 'application/json',
    }

    const hostId = "host'ae"
    const services = [
      {
        serviceId: "svc'ae",
        serviceName: 'quoted-service',
        localUrl: 'http://127.0.0.1:3307',
        protocol: 'http' as const,
        subdomain: 'quoted.example.test',
      },
    ]

    await app.request(
      `http://edge.test/api/control/hosts/${encodeURIComponent(hostId)}/desired`,
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ services }),
      },
      env,
    )

    await app.request(
      `http://edge.test/api/control/hosts/${encodeURIComponent(hostId)}/current`,
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, status: 'acknowledged', services }),
      },
      env,
    )

    await app.request(
      `http://edge.test/api/control/hosts/${encodeURIComponent(hostId)}/applied`,
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, services }),
      },
      env,
    )

    const originalFetch = globalThis.fetch
    let capturedSql = ''
    const mockedFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/accounts/account-123/analytics_engine/sql') {
          capturedSql = await request.text()
          return Response.json({ rows: [] })
        }
        return originalFetch(input, init)
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    globalThis.fetch = mockedFetch

    try {
      const response = await app.request(
        'http://edge.test/api/control/services/reachability',
        { headers: operatorHeader },
        env,
      )

      expect(response.status).toBe(200)
      expect(capturedSql).toContain("blob1 = 'host''ae'")
      expect(capturedSql).toContain("index1 = 'svc''ae'")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('falls back to DO reachability summaries when analytics response shape is invalid', async () => {
    const env = {
      ...createEnv(),
      REACHABILITY_ANALYTICS_ACCOUNT_ID: 'account-123',
      REACHABILITY_ANALYTICS_API_TOKEN: 'token-123',
      REACHABILITY_ANALYTICS_DATASET: 'utunnel_reachability',
    }
    const operatorHeader = {
      authorization: 'Bearer dev-operator-token',
      'content-type': 'application/json',
    }

    const services = [
      {
        serviceId: 'svc-ae-invalid-shape',
        serviceName: 'ae-invalid-shape-service',
        localUrl: 'http://127.0.0.1:3308',
        protocol: 'http' as const,
        subdomain: 'ae-invalid-shape.example.test',
      },
    ]

    await app.request(
      'http://edge.test/api/control/hosts/host-ae-invalid-shape/desired',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ services }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-ae-invalid-shape/current',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, status: 'acknowledged', services }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-ae-invalid-shape/applied',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, services }),
      },
      env,
    )

    const originalFetch = globalThis.fetch
    let sqlRequestCount = 0
    const mockedFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/accounts/account-123/analytics_engine/sql') {
          sqlRequestCount += 1
          return Response.json({ meta: { rows: 1 } })
        }
        return originalFetch(input, init)
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    globalThis.fetch = mockedFetch

    try {
      const response = await app.request(
        'http://edge.test/api/control/services/reachability',
        { headers: operatorHeader },
        env,
      )
      const summaries = (await response.json()) as Array<{
        serviceId: string
        reachability: string
        recentResults: Array<{ success: boolean; failureKind?: string }>
      }>

      expect(response.status).toBe(200)
      expect(sqlRequestCount).toBe(1)
      expect(summaries[0]?.serviceId).toBe('svc-ae-invalid-shape')
      expect(summaries[0]?.reachability).toBe('reachable')
      expect(summaries[0]?.recentResults).toHaveLength(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('falls back to DO reachability summaries when analytics rows are malformed', async () => {
    const env = {
      ...createEnv(),
      REACHABILITY_ANALYTICS_ACCOUNT_ID: 'account-123',
      REACHABILITY_ANALYTICS_API_TOKEN: 'token-123',
      REACHABILITY_ANALYTICS_DATASET: 'utunnel_reachability',
    }
    const operatorHeader = {
      authorization: 'Bearer dev-operator-token',
      'content-type': 'application/json',
    }

    const services = [
      {
        serviceId: 'svc-ae-invalid-row',
        serviceName: 'ae-invalid-row-service',
        localUrl: 'http://127.0.0.1:3309',
        protocol: 'http' as const,
        subdomain: 'ae-invalid-row.example.test',
      },
    ]

    await app.request(
      'http://edge.test/api/control/hosts/host-ae-invalid-row/desired',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ services }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-ae-invalid-row/current',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, status: 'acknowledged', services }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-ae-invalid-row/applied',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, services }),
      },
      env,
    )

    const originalFetch = globalThis.fetch
    let sqlRequestCount = 0
    const mockedFetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        const url = new URL(request.url)
        if (url.hostname === 'api.cloudflare.com' && url.pathname === '/client/v4/accounts/account-123/analytics_engine/sql') {
          sqlRequestCount += 1
          return Response.json({
            rows: [
              {
                hostId: 'host-ae-invalid-row',
                serviceId: 'svc-ae-invalid-row',
                checkedAt: 'not-a-number',
                statusCode: 200,
                latencyMs: 20,
                successState: 'ok',
              },
            ],
          })
        }
        return originalFetch(input, init)
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    globalThis.fetch = mockedFetch

    try {
      const response = await app.request(
        'http://edge.test/api/control/services/reachability',
        { headers: operatorHeader },
        env,
      )
      const summaries = (await response.json()) as Array<{
        serviceId: string
        reachability: string
        recentResults: Array<{ success: boolean; failureKind?: string }>
      }>

      expect(response.status).toBe(200)
      expect(sqlRequestCount).toBe(1)
      expect(summaries[0]?.serviceId).toBe('svc-ae-invalid-row')
      expect(summaries[0]?.reachability).toBe('reachable')
      expect(summaries[0]?.recentResults).toHaveLength(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('rejects unauthorized host mutations', async () => {
    const env = createEnv()
    const response = await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'session-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-1',
              serviceName: 'echo',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'echo.example.test',
            },
          ],
        }),
      },
      env,
    )

    expect(response.status).toBe(401)
  })

  test('rejects service hostnames outside root domain', async () => {
    const env = createEnv()
    const response = await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
        },
        body: JSON.stringify({
          sessionId: 'session-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-1',
              serviceName: 'echo',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'echo.other.test',
            },
          ],
        }),
      },
      env,
    )

    expect(response.status).toBe(400)
  })

  test('supports authorized connect route via header auth', async () => {
    const env = createEnv()
    const response = await app.request(
      'http://edge.test/connect?hostId=host-1',
      {
        method: 'GET',
        headers: {
          Upgrade: 'websocket',
          Authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
        },
      },
      env,
    )

    expect(response.status).toBe(200)
  })

  test('reports host health from session heartbeat state', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    const register = await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-health-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-health',
              serviceName: 'health',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'health.example.test',
            },
          ],
        }),
      },
      env,
    )
    expect(register.status).toBe(200)

    const operatorHeader = { authorization: 'Bearer dev-operator-token' }
    const health = await app.request('http://edge.test/api/hosts/host-1/health', { headers: operatorHeader }, env)
    const json = (await health.json()) as {
      hostId: string
      sessionId: string
      version: number
      healthy: boolean
      lastHeartbeatAt: number
      disconnectedAt: number | null
      serviceCount: number
    }

    expect(health.status).toBe(200)
    expect(json.hostId).toBe('host-1')
    expect(json.sessionId).toBe('session-health-1')
    expect(json.healthy).toBe(true)
    expect(json.lastHeartbeatAt).toBeTypeOf('number')
    expect(json.serviceCount).toBe(1)
  })

  test('registers routes and cleans up stale bindings', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    const register = await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-1',
              serviceName: 'echo',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'Echo.Example.test:443',
            },
          ],
        }),
      },
      env,
    )
    expect(register.status).toBe(200)

    const operatorHeader = { authorization: 'Bearer dev-operator-token' }
    const routesBefore = await app.request('http://edge.test/api/routes', { headers: operatorHeader }, env)
    const beforeJson = (await routesBefore.json()) as RoutingEntry[]
    expect(beforeJson).toHaveLength(1)
    expect(beforeJson[0]?.hostname).toBe('echo.example.test')

    const disconnect = await app.request(
      'http://edge.test/api/hosts/host-1/disconnect',
      { method: 'POST', headers: authHeader },
      env,
    )
    expect(disconnect.status).toBe(200)

    await new Promise((resolve) => setTimeout(resolve, 120))

    const cleanup = await app.request(
      'http://edge.test/api/hosts/host-1/cleanup-stale',
      { method: 'POST', headers: authHeader },
      env,
    )
    expect(cleanup.status).toBe(200)

    const routesAfter = await app.request('http://edge.test/api/routes', { headers: operatorHeader }, env)
    const afterJson = (await routesAfter.json()) as RoutingEntry[]
    expect(afterJson).toHaveLength(0)
  })


  test('routes multiple services on the same host without cross-wiring', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    const register = await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-multi-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-one',
              serviceName: 'one',
              localUrl: 'http://127.0.0.1:3101',
              protocol: 'http',
              subdomain: 'one.example.test',
            },
            {
              serviceId: 'svc-two',
              serviceName: 'two',
              localUrl: 'http://127.0.0.1:3102',
              protocol: 'http',
              subdomain: 'two.example.test',
            },
          ],
        }),
      },
      env,
    )
    expect(register.status).toBe(200)

    const [oneResponse, twoResponse] = await Promise.all([
      app.request('http://edge.test/tunnel/one?x=1', { headers: { host: 'one.example.test' } }, env),
      app.request('http://edge.test/tunnel/two?y=1', { headers: { host: 'two.example.test' } }, env),
    ])

    const oneJson = (await oneResponse.json()) as Record<string, string | null>
    const twoJson = (await twoResponse.json()) as Record<string, string | null>
    const host = env.HOST_SESSION.get('host-1')

    expect(oneResponse.status).toBe(200)
    expect(twoResponse.status).toBe(200)
    expect(oneJson.serviceId).toBe('svc-one')
    expect(twoJson.serviceId).toBe('svc-two')
    expect(host.relayHttpHistory).toHaveLength(2)
    expect(host.relayHttpHistory.map((entry) => entry.request.payload.serviceId).sort()).toEqual(['svc-one', 'svc-two'])
    expect(host.relayHttpHistory.map((entry) => entry.request.payload.path).sort()).toEqual(['/one?x=1', '/two?y=1'])
  })

  test('removes stale host routes when service registration drops a hostname', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    const firstRegister = await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-prune-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-keep',
              serviceName: 'keep',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'keep.example.test',
            },
            {
              serviceId: 'svc-drop',
              serviceName: 'drop',
              localUrl: 'http://127.0.0.1:3002',
              protocol: 'http',
              subdomain: 'drop.example.test',
            },
          ],
        }),
      },
      env,
    )
    expect(firstRegister.status).toBe(200)

    const secondRegister = await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-prune-2',
          version: 2,
          services: [
            {
              serviceId: 'svc-keep',
              serviceName: 'keep',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'keep.example.test',
            },
          ],
        }),
      },
      env,
    )
    expect(secondRegister.status).toBe(200)

    const operatorHeader = { authorization: 'Bearer dev-operator-token' }
    const routes = await app.request('http://edge.test/api/routes', { headers: operatorHeader }, env)
    const routeJson = (await routes.json()) as RoutingEntry[]
    expect(routeJson).toHaveLength(1)
    expect(routeJson[0]?.hostname).toBe('keep.example.test')
    expect(routeJson[0]?.sessionId).toBe('session-prune-2')

    const keepResponse = await app.request(
      'http://edge.test/tunnel/ok',
      { headers: { host: 'keep.example.test' } },
      env,
    )
    expect(keepResponse.status).toBe(200)

    const droppedResponse = await app.request(
      'http://edge.test/tunnel/missing',
      { headers: { host: 'drop.example.test' } },
      env,
    )
    const droppedJson = (await droppedResponse.json()) as { error: string }
    expect(droppedResponse.status).toBe(404)
    expect(droppedJson).toEqual({ error: 'route_not_found' })
  })

  test('lets a fast service finish before a delayed sibling service on the same host', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    const register = await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-concurrency-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-fast',
              serviceName: 'fast',
              localUrl: 'http://127.0.0.1:3101',
              protocol: 'http',
              subdomain: 'fast.example.test',
            },
            {
              serviceId: 'svc-slow',
              serviceName: 'slow',
              localUrl: 'http://127.0.0.1:3102',
              protocol: 'http',
              subdomain: 'slow.example.test',
            },
          ],
        }),
      },
      env,
    )
    expect(register.status).toBe(200)

    const host = env.HOST_SESSION.get('host-1') as FakeHostStub & {
      httpDelayMsByServiceId?: Map<string, number>
    }
    host.httpDelayMsByServiceId = new Map([['svc-slow', 50]])

    let fastFinishedAt = 0
    let slowFinishedAt = 0

    const fastPromise = Promise.resolve(
      app.request('http://edge.test/tunnel/fast', { headers: { host: 'fast.example.test' } }, env),
    ).then((response) => {
      fastFinishedAt = Date.now()
      return response
    })

    const slowPromise = Promise.resolve(
      app.request('http://edge.test/tunnel/slow', { headers: { host: 'slow.example.test' } }, env),
    ).then((response) => {
      slowFinishedAt = Date.now()
      return response
    })

    const [fastResponse, slowResponse] = await Promise.all([fastPromise, slowPromise])
    const fastJson = (await fastResponse.json()) as Record<string, string | null>
    const slowJson = (await slowResponse.json()) as Record<string, string | null>

    expect(fastResponse.status).toBe(200)
    expect(slowResponse.status).toBe(200)
    expect(fastJson.serviceId).toBe('svc-fast')
    expect(slowJson.serviceId).toBe('svc-slow')
    expect(fastFinishedAt).toBeLessThan(slowFinishedAt)
  })

  test('keeps websocket upgrades responsive while a delayed http service is in flight', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    const register = await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-concurrency-2',
          version: 1,
          services: [
            {
              serviceId: 'svc-slow-http',
              serviceName: 'slow-http',
              localUrl: 'http://127.0.0.1:3201',
              protocol: 'http',
              subdomain: 'slow-http.example.test',
            },
            {
              serviceId: 'svc-fast-ws',
              serviceName: 'fast-ws',
              localUrl: 'http://127.0.0.1:3202',
              protocol: 'websocket',
              subdomain: 'fast-ws.example.test',
            },
          ],
        }),
      },
      env,
    )
    expect(register.status).toBe(200)

    const host = env.HOST_SESSION.get('host-1') as FakeHostStub & {
      httpDelayMsByServiceId?: Map<string, number>
    }
    host.httpDelayMsByServiceId = new Map([['svc-slow-http', 50]])

    let httpFinishedAt = 0
    let wsFinishedAt = 0

    const slowHttpPromise = Promise.resolve(
      app.request('http://edge.test/tunnel/slow-http', { headers: { host: 'slow-http.example.test' } }, env),
    ).then((response) => {
      httpFinishedAt = Date.now()
      return response
    })

    const wsPromise = Promise.resolve(
      app.request(
        'http://edge.test/tunnel/socket?channel=slow-proof',
        {
          method: 'GET',
          headers: {
            host: 'fast-ws.example.test',
            upgrade: 'websocket',
          },
        },
        env,
      ),
    ).then((response) => {
      wsFinishedAt = Date.now()
      return response
    })

    const [slowHttpResponse, wsResponse] = await Promise.all([slowHttpPromise, wsPromise])

    expect(slowHttpResponse.status).toBe(200)
    expect(wsResponse.status).toBe(101)
    expect(host.lastRelayWs?.request.payload.serviceId).toBe('svc-fast-ws')
    expect(wsFinishedAt).toBeLessThan(httpFinishedAt)
  })

  test('routes multiple host subdomains to the correct owning host', async () => {
    const env = createEnv()
    const registerHost = async (
      hostId: string,
      sessionId: string,
      version: number,
      serviceId: string,
      subdomain: string,
      localUrl: string,
    ) => {
      return app.request(
        `http://edge.test/api/hosts/${hostId}/services`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${buildHostToken(hostId, env.OPERATOR_TOKEN)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            sessionId,
            version,
            services: [
              {
                serviceId,
                serviceName: serviceId,
                localUrl,
                protocol: 'http',
                subdomain,
              },
            ],
          }),
        },
        env,
      )
    }

    expect(await registerHost('host-1', 'session-a', 1, 'svc-a', 'alpha.example.test', 'http://127.0.0.1:3001')).toHaveProperty('status', 200)
    expect(await registerHost('host-2', 'session-b', 1, 'svc-b', 'beta.example.test', 'http://127.0.0.1:3002')).toHaveProperty('status', 200)
    expect(await registerHost('host-3', 'session-c', 1, 'svc-c', 'gamma.example.test', 'http://127.0.0.1:3003')).toHaveProperty('status', 200)

    const alphaResponse = await app.request('http://edge.test/tunnel/demo?a=1', { headers: { host: 'alpha.example.test' } }, env)
    const betaResponse = await app.request('http://edge.test/tunnel/demo?b=1', { headers: { host: 'beta.example.test' } }, env)
    const gammaResponse = await app.request('http://edge.test/tunnel/demo?c=1', { headers: { host: 'gamma.example.test' } }, env)

    const alphaJson = (await alphaResponse.json()) as Record<string, string | null>
    const betaJson = (await betaResponse.json()) as Record<string, string | null>
    const gammaJson = (await gammaResponse.json()) as Record<string, string | null>

    expect(alphaResponse.status).toBe(200)
    expect(betaResponse.status).toBe(200)
    expect(gammaResponse.status).toBe(200)

    expect(alphaJson.serviceId).toBe('svc-a')
    expect(betaJson.serviceId).toBe('svc-b')
    expect(gammaJson.serviceId).toBe('svc-c')

    const host1 = env.HOST_SESSION.get('host-1')
    const host2 = env.HOST_SESSION.get('host-2')
    const host3 = env.HOST_SESSION.get('host-3')

    expect(host1.lastRelayHttp?.request.payload.path).toBe('/demo?a=1')
    expect(host2.lastRelayHttp?.request.payload.path).toBe('/demo?b=1')
    expect(host3.lastRelayHttp?.request.payload.path).toBe('/demo?c=1')
    expect(host1.lastRelayHttp?.request.payload.serviceId).toBe('svc-a')
    expect(host2.lastRelayHttp?.request.payload.serviceId).toBe('svc-b')
    expect(host3.lastRelayHttp?.request.payload.serviceId).toBe('svc-c')
  })


  test('records reachability observations from tunnel traffic', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }
    const operatorHeader = {
      authorization: 'Bearer dev-operator-token',
      'content-type': 'application/json',
    }

    const services = [
      {
        serviceId: 'svc-traffic',
        serviceName: 'traffic',
        localUrl: 'http://127.0.0.1:3001',
        protocol: 'http' as const,
        subdomain: 'traffic.example.test',
      },
    ]

    await app.request(
      'http://edge.test/api/control/hosts/host-1/desired',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ services }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-1/current',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({
          generation: 1,
          status: 'acknowledged',
          services,
        }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/control/hosts/host-1/applied',
      {
        method: 'POST',
        headers: operatorHeader,
        body: JSON.stringify({ generation: 1, services }),
      },
      env,
    )

    await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-traffic-1',
          version: 1,
          services,
        }),
      },
      env,
    )

    const tunnelResponse = await app.request(
      'http://edge.test/tunnel/live',
      {
        headers: {
          host: 'traffic.example.test',
        },
      },
      env,
    )
    expect(tunnelResponse.status).toBe(200)

    const reachabilityResponse = await app.request(
      'http://edge.test/api/control/services/reachability',
      { headers: { authorization: 'Bearer dev-operator-token' } },
      env,
    )
    const summaries = (await reachabilityResponse.json()) as Array<{
      serviceId: string
      recentResults: Array<{ success: boolean; statusCode?: number }>
      checkedAt: number | null
    }>

    expect(reachabilityResponse.status).toBe(200)
    expect(summaries[0]?.serviceId).toBe('svc-traffic')
    expect(summaries[0]?.recentResults[0]?.success).toBe(true)
    expect(summaries[0]?.recentResults[0]?.statusCode).toBe(200)
    expect(summaries[0]?.checkedAt).not.toBeNull()
  })

  test('relays public tunnel request to owning host', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-1',
              serviceName: 'echo',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'echo.example.test',
            },
          ],
        }),
      },
      env,
    )

    const response = await app.request(
      'http://edge.test/tunnel/status?check=1',
      {
        headers: {
          host: 'echo.example.test',
          'x-forwarded-for': '1.2.3.4',
          'x-forwarded-port': '443',
          'proxy-authorization': 'Basic abc',
        },
      },
      env,
    )
    const json = (await response.json()) as Record<string, string | null>

    expect(response.status).toBe(200)
    expect(response.headers.get('x-utunnel-relay')).toBe('fake-host')
    expect(json.serviceId).toBe('svc-1')
    expect(json.path).toBe('/status?check=1')
    expect(json.method).toBe('GET')
    expect(json.forwardedHostHeader).toBeNull()
    expect(json.forwardedXffHeader).toBeNull()
    expect(json.forwardedPortHeader).toBeNull()
    expect(json.proxyAuthorizationHeader).toBeNull()
  })

  test('upgrades websocket tunnel request to owning host session', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-ws-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-ws',
              serviceName: 'echo-ws',
              localUrl: 'http://127.0.0.1:3002',
              protocol: 'websocket',
              subdomain: 'ws.example.test',
            },
          ],
        }),
      },
      env,
    )

    const response = await app.request(
      'http://edge.test/tunnel/socket?channel=1',
      {
        method: 'GET',
        headers: {
          host: 'ws.example.test',
          upgrade: 'websocket',
        },
      },
      env,
    )

    const hostStub = env.HOST_SESSION.get('host-1')

    expect(response.status).toBe(101)
    expect(hostStub.lastRelayWs?.expectedSessionId).toBe('session-ws-1')
    expect(hostStub.lastRelayWs?.expectedVersion).toBe(1)
    expect(hostStub.lastRelayWs?.request.payload.serviceId).toBe('svc-ws')
    expect(hostStub.lastRelayWs?.request.payload.path).toBe('/socket?channel=1')
  })

  test('upgrades websocket tunnel request from local dev host when route host is provided in query', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-ws-local-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-ws-local',
              serviceName: 'echo-ws-local',
              localUrl: 'http://127.0.0.1:3002',
              protocol: 'websocket',
              subdomain: 'ws-local.example.test',
            },
          ],
        }),
      },
      env,
    )

    const response = await app.request(
      'http://127.0.0.1/tunnel/socket?channel=1&__utunnel_host=ws-local.example.test',
      {
        method: 'GET',
        headers: {
          host: '127.0.0.1',
          upgrade: 'websocket',
        },
      },
      env,
    )

    const hostStub = env.HOST_SESSION.get('host-1')

    expect(response.status).toBe(101)
    expect(hostStub.lastRelayWs?.request.payload.serviceId).toBe('svc-ws-local')
    expect(hostStub.lastRelayWs?.request.payload.path).toBe('/socket?channel=1')
  })

  test('upgrades websocket tunnel request from local dev url without host header when query override is provided', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-ws-local-url-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-ws-local-url',
              serviceName: 'echo-ws-local-url',
              localUrl: 'http://127.0.0.1:3002',
              protocol: 'websocket',
              subdomain: 'ws-local-url.example.test',
            },
          ],
        }),
      },
      env,
    )

    const request = new Request(
      'http://127.0.0.1/tunnel/socket?channel=1&__utunnel_host=ws-local-url.example.test',
      {
        method: 'GET',
        headers: {
          upgrade: 'websocket',
        },
      },
    )

    const response = await app.fetch(request, env)
    const hostStub = env.HOST_SESSION.get('host-1')

    expect(response.status).toBe(101)
    expect(hostStub.lastRelayWs?.request.payload.serviceId).toBe('svc-ws-local-url')
    expect(hostStub.lastRelayWs?.request.payload.path).toBe('/socket?channel=1')
  })

  test('upgrades websocket tunnel request from local dev path override', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-ws-local-path-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-ws-local-path',
              serviceName: 'echo-ws-local-path',
              localUrl: 'http://127.0.0.1:3002',
              protocol: 'websocket',
              subdomain: 'ws-local-path.example.test',
            },
          ],
        }),
      },
      env,
    )

    const response = await app.request(
      'http://127.0.0.1/tunnel/__utunnel_host/ws-local-path.example.test/socket?channel=1',
      {
        method: 'GET',
        headers: {
          host: '127.0.0.1',
          upgrade: 'websocket',
        },
      },
      env,
    )

    const hostStub = env.HOST_SESSION.get('host-1')

    expect(response.status).toBe(101)
    expect(hostStub.lastRelayWs?.request.payload.serviceId).toBe('svc-ws-local-path')
    expect(hostStub.lastRelayWs?.request.payload.path).toBe('/socket?channel=1')
  })

  test('websocket upgrade fails closed when route points to a disconnected session', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-ws-stale',
          version: 1,
          services: [
            {
              serviceId: 'svc-ws-stale',
              serviceName: 'echo-ws-stale',
              localUrl: 'http://127.0.0.1:3003',
              protocol: 'websocket',
              subdomain: 'stale-ws.example.test',
            },
          ],
        }),
      },
      env,
    )

    const disconnect = await app.request(
      'http://edge.test/api/hosts/host-1/disconnect',
      { method: 'POST', headers: authHeader },
      env,
    )
    expect(disconnect.status).toBe(200)

    const response = await app.request(
      'http://edge.test/tunnel/socket',
      {
        method: 'GET',
        headers: {
          host: 'stale-ws.example.test',
          upgrade: 'websocket',
        },
      },
      env,
    )

    expect(response.status).toBe(409)
    const json = (await response.json()) as { ok: boolean; reason: string }
    expect(json).toEqual({ ok: false, reason: 'stale_session_binding' })
  })

  test('rejects invalid relay path before forwarding', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-1',
              serviceName: 'echo',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'echo.example.test',
            },
          ],
        }),
      },
      env,
    )

    const response = await app.request(
      'http://edge.test/tunnel//169.254.169.254/latest',
      { headers: { host: 'echo.example.test' } },
      env,
    )

    expect(response.status).toBe(400)
    const json = (await response.json()) as { error: string }
    expect(json).toEqual({ error: 'invalid_relay_path' })
  })

  test('fails closed when route still points at a disconnected session', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-1',
              serviceName: 'echo',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'echo.example.test',
            },
          ],
        }),
      },
      env,
    )

    const disconnect = await app.request(
      'http://edge.test/api/hosts/host-1/disconnect',
      { method: 'POST', headers: authHeader },
      env,
    )
    expect(disconnect.status).toBe(200)

    const response = await app.request(
      'http://edge.test/tunnel/status',
      { headers: { host: 'echo.example.test' } },
      env,
    )
    const json = (await response.json()) as { ok: false; reason: string }

    expect(response.status).toBe(409)
    expect(json.reason).toBe('stale_session_binding')
  })

  test('fails closed when host session state is lost while route still exists', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-loss-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-loss',
              serviceName: 'echo-loss',
              localUrl: 'http://127.0.0.1:3004',
              protocol: 'http',
              subdomain: 'loss.example.test',
            },
          ],
        }),
      },
      env,
    )

    await env.HOST_SESSION.get('host-1').fetch('https://host.internal/clear', { method: 'POST' })

    const response = await app.request(
      'http://edge.test/tunnel/lost',
      { headers: { host: 'loss.example.test' } },
      env,
    )
    const json = (await response.json()) as { ok: boolean; reason: string }

    expect(response.status).toBe(409)
    expect(json).toEqual({ ok: false, reason: 'stale_session_binding' })
  })

  test('rebinds to a new session and restores traffic with the same hostname', async () => {

    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    const initialRegister = await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-1',
              serviceName: 'echo',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'echo.example.test',
            },
          ],
        }),
      },
      env,
    )
    expect(initialRegister.status).toBe(200)

    const disconnect = await app.request(
      'http://edge.test/api/hosts/host-1/disconnect',
      { method: 'POST', headers: authHeader },
      env,
    )
    expect(disconnect.status).toBe(200)

    const failClosed = await app.request(
      'http://edge.test/tunnel/status',
      { headers: { host: 'echo.example.test' } },
      env,
    )
    expect(failClosed.status).toBe(409)

    const rebind = await app.request(
      'http://edge.test/api/hosts/host-1/rebind',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          previousSessionId: 'session-1',
          sessionId: 'session-2',
          version: 2,
          services: [
            {
              serviceId: 'svc-1',
              serviceName: 'echo',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'echo.example.test',
            },
          ],
        }),
      },
      env,
    )
    expect(rebind.status).toBe(200)

    const operatorHeader = { authorization: 'Bearer dev-operator-token' }
    const routes = await app.request('http://edge.test/api/routes', { headers: operatorHeader }, env)
    const routeJson = (await routes.json()) as RoutingEntry[]
    expect(routeJson).toHaveLength(1)
    expect(routeJson[0]?.hostname).toBe('echo.example.test')
    expect(routeJson[0]?.sessionId).toBe('session-2')
    expect(routeJson[0]?.version).toBe(2)

    const session = await app.request('http://edge.test/api/hosts/host-1/session', { headers: operatorHeader }, env)
    const sessionJson = (await session.json()) as SessionRecord
    expect(sessionJson.sessionId).toBe('session-2')
    expect(sessionJson.version).toBe(2)
    expect(sessionJson.disconnectedAt).toBeNull()

    const restored = await app.request(
      'http://edge.test/tunnel/status?after=rebind',
      { headers: { host: 'echo.example.test' } },
      env,
    )
    const restoredJson = (await restored.json()) as Record<string, string | null>

    expect(restored.status).toBe(200)
    expect(restoredJson.path).toBe('/status?after=rebind')
    expect(restoredJson.serviceId).toBe('svc-1')
  })

  test('rebind removes stale host routes that are no longer declared', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    const initialRegister = await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-rebind-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-keep',
              serviceName: 'keep',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'keep.example.test',
            },
            {
              serviceId: 'svc-drop',
              serviceName: 'drop',
              localUrl: 'http://127.0.0.1:3002',
              protocol: 'http',
              subdomain: 'drop.example.test',
            },
          ],
        }),
      },
      env,
    )
    expect(initialRegister.status).toBe(200)

    const disconnect = await app.request(
      'http://edge.test/api/hosts/host-1/disconnect',
      { method: 'POST', headers: authHeader },
      env,
    )
    expect(disconnect.status).toBe(200)

    const rebind = await app.request(
      'http://edge.test/api/hosts/host-1/rebind',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          previousSessionId: 'session-rebind-1',
          sessionId: 'session-rebind-2',
          version: 2,
          services: [
            {
              serviceId: 'svc-keep',
              serviceName: 'keep',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'keep.example.test',
            },
          ],
        }),
      },
      env,
    )
    expect(rebind.status).toBe(200)

    const operatorHeader = { authorization: 'Bearer dev-operator-token' }
    const routes = await app.request('http://edge.test/api/routes', { headers: operatorHeader }, env)
    const routeJson = (await routes.json()) as RoutingEntry[]
    expect(routeJson).toHaveLength(1)
    expect(routeJson[0]?.hostname).toBe('keep.example.test')
    expect(routeJson[0]?.sessionId).toBe('session-rebind-2')
    expect(routeJson[0]?.version).toBe(2)

    const keptResponse = await app.request(
      'http://edge.test/tunnel/status?after=rebind',
      { headers: { host: 'keep.example.test' } },
      env,
    )
    expect(keptResponse.status).toBe(200)

    const droppedResponse = await app.request(
      'http://edge.test/tunnel/status?after=rebind',
      { headers: { host: 'drop.example.test' } },
      env,
    )
    const droppedJson = (await droppedResponse.json()) as { error: string }
    expect(droppedResponse.status).toBe(404)
    expect(droppedJson).toEqual({ error: 'route_not_found' })
  })

  test('rejects rebind when previous session id mismatches', async () => {
    const env = createEnv()
    const authHeader = {
      authorization: `Bearer ${buildHostToken('host-1', env.OPERATOR_TOKEN)}`,
      'content-type': 'application/json',
    }

    await app.request(
      'http://edge.test/api/hosts/host-1/services',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          sessionId: 'session-1',
          version: 1,
          services: [
            {
              serviceId: 'svc-1',
              serviceName: 'echo',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'echo.example.test',
            },
          ],
        }),
      },
      env,
    )

    const rebind = await app.request(
      'http://edge.test/api/hosts/host-1/rebind',
      {
        method: 'POST',
        headers: authHeader,
        body: JSON.stringify({
          previousSessionId: 'wrong-session',
          sessionId: 'session-2',
          version: 2,
          services: [
            {
              serviceId: 'svc-1',
              serviceName: 'echo',
              localUrl: 'http://127.0.0.1:3001',
              protocol: 'http',
              subdomain: 'echo.example.test',
            },
          ],
        }),
      },
      env,
    )

    expect(rebind.status).toBe(409)
  })

  test('supports single-user password login and session me/logout flow', async () => {
    const env = {
      ...createEnv(),
      UI_PASSWORD: 'console-password',
      SESSION_SECRET: 'session-secret',
      SESSION_TTL_MS: '3600000',
    }

    const unauthorizedMe = await app.request('http://edge.test/api/auth/me', {}, env)
    expect(unauthorizedMe.status).toBe(401)

    const login = await app.request(
      'http://edge.test/api/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'console-password' }),
      },
      env,
    )

    const loginJson = (await login.json()) as {
      ok: boolean
      user: { id: string }
    }
    const sessionCookie = login.headers.get('set-cookie')

    expect(login.status).toBe(200)
    expect(loginJson).toEqual({ ok: true, user: { id: 'personal' } })
    expect(sessionCookie).toContain('utunnel_session=')
    expect(sessionCookie).toContain('HttpOnly')

    const me = await app.request(
      'http://edge.test/api/auth/me',
      {
        headers: { cookie: sessionCookie! },
      },
      env,
    )
    const meJson = (await me.json()) as {
      ok: boolean
      user: { id: string }
    }

    expect(me.status).toBe(200)
    expect(meJson).toEqual({ ok: true, user: { id: 'personal' } })

    const logout = await app.request(
      'http://edge.test/api/auth/logout',
      {
        method: 'POST',
        headers: { cookie: sessionCookie! },
      },
      env,
    )
    const logoutJson = (await logout.json()) as { ok: boolean }
    const clearedCookie = logout.headers.get('set-cookie')

    expect(logout.status).toBe(200)
    expect(logoutJson).toEqual({ ok: true })
    expect(clearedCookie).toContain('utunnel_session=')
  })

  test('returns session-protected dashboard summary from routes and health state', async () => {
    const env = {
      ...createEnv(),
      UI_PASSWORD: 'console-password',
      SESSION_SECRET: 'session-secret',
      SESSION_TTL_MS: '3600000',
    }

    const registerHost = async (hostId: string, sessionId: string, subdomain: string) => {
      return app.request(
        `http://edge.test/api/hosts/${hostId}/services`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${buildHostToken(hostId, env.OPERATOR_TOKEN)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            sessionId,
            version: 1,
            services: [
              {
                serviceId: `${hostId}-svc`,
                serviceName: hostId,
                localUrl: 'http://127.0.0.1:3001',
                protocol: 'http',
                subdomain,
              },
            ],
          }),
        },
        env,
      )
    }

    expect(await registerHost('host-1', 'session-1', 'one.example.test')).toHaveProperty('status', 200)
    expect(await registerHost('host-2', 'session-2', 'two.example.test')).toHaveProperty('status', 200)

    const now = Date.now()
    const connectedHost = env.HOST_SESSION.get('host-1')
    connectedHost.session = {
      ...connectedHost.session!,
      connectedAt: now - 200,
      lastHeartbeatAt: now - 100,
      disconnectedAt: null,
    }

    const disconnectedHost = env.HOST_SESSION.get('host-2')
    disconnectedHost.session = {
      ...disconnectedHost.session!,
      connectedAt: now - 1_500,
      disconnectedAt: now - 50,
      lastHeartbeatAt: now - 10_000,
    }

    const login = await app.request(
      'http://edge.test/api/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'console-password' }),
      },
      env,
    )
    const sessionCookie = login.headers.get('set-cookie')

    const summary = await app.request(
      'http://edge.test/api/dashboard/summary',
      {
        headers: { cookie: sessionCookie! },
      },
      env,
    )
    const summaryJson = (await summary.json()) as {
      hostCount: number
      onlineHostCount: number
      routeCount: number
      unhealthyHostCount: number
      recentHosts: Array<{
        hostId: string
        healthy: boolean
        disconnectedAt: number | null
      }>
    }

    expect(summary.status).toBe(200)
    expect(summaryJson.hostCount).toBe(2)
    expect(summaryJson.onlineHostCount).toBe(1)
    expect(summaryJson.routeCount).toBe(2)
    expect(summaryJson.unhealthyHostCount).toBe(1)
    expect(summaryJson.recentHosts.map((host) => [host.hostId, host.healthy])).toEqual([
      ['host-2', false],
      ['host-1', true],
    ])
  })
})
