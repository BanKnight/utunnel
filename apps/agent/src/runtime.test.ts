import { describe, expect, test } from 'bun:test'
import type { HttpRequestMessage, WebSocketCloseMessage, WebSocketFrameMessage, WebSocketOpenMessage } from '@utunnel/protocol'
import { buildServiceBindingPayload, createDefaultAgentConfig, createNextRuntimeState, resolveRegistrationPath } from './runtime'
import { createRelayState, forwardHttpRequest, handleTunnelMessage } from './index'

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
})


