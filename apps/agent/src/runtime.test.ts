import { describe, expect, test } from 'bun:test'
import type { HttpRequestMessage } from '@utunnel/protocol'
import { buildServiceBindingPayload, createDefaultAgentConfig, createNextRuntimeState, resolveRegistrationPath } from './runtime'
import { forwardHttpRequest } from './index'

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
})
