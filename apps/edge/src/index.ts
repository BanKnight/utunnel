import { DurableObject } from 'cloudflare:workers'
import type { HostSessionRecord, RoutingEntry } from '@utunnel/protocol'
import { app, type EdgeBindings } from './app'
import { markSessionDisconnected } from './lib'

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
  constructor(ctx: DurableObjectState, env: EdgeBindings) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
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
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message)
    ws.send(text)
  }
}

export default {
  fetch: app.fetch,
}
