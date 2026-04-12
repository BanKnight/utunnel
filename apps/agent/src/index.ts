import { parseAgentConfig } from '@utunnel/config'
import type { AgentConfig } from '@utunnel/config'
import type {
  HttpRequestMessage,
  HttpResponseMessage,
  ServiceDefinition,
  TunnelMessage,
  WebSocketCloseMessage,
  WebSocketFrameMessage,
  WebSocketOpenMessage,
} from '@utunnel/protocol'
import { tunnelMessageSchema } from '@utunnel/protocol'
import {
  buildServiceBindingPayload,
  createDefaultAgentConfig,
  createNextRuntimeState,
  resolveRegistrationPath,
} from './runtime'
import type { RuntimeState } from './runtime'

type EdgeSocketLike = {
  send(data: string): void
}

type UpstreamSocketEvent = {
  code?: number
  data?: string | ArrayBuffer | Uint8Array
  reason?: string
}

type UpstreamSocketLike = {
  addEventListener(type: string, listener: (event?: UpstreamSocketEvent) => void, options?: AddEventListenerOptions): void
  close(code?: number, reason?: string): void
  send(data: string): void
}

type CreateUpstreamSocket = (url: string, headers: Record<string, string>) => UpstreamSocketLike

export type RelayState = {
  websocketStreams: Map<string, UpstreamSocketLike>
  pendingWebSocketFrames: Map<string, string[]>
  openWebSocketStreams: Set<string>
}

const loadConfig = async () => {
  const configPath = process.env.UTUNNEL_AGENT_CONFIG ?? new URL('../agent.config.json', import.meta.url)
  const file = Bun.file(configPath)

  if (!(await file.exists())) {
    return createDefaultAgentConfig()
  }

  return parseAgentConfig(await file.json())
}

export const requireAgentToken = (config: AgentConfig): string => {
  if (config.token) {
    return config.token
  }

  throw new Error('bootstrap_claim_required')
}

const verifyHostToken = async (config: AgentConfig) => {
  const token = requireAgentToken(config)
  const verifyResponse = await fetch(`${config.edgeBaseUrl}/api/hosts/${config.hostId}/token/verify`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
    },
  })

  const verifyJson = (await verifyResponse.json()) as { ok: boolean }
  if (!verifyJson.ok) {
    throw new Error('Host token verification failed')
  }
}

const registerServices = async (
  edgeBaseUrl: string,
  hostId: string,
  state: RuntimeState,
  services: ServiceDefinition[],
  token: string,
) => {
  const payload = buildServiceBindingPayload(state, services)
  const path = resolveRegistrationPath(state)
  const body = state.previousSessionId
    ? { ...payload, previousSessionId: state.previousSessionId }
    : payload

  const response = await fetch(`${edgeBaseUrl}/api/hosts/${hostId}/${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    throw new Error(`Failed to ${path} services: ${response.status}`)
  }

  return response.json()
}

const connectHostSession = async (edgeBaseUrl: string, hostId: string, token: string) => {
  const wsUrl = edgeBaseUrl.replace(/^http/, 'ws')
  const socket = new WebSocket(
    `${wsUrl}/connect?hostId=${encodeURIComponent(hostId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    } as any,
  )
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new Error('websocket connection failed')), { once: true })
  })
  return socket
}

export const sendHeartbeat = (
  socket: Pick<WebSocket, 'send'>,
  hostId: string,
  sessionId: string,
  now = new Date(),
) => {
  socket.send(
    JSON.stringify({
      type: 'heartbeat',
      payload: {
        hostId,
        sessionId,
        timestamp: now.toISOString(),
      },
    }),
  )
}

const startHeartbeat = (socket: WebSocket, hostId: string, sessionId: string) => {
  return setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      sendHeartbeat(socket, hostId, sessionId)
    }
  }, 10_000)
}

const findServiceById = (services: ServiceDefinition[], serviceId: string) => {
  return services.find((service) => service.serviceId === serviceId)
}

const buildUpstreamUrl = (service: ServiceDefinition, relayPath: string) => {
  if (!relayPath.startsWith('/') || relayPath.startsWith('//') || relayPath.includes('\\')) {
    throw new Error('invalid_relay_path')
  }

  const relayUrl = new URL(`http://relay.internal${relayPath}`)
  const upstreamUrl = new URL(service.localUrl)
  upstreamUrl.pathname = relayUrl.pathname
  upstreamUrl.search = relayUrl.search
  return upstreamUrl
}

