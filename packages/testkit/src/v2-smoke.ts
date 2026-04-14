import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../../../apps/edge/src/trpc'
import { createTempDemoConfigDir, createV1DemoAgentConfigs } from './index'

const ROOT_DOMAIN = 'example.test'
const OPERATOR_TOKEN = 'dev-operator-token'
const UI_PASSWORD = 'dev-password'

type ManagedProcess = {
  name: string
  proc: ReturnType<typeof spawn>
}

const getAvailablePort = async () => {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('failed_to_allocate_port')
  }
  const { port } = address
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return port
}

const startLoggedProcess = (
  name: string,
  cmd: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ManagedProcess => {
  const proc = spawn(cmd[0]!, cmd.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  proc.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`))
  proc.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`))
  return { name, proc }
}

const stopProcess = async ({ name, proc }: ManagedProcess) => {
  if (proc.exitCode !== null) {
    return
  }

  const signal = name === 'edge' ? 'SIGKILL' : 'SIGTERM'
  proc.kill(signal)
  await Promise.race([
    new Promise<void>((resolve) => {
      proc.once('exit', () => resolve())
      proc.once('close', () => resolve())
    }),
    sleep(1_000),
  ])
}

const waitFor = async (check: () => Promise<boolean>, timeoutMs: number, label: string) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return
    }
    await sleep(500)
  }
  throw new Error(`timeout_waiting_for_${label}`)
}

const buildWebShellIfNeeded = () => {
  const distIndexPath = '/data/workspace/utunnel/apps/web/dist/index.html'
  if (existsSync(distIndexPath)) {
    return
  }

  const result = Bun.spawnSync(['bun', '--cwd', '/data/workspace/utunnel/apps/web', 'run', 'build'], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    throw new Error('web_shell_build_failed')
  }
}

const fetchJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init)
  return {
    response,
    json: await response.json(),
  }
}

