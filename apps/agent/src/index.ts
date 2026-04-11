import { parseAgentConfig } from '@utunnel/config'
import type { AgentConfig } from '@utunnel/config'
import type { HttpRequestMessage, HttpResponseMessage, ServiceDefinition, TunnelMessage } from '@utunnel/protocol'
import { requestEnvelopeSchema } from '@utunnel/protocol'
import {
  buildServiceBindingPayload,
  createDefaultAgentConfig,
  createNextRuntimeState,
  resolveRegistrationPath,
} from './runtime'
import type { RuntimeState } from './runtime'

const loadConfig = async () => {
  const configPath = process.env.UTUNNEL_AGENT_CONFIG ?? new URL('../agent.config.json', import.meta.url)
  const file = Bun.file(configPath)

  if (!(await file.exists())) {
    return createDefaultAgentConfig()
  }

  return parseAgentConfig(await file.json())
}

const verifyHostToken = async (config: AgentConfig) => {
  const verifyResponse = await fetch(`${config.edgeBaseUrl}/api/hosts/${config.hostId}/token/verify`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
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

const startHeartbeat = (socket: WebSocket) => {
  return setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send('ping')
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

const attachRelayHandlers = (socket: WebSocket, services: ServiceDefinition[]) => {
  socket.addEventListener('message', async (event) => {
    if (typeof event.data !== 'string' || event.data === 'pong' || event.data === 'ping') {
      return
    }

    let parsed: TunnelMessage
    try {
      parsed = requestEnvelopeSchema.parse(JSON.parse(event.data))
    } catch {
      return
    }

    if (parsed.type !== 'http_request') {
      return
    }

    const response = await forwardHttpRequest(services, parsed)
    socket.send(JSON.stringify(response))
  })
}

const runAgentCycle = async (config: AgentConfig, state: RuntimeState) => {
  await verifyHostToken(config)
  const socket = await connectHostSession(config.edgeBaseUrl, config.hostId, config.token)
  attachRelayHandlers(socket, config.services)
  const heartbeat = startHeartbeat(socket)
  const registration = await registerServices(config.edgeBaseUrl, config.hostId, state, config.services, config.token)

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
