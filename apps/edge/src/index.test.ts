import { describe, expect, test } from 'bun:test'
import { app } from './app'
import { buildHostToken } from './lib'

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

const createEnv = () => {
  const routingStub = new FakeRoutingStub()
  const routing = new FakeRoutingNamespace(routingStub)
  const hosts = new FakeHostNamespace()

  return {
    ROOT_DOMAIN: 'example.test',
    OPERATOR_TOKEN: 'dev-operator-token',
    STALE_ROUTE_GRACE_MS: '100',
    HEARTBEAT_GRACE_MS: '1000',
    ROUTING_DIRECTORY: routing,
    HOST_SESSION: hosts,
  }
}

describe('edge app integration', () => {
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
})
