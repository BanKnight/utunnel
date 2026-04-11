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

  test('does not expose route metadata on public tunnel route', async () => {
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
      'http://edge.test/tunnel/status',
      { headers: { host: 'echo.example.test' } },
      env,
    )
    const json = (await response.json()) as Record<string, unknown>

    expect(response.status).toBe(200)
    expect(json.route).toBeUndefined()
    expect(json.status).toBe('route_bound')
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