const buildUpstreamWebSocketUrl = (service: ServiceDefinition, relayPath: string) => {
  const upstreamUrl = buildUpstreamUrl(service, relayPath)
  if (upstreamUrl.protocol === 'http:') {
    upstreamUrl.protocol = 'ws:'
  } else if (upstreamUrl.protocol === 'https:') {
    upstreamUrl.protocol = 'wss:'
  }
  return upstreamUrl
}

const toText = (value: string | ArrayBuffer | Uint8Array) => {
  if (typeof value === 'string') {
    return value
  }
  return new TextDecoder().decode(value)
}

const createUpstreamSocket: CreateUpstreamSocket = (url, headers) => {
  return new WebSocket(url, { headers } as any) as unknown as UpstreamSocketLike
}

export const createRelayState = (): RelayState => ({
  websocketStreams: new Map(),
  pendingWebSocketFrames: new Map(),
  openWebSocketStreams: new Set(),
})

export const forwardHttpRequest = async (
  services: ServiceDefinition[],
  message: HttpRequestMessage,
): Promise<HttpResponseMessage> => {
  const service = findServiceById(services, message.payload.serviceId)

  if (!service) {
    return {
      type: 'http_response',
      payload: {
        streamId: message.payload.streamId,
        status: 404,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
        },
        body: 'service_not_found',
      },
    }
  }

  let upstreamUrl: URL
  try {
    upstreamUrl = buildUpstreamUrl(service, message.payload.path)
  } catch {
    return {
      type: 'http_response',
      payload: {
        streamId: message.payload.streamId,
        status: 400,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
        },
        body: 'invalid_relay_path',
      },
    }
  }

  const upstreamResponse = await fetch(upstreamUrl, {
    method: message.payload.method,
    headers: message.payload.headers,
    ...(['GET', 'HEAD'].includes(message.payload.method.toUpperCase())
      ? {}
      : { body: message.payload.body }),
  })

  const responseHeaders = Object.fromEntries(upstreamResponse.headers.entries())
  const responseBody = await upstreamResponse.text()

  return {
    type: 'http_response',
    payload: {
      streamId: message.payload.streamId,
      status: upstreamResponse.status,
      headers: responseHeaders,
      body: responseBody,
    },
  }
}

const sendSocketClose = (
  edgeSocket: EdgeSocketLike,
  streamId: string,
  code: number | undefined,
  reason: string | undefined,
) => {
  const closeMessage: WebSocketCloseMessage = {
    type: 'ws_close',
    payload: {
      streamId,
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    },
  }
  edgeSocket.send(JSON.stringify(closeMessage))
}

const handleWebSocketOpen = async (
  services: ServiceDefinition[],
  message: WebSocketOpenMessage,
  relayState: RelayState,
  edgeSocket: EdgeSocketLike,
  openSocket: CreateUpstreamSocket,
) => {
  const service = findServiceById(services, message.payload.serviceId)
  if (!service || service.protocol !== 'websocket') {
    sendSocketClose(edgeSocket, message.payload.streamId, 1011, 'service_not_found')
    return
  }

  let upstreamUrl: URL
  try {
    upstreamUrl = buildUpstreamWebSocketUrl(service, message.payload.path)
  } catch {
    sendSocketClose(edgeSocket, message.payload.streamId, 1008, 'invalid_relay_path')
    return
  }

  const upstreamSocket = openSocket(upstreamUrl.toString(), message.payload.headers)
  relayState.websocketStreams.set(message.payload.streamId, upstreamSocket)
  relayState.pendingWebSocketFrames.set(message.payload.streamId, [])

  upstreamSocket.addEventListener('open', () => {
    relayState.openWebSocketStreams.add(message.payload.streamId)
    const pendingFrames = relayState.pendingWebSocketFrames.get(message.payload.streamId) ?? []
    for (const pendingFrame of pendingFrames) {
      upstreamSocket.send(pendingFrame)
    }
    relayState.pendingWebSocketFrames.delete(message.payload.streamId)
  })

  upstreamSocket.addEventListener('message', (event) => {
    const frameMessage: WebSocketFrameMessage = {
      type: 'ws_frame',
      payload: {
        streamId: message.payload.streamId,
        data: toText(event?.data ?? ''),
      },
    }
    edgeSocket.send(JSON.stringify(frameMessage))
  })

  upstreamSocket.addEventListener('close', (event) => {
    relayState.websocketStreams.delete(message.payload.streamId)
    relayState.pendingWebSocketFrames.delete(message.payload.streamId)
    relayState.openWebSocketStreams.delete(message.payload.streamId)
    sendSocketClose(edgeSocket, message.payload.streamId, event?.code, event?.reason)
  })

  upstreamSocket.addEventListener('error', () => {
    relayState.websocketStreams.delete(message.payload.streamId)
    relayState.pendingWebSocketFrames.delete(message.payload.streamId)
    relayState.openWebSocketStreams.delete(message.payload.streamId)
    sendSocketClose(edgeSocket, message.payload.streamId, 1011, 'upstream_websocket_error')
  })
}

