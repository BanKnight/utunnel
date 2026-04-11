import { DurableObject } from 'cloudflare:workers'
import {
  responseEnvelopeSchema,
  websocketCloseSchema,
  websocketFrameSchema,
  type HostSessionRecord,
  type HttpRequestMessage,
  type HttpResponseMessage,
  type RoutingEntry,
  type WebSocketCloseMessage,
  type WebSocketFrameMessage,
  type WebSocketOpenMessage,
} from '@utunnel/protocol'
import { app, type EdgeBindings } from './app'
import { markSessionDisconnected } from './lib'

const decoder = new TextDecoder()

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

type ConnectionRole =
  | { type: 'host' }
  | { type: 'client'; streamId: string }

export class RoutingDirectory extends DurableObject<EdgeBindings> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/resolve') {
      const hostname = url.searchParams.get('hostname')
      if (!hostname) return Response.json({ error: 'hostname_required' }, { status: 400 })
      const entry = await this.ctx.storage.get<RoutingEntry>(`route:${hostname}`)
      if (!entry) return Response.json({ error: 'not_found' }, { status: 404 })
      return Response.json(entry)
    }

    if (request.method === 'GET' && url.pathname === '/list') {
      const entries = await this.ctx.storage.list<RoutingEntry>({ prefix: 'route:' })
      return Response.json(Array.from(entries.values()))
    }

    if (request.method === 'POST' && url.pathname === '/bind') {
      const entry = (await request.json()) as RoutingEntry
      const key = `route:${entry.hostname}`
      const existing = await this.ctx.storage.get<RoutingEntry>(key)

      if (existing && (existing.hostId !== entry.hostId || existing.serviceId !== entry.serviceId)) {
        return Response.json({ ok: false, reason: 'hostname_conflict' }, { status: 409 })
      }

      if (existing && existing.version > entry.version) {
        return Response.json({ ok: false, reason: 'stale_version' }, { status: 409 })
      }

      await this.ctx.storage.put(key, entry)
      return Response.json(entry)
    }

    if (request.method === 'POST' && url.pathname === '/unbind-stale') {
      const { hostname, deadline } = (await request.json()) as { hostname: string; deadline: number }
      const entry = await this.ctx.storage.get<RoutingEntry>(`route:${hostname}`)
      if (entry && entry.updatedAt <= deadline) {
        await this.ctx.storage.delete(`route:${hostname}`)
        return Response.json({ removed: true })
      }
      return Response.json({ removed: false })
    }

    return Response.json({ error: 'not_found' }, { status: 404 })
  }
}

export class HostSession extends DurableObject<EdgeBindings> {
  private pendingResponses = new Map<string, (message: HttpResponseMessage) => void>()

  constructor(ctx: DurableObjectState, env: EdgeBindings) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private getHostSocket() {
    return this.ctx.getWebSockets('host')[0]
  }

  private getClientSocket(streamId: string) {
    return this.ctx.getWebSockets(streamId)[0]
  }

  private readMessage(message: string | ArrayBuffer) {
    return typeof message === 'string' ? message : decoder.decode(message)
  }

  private getSocketRole(ws: WebSocket) {
    return ws.deserializeAttachment() as ConnectionRole | null
  }

  private async ensureActiveSession(expectedSessionId: string, expectedVersion: number) {
    const session = await this.ctx.storage.get<HostSessionRecord>('session')
    if (
      !session ||
      session.disconnectedAt !== null ||
      session.sessionId !== expectedSessionId ||
      session.version !== expectedVersion
    ) {
      return null
    }
    return session
  }

