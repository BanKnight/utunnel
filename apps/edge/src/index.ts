import { DurableObject } from 'cloudflare:workers'
import { responseEnvelopeSchema, type HostSessionRecord, type HttpRequestMessage, type HttpResponseMessage, type RoutingEntry } from '@utunnel/protocol'
import { app, type EdgeBindings } from './app'
import { markSessionDisconnected } from './lib'

const decoder = new TextDecoder()

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

  private getConnectedSocket() {
    return this.ctx.getWebSockets()[0]
  }

  private readMessage(message: string | ArrayBuffer) {
    return typeof message === 'string' ? message : decoder.decode(message)
  }

  private async relayHttpRequest(payload: HttpRequestMessage) {
    const socket = this.getConnectedSocket()
    if (!socket) {
      return Response.json({ ok: false, reason: 'host_not_connected' }, { status: 503 })
    }

    const responseMessage = await new Promise<HttpResponseMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(payload.payload.streamId)
        reject(new Error('relay_timeout'))
      }, 5_000)

      this.pendingResponses.set(payload.payload.streamId, (message) => {
        clearTimeout(timeout)
        resolve(message)
      })

      socket.send(JSON.stringify(payload))
    })

    return new Response(responseMessage.payload.body, {
      status: responseMessage.payload.status,
      headers: responseMessage.payload.headers,
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.headers.get('Upgrade') === 'websocket' && url.pathname === '/connect') {
      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      this.ctx.acceptWebSocket(server)
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
      return this.relayHttpRequest((await request.json()) as HttpRequestMessage)
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

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = this.readMessage(message)
    if (text === 'ping' || text === 'pong') {
      return
    }

    let parsed: HttpResponseMessage
    try {
      parsed = responseEnvelopeSchema.parse(JSON.parse(text))
    } catch {
      return
    }

    const resolve = this.pendingResponses.get(parsed.payload.streamId)
    if (!resolve) {
      return
    }

    this.pendingResponses.delete(parsed.payload.streamId)
    resolve(parsed)
  }
}

export default {
  fetch: app.fetch,
}
