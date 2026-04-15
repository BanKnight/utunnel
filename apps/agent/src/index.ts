import { parseAgentConfig } from '@utunnel/config'
import type { AgentConfig } from '@utunnel/config'
import type {
  ControlPlaneMessage,
  HttpRequestMessage,
  HttpResponseMessage,
  ServiceDefinition,
  TunnelMessage,
  WebSocketCloseMessage,
  WebSocketFrameMessage,
  WebSocketOpenMessage,
} from '@utunnel/protocol'
import { controlPlaneMessageSchema, tunnelMessageSchema } from '@utunnel/protocol'
import {
  buildServiceBindingPayload,
  createDefaultAgentConfig,
  createNextRuntimeState,
  resolveRegistrationPath,
} from './runtime'
import type { RuntimeState } from './runtime'

type ConfigDispatchMessage = Extract<ControlPlaneMessage, { type: 'config_dispatch' }>

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

export type AgentRuntimeContext = {
  activeServices: ServiceDefinition[]
  appliedGeneration: number | null
  applyingGeneration: number | null
}

const loadConfig = async () => {
  const configPath = process.env.UTUNNEL_AGENT_CONFIG ?? new URL('../agent.config.json', import.meta.url)
  const file = Bun.file(configPath)

  if (!(await file.exists())) {
    return createDefaultAgentConfig()
  }

  return parseAgentConfig(await file.json())
}

export const claimBootstrapToken = async (config: AgentConfig) => {
  if (!config.bootstrapToken) {
    throw new Error('bootstrap_claim_required')
  }

  const response = await fetch(`${config.edgeBaseUrl}/api/bootstrap/claim`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      hostId: config.hostId,
      hostname: config.hostname,
      bootstrapToken: config.bootstrapToken,
    }),
  })

  if (!response.ok) {
    throw new Error(`bootstrap_claim_failed:${response.status}`)
  }

  const json = (await response.json()) as { ok: true; token: string }
  return json.token
}

export const requireAgentToken = (config: AgentConfig): string => {
  if (config.token) {
    return config.token
  }

  throw new Error('bootstrap_claim_required')
}

const verifyHostToken = async (edgeBaseUrl: string, hostId: string, token: string) => {
  const verifyResponse = await fetch(`${edgeBaseUrl}/api/hosts/${hostId}/token/verify`, {
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

const fetchDesiredConfig = async (edgeBaseUrl: string, hostId: string, token: string) => {
  const response = await fetch(`${edgeBaseUrl}/api/hosts/${hostId}/desired`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Failed to fetch desired config: ${response.status}`)
  }

  const json = (await response.json()) as {
    desired: {
      generation: number
      services: ServiceDefinition[]
    } | null
  }

  return json.desired
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
    const timeout = setTimeout(() => {
      reject(new Error('websocket connection timeout'))
    }, 5_000)
    socket.addEventListener('open', () => {
      clearTimeout(timeout)
      resolve()
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('websocket connection failed'))
    }, { once: true })
    socket.addEventListener('close', (event) => {
      clearTimeout(timeout)
      reject(new Error(`websocket connection closed:${event.code}`))
    }, { once: true })
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

const sendReconcileAck = (
  socket: EdgeSocketLike,
  hostId: string,
  generation: number,
  status: 'acknowledged' | 'applied' | 'error',
  error?: string,
) => {
  socket.send(
    JSON.stringify({
      type: 'reconcile_ack',
      payload: {
        hostId,
        generation,
        status,
        acknowledgedAt: Date.now(),
        ...(error ? { error } : {}),
      },
    }),
  )
}

const applyDesiredConfig = async (
  config: AgentConfig,
  runtimeState: RuntimeState,
  runtime: AgentRuntimeContext,
  socket: EdgeSocketLike,
  dispatch: ConfigDispatchMessage,
  token: string,
) => {
  if (dispatch.payload.hostId !== config.hostId) {
    return
  }

  if (runtime.appliedGeneration === dispatch.payload.generation) {
    sendReconcileAck(socket, config.hostId, dispatch.payload.generation, 'applied')
    return
  }

  if (runtime.applyingGeneration === dispatch.payload.generation) {
    return
  }

  runtime.applyingGeneration = dispatch.payload.generation
  sendReconcileAck(socket, config.hostId, dispatch.payload.generation, 'acknowledged')

  try {
    await registerServices(
      config.edgeBaseUrl,
      config.hostId,
      runtimeState,
      dispatch.payload.desired.services,
      token,
    )
    runtime.activeServices = dispatch.payload.desired.services
    runtime.appliedGeneration = dispatch.payload.generation
    sendReconcileAck(socket, config.hostId, dispatch.payload.generation, 'applied')
  } catch (error) {
    sendReconcileAck(
      socket,
      config.hostId,
      dispatch.payload.generation,
      'error',
      error instanceof Error ? error.message : 'apply_failed',
    )
  } finally {
    if (runtime.applyingGeneration === dispatch.payload.generation) {
      runtime.applyingGeneration = null
    }
  }
}

export const handleAgentSocketMessage = async (
  rawMessage: string,
  runtime: AgentRuntimeContext,
  runtimeState: RuntimeState,
  config: AgentConfig,
  edgeSocket: EdgeSocketLike,
  relayState: RelayState,
  token: string,
  openSocket: CreateUpstreamSocket = createUpstreamSocket,
) => {
  let controlMessage: ControlPlaneMessage | null = null
  try {
    controlMessage = controlPlaneMessageSchema.parse(JSON.parse(rawMessage))
  } catch {}

  if (controlMessage?.type === 'config_dispatch') {
    await applyDesiredConfig(config, runtimeState, runtime, edgeSocket, controlMessage, token)
    return
  }

  let tunnelMessage: TunnelMessage
  try {
    tunnelMessage = tunnelMessageSchema.parse(JSON.parse(rawMessage))
  } catch {
    return
  }

  await handleTunnelMessage(tunnelMessage, runtime.activeServices, relayState, edgeSocket, openSocket)
}

const attachSocketHandlers = (
  socket: WebSocket,
  config: AgentConfig,
  runtimeState: RuntimeState,
  runtime: AgentRuntimeContext,
  token: string,
) => {
  const relayState = createRelayState()

  socket.addEventListener('message', async (event) => {
    if (typeof event.data !== 'string' || event.data === 'pong' || event.data === 'ping') {
      return
    }

    await handleAgentSocketMessage(
      event.data,
      runtime,
      runtimeState,
      config,
      socket,
      relayState,
      token,
    )
  })
}

const runAgentCycle = async (config: AgentConfig, state: RuntimeState) => {
  const token = config.token ?? await claimBootstrapToken(config)
  await verifyHostToken(config.edgeBaseUrl, config.hostId, token)

  const desired = await fetchDesiredConfig(config.edgeBaseUrl, config.hostId, token)
  const runtime: AgentRuntimeContext = {
    activeServices: desired?.services ?? config.services,
    appliedGeneration: desired?.generation ?? null,
    applyingGeneration: null,
  }

  const socket = await connectHostSession(config.edgeBaseUrl, config.hostId, token)
  attachSocketHandlers(socket, config, state, runtime, token)
  const heartbeat = startHeartbeat(socket, config.hostId, state.sessionId)
  const registration = await registerServices(config.edgeBaseUrl, config.hostId, state, runtime.activeServices, token)

  console.log(
    JSON.stringify(
      {
        hostId: config.hostId,
        sessionId: state.sessionId,
        version: state.version,
        previousSessionId: state.previousSessionId ?? null,
        registeredServices: runtime.activeServices.map((service) => service.subdomain),
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