const main = async () => {
  const edgePort = await getAvailablePort()
  const servicePort = await getAvailablePort()
  const wsPort = await getAvailablePort()
  const edgeBaseUrl = `http://127.0.0.1:${edgePort}`
  const suffix = String(Date.now())

  buildWebShellIfNeeded()

  const upstreamHttp = Bun.serve({
    port: servicePort,
    fetch() {
      return Response.json({ ok: true, host: 'v2-host' })
    },
  })

  const upstreamWs = Bun.serve({
    port: wsPort,
    fetch(request, server) {
      if (server.upgrade(request)) {
        return
      }
      return new Response('upgrade required', { status: 426 })
    },
    websocket: {
      message(ws, msg) {
        ws.send(String(msg))
      },
    },
  })

  const edge = startLoggedProcess('edge', ['bun', 'x', 'wrangler', 'dev', '--port', String(edgePort)], {
    cwd: '/data/workspace/utunnel/apps/edge',
    env: {
      ...process.env,
      ROOT_DOMAIN,
      OPERATOR_TOKEN,
      UI_PASSWORD,
      SESSION_SECRET: 'dev-session-secret',
      SESSION_TTL_MS: '86400000',
    },
  })

  try {
    await waitFor(async () => {
      try {
        const response = await fetch(`${edgeBaseUrl}/`)
        return response.ok
      } catch {
        return false
      }
    }, 30_000, 'edge_ready')

    const login = await fetch(`${edgeBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: UI_PASSWORD }),
    })
    const sessionCookie = login.headers.get('set-cookie')?.split(';')[0]
    if (!sessionCookie) {
      throw new Error('missing_session_cookie')
    }

    const trpc = createTRPCProxyClient<AppRouter>({
      links: [
        httpBatchLink({
          url: `${edgeBaseUrl}/trpc`,
          fetch: async (url, options) => {
            const headers = new Headers(options?.headers)
            headers.set('cookie', sessionCookie)
            const init: RequestInit = {
              method: options?.method ?? 'GET',
              headers,
            }
            if (options && 'body' in options) {
              init.body = options.body ?? null
            }
            return fetch(url, init)
          },
        }),
      ],
    })

    const createdToken = (await trpc.tokens.create.mutate({})) as { token: string }
    const apiToken = createdToken.token
    if (!apiToken) {
      throw new Error('missing_api_token')
    }

    const demoConfigs = createV1DemoAgentConfigs(edgeBaseUrl, ROOT_DOMAIN, OPERATOR_TOKEN, {
      host1Http: servicePort,
      host2Http: servicePort,
      host3Http: servicePort,
      host3Ws: wsPort,
    }, suffix)
    const demoConfig = demoConfigs.find((config) => config.services.some((service) => service.protocol === 'websocket')) ?? demoConfigs[0]
    if (!demoConfig) {
      throw new Error('missing_demo_config')
    }

    const httpTarget = demoConfig.services.find((service) => service.protocol === 'http') ?? demoConfig.services[0]!
    const websocketTarget = demoConfig.services.find((service) => service.protocol === 'websocket') ?? demoConfig.services[0]!

    const bootstrap = await fetchJson(`${edgeBaseUrl}/api/control/hosts/${demoConfig.hostId}/bootstrap`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        hostname: demoConfig.hostname,
        edgeBaseUrl,
      }),
    })
    const bootstrapToken = (bootstrap.json as { bootstrapToken?: string }).bootstrapToken
    if (!bootstrap.response.ok || !bootstrapToken) {
      throw new Error('bootstrap_issue_failed')
    }

    const bootstrapConfig = {
      hostId: demoConfig.hostId,
      hostname: demoConfig.hostname,
      bootstrapToken,
      edgeBaseUrl,
      reconnectDelayMs: demoConfig.reconnectDelayMs,
      maxReconnectAttempts: demoConfig.maxReconnectAttempts,
      services: [],
    }
    const tempConfigs = await createTempDemoConfigDir([bootstrapConfig])
    const agent = startLoggedProcess('agent', ['bun', 'run', 'src/index.ts'], {
      cwd: '/data/workspace/utunnel/apps/agent',
      env: {
        ...process.env,
        UTUNNEL_AGENT_CONFIG: tempConfigs.configPaths[0],
      },
    })

    try {
      await waitFor(async () => {
        try {
          const response = await fetch(`${edgeBaseUrl}/api/control/hosts/${demoConfig.hostId}`, {
            headers: { authorization: `Bearer ${apiToken}` },
          })
          const hostState = (await response.json()) as {
            bootstrap?: { claimedAt: number | null }
            runtime?: { sessionId: string }
          }
          return response.ok && Boolean(hostState?.bootstrap?.claimedAt) && Boolean(hostState?.runtime?.sessionId)
        } catch {
          return false
        }
      }, 90_000, 'agent_claimed_and_connected')

      const imported = await trpc.hosts.importStaticConfig.mutate({
        hostId: demoConfig.hostId,
        services: demoConfig.services,
      })

      await trpc.hosts.upsertDesired.mutate({
        hostId: demoConfig.hostId,
        services: imported.services,
      })

      await waitFor(async () => {
        try {
          const response = await fetch(`${edgeBaseUrl}/api/control/hosts/${demoConfig.hostId}`, {
            headers: { authorization: `Bearer ${apiToken}` },
          })
          const hostState = (await response.json()) as {
            projectedRoutes?: Array<{ hostname: string; generation: number }>
          }
          return response.ok && Boolean(hostState.projectedRoutes?.some((route) => route.hostname === httpTarget.subdomain && route.generation === 1))
        } catch {
          return false
        }
      }, 90_000, 'projected_routes_ready')

      const controlHostResponse = await fetch(`${edgeBaseUrl}/api/control/hosts/${demoConfig.hostId}`, {
        headers: { authorization: `Bearer ${apiToken}` },
      })
      const hostState = (await controlHostResponse.json()) as {
        desired?: { generation: number }
        current?: { generation: number; status: string }
        applied?: { generation: number }
      }
      if (
        !controlHostResponse.ok ||
        hostState?.desired?.generation !== 1 ||
        hostState?.current?.generation !== 1 ||
        hostState?.current?.status !== 'acknowledged' ||
        hostState?.applied?.generation !== 1
      ) {
        throw new Error('control_state_not_visible')
      }

      const httpResponse = await fetch(`${edgeBaseUrl}/tunnel/demo`, {
        headers: {
          host: '127.0.0.1',
          'x-utunnel-route-host': httpTarget.subdomain,
        },
      })
      const httpJson = (await httpResponse.json()) as { ok: boolean }
      if (!httpResponse.ok || !httpJson.ok) {
        throw new Error('http_smoke_failed')
      }

      const websocketUrl = `ws://127.0.0.1:${edgePort}/tunnel/__utunnel_host/${encodeURIComponent(websocketTarget.subdomain)}/socket`
      const echoed = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(websocketUrl)
        const timeout = setTimeout(() => {
          ws.close()
          reject(new Error('ws_timeout'))
        }, 3_000)

        ws.addEventListener('open', () => ws.send('hello-v2'), { once: true })
        ws.addEventListener('message', (event) => {
          clearTimeout(timeout)
          ws.close()
          resolve(String(event.data))
        }, { once: true })
        ws.addEventListener('error', () => {
          clearTimeout(timeout)
          ws.close()
          reject(new Error('websocket_upgrade_failed'))
        }, { once: true })
      })
      if (echoed !== 'hello-v2') {
        throw new Error('websocket_smoke_failed')
      }

      console.log('smoke:v2 PASS')
    } finally {
      await stopProcess(agent)
      await tempConfigs.cleanup()
    }
  } finally {
    await stopProcess(edge)
    upstreamWs.stop(true)
    upstreamHttp.stop(true)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