export const handleTunnelMessage = async (
  message: TunnelMessage,
  services: ServiceDefinition[],
  relayState: RelayState,
  edgeSocket: EdgeSocketLike,
  openSocket: CreateUpstreamSocket = createUpstreamSocket,
) => {
  if (message.type === 'http_request') {
    const response = await forwardHttpRequest(services, message)
    edgeSocket.send(JSON.stringify(response))
    return
  }

  if (message.type === 'ws_open') {
    await handleWebSocketOpen(services, message, relayState, edgeSocket, openSocket)
    return
  }

  if (message.type === 'ws_frame') {
    const upstreamSocket = relayState.websocketStreams.get(message.payload.streamId)
    if (!upstreamSocket) {
      return
    }

    if (!relayState.openWebSocketStreams.has(message.payload.streamId)) {
      const pendingFrames = relayState.pendingWebSocketFrames.get(message.payload.streamId) ?? []
      pendingFrames.push(message.payload.data)
      relayState.pendingWebSocketFrames.set(message.payload.streamId, pendingFrames)
      return
    }

    upstreamSocket.send(message.payload.data)
    return
  }

  if (message.type === 'ws_close') {
    relayState.websocketStreams.get(message.payload.streamId)?.close(message.payload.code, message.payload.reason)
    relayState.websocketStreams.delete(message.payload.streamId)
    relayState.pendingWebSocketFrames.delete(message.payload.streamId)
    relayState.openWebSocketStreams.delete(message.payload.streamId)
  }
}

const attachRelayHandlers = (socket: WebSocket, services: ServiceDefinition[]) => {
  const relayState = createRelayState()

  socket.addEventListener('message', async (event) => {
    if (typeof event.data !== 'string' || event.data === 'pong' || event.data === 'ping') {
      return
    }

    let parsed: TunnelMessage
    try {
      parsed = tunnelMessageSchema.parse(JSON.parse(event.data))
    } catch {
      return
    }

    await handleTunnelMessage(parsed, services, relayState, socket)
  })
}

const runAgentCycle = async (config: AgentConfig, state: RuntimeState) => {
  const token = requireAgentToken(config)

  await verifyHostToken(config)
  const socket = await connectHostSession(config.edgeBaseUrl, config.hostId, token)
  attachRelayHandlers(socket, config.services)
  const heartbeat = startHeartbeat(socket, config.hostId, state.sessionId)
  const registration = await registerServices(config.edgeBaseUrl, config.hostId, state, config.services, token)

  console.log(
    JSON.stringify(
      {
        hostId: config.hostId,
        sessionId: state.sessionId,
        version: state.version,
        previousSessionId: state.previousSessionId ?? null,
        registeredServices: config.services.map((service) => service.subdomain),
        registration,
      },
      null,
      2,
    ),
  )

  return { socket, heartbeat }
}

const runAgent = async (config: AgentConfig) => {
  let state = createNextRuntimeState()
  let attempts = 0

  while (attempts < config.maxReconnectAttempts) {
    try {
      const { socket, heartbeat } = await runAgentCycle(config, state)

      await new Promise<void>((resolve) => {
        const finalize = () => {
          clearInterval(heartbeat)
          resolve()
        }

        socket.addEventListener('close', finalize, { once: true })
        socket.addEventListener('error', finalize, { once: true })

        const shutdown = () => {
          clearInterval(heartbeat)
          socket.close()
          process.exit(0)
        }

        process.once('SIGINT', shutdown)
        process.once('SIGTERM', shutdown)
      })

      attempts += 1
      state = createNextRuntimeState(state)
      await Bun.sleep(config.reconnectDelayMs)
    } catch (error) {
      attempts += 1
      if (attempts >= config.maxReconnectAttempts) {
        throw error
      }

      await Bun.sleep(config.reconnectDelayMs)
      state = createNextRuntimeState(state)
    }
  }
}

const main = async () => {
  const config = await loadConfig()
  await runAgent(config)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
