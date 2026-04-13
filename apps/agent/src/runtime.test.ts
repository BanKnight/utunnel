import { describe, expect, test } from 'bun:test'
import { parseAgentConfig } from '@utunnel/config'
import type {
  HttpRequestMessage,
  WebSocketCloseMessage,
  WebSocketFrameMessage,
  WebSocketOpenMessage,
} from '@utunnel/protocol'
import { buildServiceBindingPayload, createDefaultAgentConfig, createNextRuntimeState, resolveRegistrationPath } from './runtime'
import {
  claimBootstrapToken,
  createRelayState,
  forwardHttpRequest,
  handleAgentSocketMessage,
  handleTunnelMessage,
  requireAgentToken,
  sendHeartbeat,
  type AgentRuntimeContext,
} from './index'

class FakeUpstreamSocket {
  listeners = new Map<string, Array<(event?: { code?: number; data?: string; reason?: string }) => void>>()
  sent: string[] = []
  closed: Array<{ code?: number | undefined; reason?: string | undefined }> = []

  addEventListener(type: string, listener: (event?: { code?: number; data?: string; reason?: string }) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, [])
    }
    this.listeners.get(type)!.push(listener)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close(code?: number, reason?: string) {
    this.closed.push({ code, reason })
  }

  emit(type: string, event?: { code?: number; data?: string; reason?: string }) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

