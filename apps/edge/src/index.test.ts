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
  disconnectedAt: number | null
}

class FakeHostStub {
  session: SessionRecord | null = null

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)

    if (request.headers.get('Upgrade') === 'websocket' && url.pathname === '/connect') {
      return new Response('connected')
    }

    if (request.method === 'POST' && url.pathname === '/register') {
      this.session = (await request.json()) as SessionRecord
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

      if (
        !this.session ||
        this.session.disconnectedAt !== null ||
        this.session.sessionId !== relay.expectedSessionId ||
        this.session.version !== relay.expectedVersion
      ) {
        return Response.json({ ok: false, reason: 'stale_session_binding' }, { status: 409 })
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

    if (request.method === 'POST' && url.pathname === '/relay-ws') {
      const relay = (await request.json()) as {
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

    expect(response.status).toBe(101)
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