  private async relayHttpRequest(payload: RelayHttpRequest) {
    const session = await this.ensureActiveSession(payload.expectedSessionId, payload.expectedVersion)
    if (!session) {
      return Response.json({ ok: false, reason: 'stale_session_binding' }, { status: 409 })
    }

    const socket = this.getHostSocket()
    if (!socket) {
      return Response.json({ ok: false, reason: 'host_not_connected' }, { status: 503 })
    }

    const responseMessage = await new Promise<HttpResponseMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(payload.request.payload.streamId)
        reject(new Error('relay_timeout'))
      }, 5_000)

      this.pendingResponses.set(payload.request.payload.streamId, (message) => {
        clearTimeout(timeout)
        resolve(message)
      })

      socket.send(JSON.stringify(payload.request))
    })

    return new Response(responseMessage.payload.body, {
      status: responseMessage.payload.status,
      headers: responseMessage.payload.headers,
    })
  }

  private async relayWebSocket(request: Request, payload: RelayWebSocketRequest) {
    const session = await this.ensureActiveSession(payload.expectedSessionId, payload.expectedVersion)
    if (!session) {
      return Response.json({ ok: false, reason: 'stale_session_binding' }, { status: 409 })
    }

    const hostSocket = this.getHostSocket()
    if (!hostSocket) {
      return Response.json({ ok: false, reason: 'host_not_connected' }, { status: 503 })
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, [payload.request.payload.streamId])
    server.serializeAttachment({ type: 'client', streamId: payload.request.payload.streamId } satisfies ConnectionRole)
    hostSocket.send(JSON.stringify(payload.request))
    return new Response(null, { status: 101, webSocket: client })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.headers.get('Upgrade') === 'websocket' && url.pathname === '/connect') {
      for (const existing of this.ctx.getWebSockets('host')) {
        existing.close(1012, 'replaced_host_socket')
      }

      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      this.ctx.acceptWebSocket(server, ['host'])
      server.serializeAttachment({ type: 'host' } satisfies ConnectionRole)
      return new Response(null, { status: 101, webSocket: client })
    }

    if (request.method === 'POST' && url.pathname === '/register') {
      const payload = (await request.json()) as HostSessionRecord
      const existing = await this.ctx.storage.get<HostSessionRecord>('session')
      if (existing && payload.version < existing.version) {
        return Response.json({ ok: false, reason: 'stale_session_version' }, { status: 409 })
      }
      await this.ctx.storage.put('session', payload)
      return Response.json(payload)
    }

    if (request.method === 'POST' && url.pathname === '/relay-http') {
      return this.relayHttpRequest((await request.json()) as RelayHttpRequest)
    }

    if (request.method === 'POST' && url.pathname === '/relay-ws') {
      return this.relayWebSocket(request, (await request.json()) as RelayWebSocketRequest)
    }

    if (request.method === 'POST' && url.pathname === '/disconnect') {
      const session = await this.ctx.storage.get<HostSessionRecord>('session')
      if (!session) {
        return Response.json({ ok: false, error: 'session_not_found' }, { status: 404 })
      }

      const nextSession = markSessionDisconnected(session)
      await this.ctx.storage.put('session', nextSession)
      return Response.json(nextSession)
    }

    if (request.method === 'POST' && url.pathname === '/clear') {
      await this.ctx.storage.delete('session')
      return Response.json({ ok: true })
    }

    if (request.method === 'GET' && url.pathname === '/session') {
      const session = await this.ctx.storage.get<HostSessionRecord>('session')
      return Response.json(session ?? null)
    }

    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = this.readMessage(message)
    if (text === 'ping' || text === 'pong') {
      return
    }

    const role = this.getSocketRole(ws)
    if (!role) {
      return
    }

    if (role.type === 'host') {
      let httpParsed: HttpResponseMessage | null = null
      try {
        httpParsed = responseEnvelopeSchema.parse(JSON.parse(text))
      } catch {}

      if (httpParsed) {
        const resolve = this.pendingResponses.get(httpParsed.payload.streamId)
        if (!resolve) {
          return
        }

        this.pendingResponses.delete(httpParsed.payload.streamId)
        resolve(httpParsed)
        return
      }

      let wsFrame: WebSocketFrameMessage | null = null
      try {
        wsFrame = websocketFrameSchema.parse(JSON.parse(text))
      } catch {}

      if (wsFrame) {
        this.getClientSocket(wsFrame.payload.streamId)?.send(wsFrame.payload.data)
        return
      }

      let wsClose: WebSocketCloseMessage | null = null
      try {
        wsClose = websocketCloseSchema.parse(JSON.parse(text))
      } catch {}

      if (wsClose) {
        this.getClientSocket(wsClose.payload.streamId)?.close(wsClose.payload.code, wsClose.payload.reason)
      }

      return
    }

    const frameMessage: WebSocketFrameMessage = {
      type: 'ws_frame',
      payload: {
        streamId: role.streamId,
        data: text,
      },
    }
    this.getHostSocket()?.send(JSON.stringify(frameMessage))
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    const role = this.getSocketRole(ws)
    if (!role) {
      return
    }

    if (role.type === 'client') {
      const closeMessage: WebSocketCloseMessage = {
        type: 'ws_close',
        payload: {
          streamId: role.streamId,
          code,
          reason,
        },
      }
      this.getHostSocket()?.send(JSON.stringify(closeMessage))
      return
    }

    for (const client of this.ctx.getWebSockets()) {
      const clientRole = client.deserializeAttachment() as ConnectionRole | null
      if (clientRole?.type === 'client') {
        client.close(1011, 'host_socket_closed')
      }
    }
  }
}

export default {
  fetch: app.fetch,
}