describe('agent runtime helpers', () => {
  test('creates initial and reconnect runtime states', () => {
    const first = createNextRuntimeState()
    const second = createNextRuntimeState(first)

    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
    expect(second.previousSessionId).toBe(first.sessionId)
  })

  test('resolves registration path based on runtime state', () => {
    const first = createNextRuntimeState()
    const second = createNextRuntimeState(first)

    expect(resolveRegistrationPath(first)).toBe('services')
    expect(resolveRegistrationPath(second)).toBe('rebind')
  })

  test('builds service binding payload from config and state', () => {
    const config = createDefaultAgentConfig()
    const state = createNextRuntimeState()
    const payload = buildServiceBindingPayload(state, config.services)

    expect(payload.sessionId).toBe(state.sessionId)
    expect(payload.services).toHaveLength(1)
  })

  test('requires a legacy host token before bootstrap claim flow is implemented', () => {
    const config = parseAgentConfig({
      hostId: 'host-bootstrap',
      hostname: 'machine-bootstrap',
      edgeBaseUrl: 'http://127.0.0.1:8787',
      bootstrapToken: 'bootstrap-token',
    })

    expect(() => requireAgentToken(config)).toThrow('bootstrap_claim_required')
  })

  test('claims bootstrap token and returns issued host token', async () => {
    const config = parseAgentConfig({
      hostId: 'host-bootstrap',
      hostname: 'machine-bootstrap',
      edgeBaseUrl: 'http://edge.test',
      bootstrapToken: 'bootstrap-token',
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      expect(request.url).toBe('http://edge.test/api/bootstrap/claim')
      expect(await request.json()).toEqual({
        hostId: 'host-bootstrap',
        hostname: 'machine-bootstrap',
        bootstrapToken: 'bootstrap-token',
      })
      return Response.json({ ok: true, token: 'host-issued-token' })
    }) as typeof fetch

    try {
      await expect(claimBootstrapToken(config)).resolves.toBe('host-issued-token')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('forwards http request to local upstream', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        return Response.json({
          method: request.method,
          path: new URL(request.url).pathname,
        })
      },
    })

    try {
      const message: HttpRequestMessage = {
        type: 'http_request',
        payload: {
          streamId: 'stream-1',
          serviceId: 'svc-1',
          method: 'GET',
          path: '/hello',
          headers: {},
          body: '',
        },
      }

      const response = await forwardHttpRequest(
        [
          {
            serviceId: 'svc-1',
            serviceName: 'echo',
            localUrl: `http://127.0.0.1:${server.port}`,
            protocol: 'http',
            subdomain: 'echo.example.test',
          },
        ],
        message,
      )

      expect(response.payload.status).toBe(200)
      expect(response.payload.streamId).toBe('stream-1')
      expect(response.payload.body).toContain('/hello')
    } finally {
      server.stop(true)
    }
  })

  test('rejects relay path that could escape upstream host', async () => {
    const message: HttpRequestMessage = {
      type: 'http_request',
      payload: {
        streamId: 'stream-2',
        serviceId: 'svc-1',
        method: 'GET',
        path: '//169.254.169.254/latest/meta-data',
        headers: {},
        body: '',
      },
    }

    const response = await forwardHttpRequest(
      [
        {
          serviceId: 'svc-1',
          serviceName: 'echo',
          localUrl: 'http://127.0.0.1:3000',
          protocol: 'http',
          subdomain: 'echo.example.test',
        },
      ],
      message,
    )

    expect(response.payload.status).toBe(400)
    expect(response.payload.body).toBe('invalid_relay_path')
  })

  test('relays websocket open frame and close messages', async () => {
    const relayState = createRelayState()
    const edgeMessages: string[] = []
    const upstreamSocket = new FakeUpstreamSocket()
    const openMessage: WebSocketOpenMessage = {
      type: 'ws_open',
      payload: {
        streamId: 'ws-1',
        serviceId: 'svc-ws',
        path: '/socket',
        headers: {},
      },
    }

    await handleTunnelMessage(
      openMessage,
      [
        {
          serviceId: 'svc-ws',
          serviceName: 'echo-ws',
          localUrl: 'http://127.0.0.1:3001',
          protocol: 'websocket',
          subdomain: 'ws.example.test',
        },
      ],
      relayState,
      { send: (data: string) => edgeMessages.push(data) },
      () => upstreamSocket,
    )

    expect(relayState.websocketStreams.get('ws-1')).toBe(upstreamSocket)
    upstreamSocket.emit('open')

    const frameFromEdge: WebSocketFrameMessage = {
      type: 'ws_frame',
      payload: {
        streamId: 'ws-1',
        data: 'hello',
      },
    }
    await handleTunnelMessage(frameFromEdge, [], relayState, { send: () => {} })
    expect(upstreamSocket.sent).toEqual(['hello'])

    upstreamSocket.emit('message', { data: 'world' })
    expect(edgeMessages).toHaveLength(1)
    expect(JSON.parse(edgeMessages[0]!)).toEqual({
      type: 'ws_frame',
      payload: {
        streamId: 'ws-1',
        data: 'world',
      },
    })

    const closeFromEdge: WebSocketCloseMessage = {
      type: 'ws_close',
      payload: {
        streamId: 'ws-1',
        code: 1000,
        reason: 'done',
      },
    }
    await handleTunnelMessage(closeFromEdge, [], relayState, { send: () => {} })
    expect(upstreamSocket.closed).toEqual([{ code: 1000, reason: 'done' }])
  })

  test('keeps websocket streams isolated on the same host', async () => {
    const relayState = createRelayState()
    const edgeMessages: string[] = []
    const upstreamA = new FakeUpstreamSocket()
    const upstreamB = new FakeUpstreamSocket()
    let socketIndex = 0

    const services = [
      {
        serviceId: 'svc-ws-a',
        serviceName: 'echo-ws-a',
        localUrl: 'http://127.0.0.1:3201',
        protocol: 'websocket' as const,
        subdomain: 'a.example.test',
      },
      {
        serviceId: 'svc-ws-b',
        serviceName: 'echo-ws-b',
        localUrl: 'http://127.0.0.1:3202',
        protocol: 'websocket' as const,
        subdomain: 'b.example.test',
      },
    ]

    await handleTunnelMessage(
      {
        type: 'ws_open',
        payload: {
          streamId: 'stream-a',
          serviceId: 'svc-ws-a',
          path: '/a',
          headers: {},
        },
      },
      services,
      relayState,
      { send: (data: string) => edgeMessages.push(data) },
      () => (socketIndex++ === 0 ? upstreamA : upstreamB),
    )

    await handleTunnelMessage(
      {
        type: 'ws_open',
        payload: {
          streamId: 'stream-b',
          serviceId: 'svc-ws-b',
          path: '/b',
          headers: {},
        },
      },
      services,
      relayState,
      { send: (data: string) => edgeMessages.push(data) },
      () => (socketIndex++ === 0 ? upstreamA : upstreamB),
    )

    upstreamA.emit('open')
    upstreamB.emit('open')

    await handleTunnelMessage(
      { type: 'ws_frame', payload: { streamId: 'stream-a', data: 'alpha' } },
      services,
      relayState,
      { send: () => {} },
    )
    await handleTunnelMessage(
      { type: 'ws_frame', payload: { streamId: 'stream-b', data: 'beta' } },
      services,
      relayState,
      { send: () => {} },
    )

    expect(upstreamA.sent).toEqual(['alpha'])
    expect(upstreamB.sent).toEqual(['beta'])

    upstreamA.emit('message', { data: 'from-a' })
    upstreamB.emit('message', { data: 'from-b' })

    expect(edgeMessages.map((item) => JSON.parse(item))).toEqual([
      { type: 'ws_frame', payload: { streamId: 'stream-a', data: 'from-a' } },
      { type: 'ws_frame', payload: { streamId: 'stream-b', data: 'from-b' } },
    ])
  })

  test('closes websocket when service is missing', async () => {
    const relayState = createRelayState()
    const edgeMessages: string[] = []
    const openMessage: WebSocketOpenMessage = {
      type: 'ws_open',
      payload: {
        streamId: 'ws-missing',
        serviceId: 'svc-missing',
        path: '/socket',
        headers: {},
      },
    }

    await handleTunnelMessage(openMessage, [], relayState, { send: (data: string) => edgeMessages.push(data) })

    expect(edgeMessages).toHaveLength(1)
    expect(JSON.parse(edgeMessages[0]!)).toEqual({
      type: 'ws_close',
      payload: {
        streamId: 'ws-missing',
        code: 1011,
        reason: 'service_not_found',
      },
    })
  })

  test('queues websocket frames until upstream socket opens', async () => {
    const relayState = createRelayState()
    const upstreamSocket = new FakeUpstreamSocket()

    await handleTunnelMessage(
      {
        type: 'ws_open',
        payload: {
          streamId: 'ws-queued',
          serviceId: 'svc-ws',
          path: '/socket',
          headers: {},
        },
      },
      [
        {
          serviceId: 'svc-ws',
          serviceName: 'echo-ws',
          localUrl: 'http://127.0.0.1:3001',
          protocol: 'websocket',
          subdomain: 'ws.example.test',
        },
      ],
      relayState,
      { send: () => {} },
      () => upstreamSocket,
    )

    await handleTunnelMessage(
      {
        type: 'ws_frame',
        payload: {
          streamId: 'ws-queued',
          data: 'hello-before-open',
        },
      },
      [],
      relayState,
      { send: () => {} },
    )

    expect(upstreamSocket.sent).toEqual([])

    upstreamSocket.emit('open')

    expect(upstreamSocket.sent).toEqual(['hello-before-open'])
  })

  test('closes websocket on invalid relay path', async () => {
    const relayState = createRelayState()
    const edgeMessages: string[] = []
    const openMessage: WebSocketOpenMessage = {
      type: 'ws_open',
      payload: {
        streamId: 'ws-invalid',
        serviceId: 'svc-ws',
        path: '//bad-host/socket',
        headers: {},
      },
    }

    await handleTunnelMessage(
      openMessage,
      [
        {
          serviceId: 'svc-ws',
          serviceName: 'echo-ws',
          localUrl: 'http://127.0.0.1:3001',
          protocol: 'websocket',
          subdomain: 'ws.example.test',
        },
      ],
      relayState,
      { send: (data: string) => edgeMessages.push(data) },
      () => new FakeUpstreamSocket(),
    )

    expect(edgeMessages).toHaveLength(1)
    expect(JSON.parse(edgeMessages[0]!)).toEqual({
      type: 'ws_close',
      payload: {
        streamId: 'ws-invalid',
        code: 1008,
        reason: 'invalid_relay_path',
      },
    })
  })

  test('applies config_dispatch and sends reconcile acknowledgements without polluting relay state', async () => {
    const runtime: AgentRuntimeContext = {
      activeServices: [
        {
          serviceId: 'svc-old',
          serviceName: 'old',
          localUrl: 'http://127.0.0.1:3001',
          protocol: 'http',
          subdomain: 'old.example.test',
        },
      ],
      appliedGeneration: null,
    }
    const state = createNextRuntimeState()
    const config = parseAgentConfig({
      hostId: 'host-1',
      hostname: 'host-1',
      token: 'host-token',
      edgeBaseUrl: 'http://edge.test',
      services: runtime.activeServices,
    })
    const edgeMessages: string[] = []

    const originalFetch = globalThis.fetch
    const fetchCalls: Array<{ url: string; body: unknown }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      fetchCalls.push({ url: request.url, body: await request.json() })
      return Response.json({ ok: true, mode: 'rebind' })
    }) as typeof fetch

    try {
      await handleAgentSocketMessage(
        JSON.stringify({
          type: 'config_dispatch',
          payload: {
            hostId: 'host-1',
            generation: 3,
            desired: {
              hostId: 'host-1',
              generation: 3,
              updatedAt: Date.now(),
              services: [
                {
                  serviceId: 'svc-new',
                  serviceName: 'new',
                  localUrl: 'http://127.0.0.1:3101',
                  protocol: 'http',
                  subdomain: 'new.example.test',
                },
              ],
            },
            dispatchedAt: Date.now(),
            idempotencyKey: 'dispatch-1',
          },
        }),
        runtime,
        state,
        config,
        { send: (data: string) => edgeMessages.push(data) },
        createRelayState(),
        'host-token',
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]?.url).toContain('/api/hosts/host-1/services')
    expect(runtime.appliedGeneration).toBe(3)
    expect(runtime.activeServices.map((service) => service.serviceId)).toEqual(['svc-new'])
    expect(edgeMessages.map((item) => JSON.parse(item))).toEqual([
      {
        type: 'reconcile_ack',
        payload: {
          hostId: 'host-1',
          generation: 3,
          status: 'acknowledged',
          acknowledgedAt: expect.any(Number),
        },
      },
      {
        type: 'reconcile_ack',
        payload: {
          hostId: 'host-1',
          generation: 3,
          status: 'applied',
          acknowledgedAt: expect.any(Number),
        },
      },
    ])
  })
})
