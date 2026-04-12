import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { createTempDemoConfigDir, createV1DemoAgentConfigs } from './index'

const ROOT_DOMAIN = 'example.test'
const OPERATOR_TOKEN = 'dev-operator-token'

type ManagedProcess = {
  name: string
  proc: ReturnType<typeof spawn>
}

type DemoServicePorts = {
  host1Http: number
  host2Http: number
  host3Http: number
  host3Ws: number
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

  if (proc.exitCode === null) {
    proc.kill('SIGKILL')
    await Promise.race([
      new Promise<void>((resolve) => {
        proc.once('exit', () => resolve())
        proc.once('close', () => resolve())
      }),
      sleep(1_000),
    ])
  }
}

const fetchJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init)
  return {
    response,
    json: await response.json(),
  }
}

const fetchTunnelHost = async (edgeBaseUrl: string, hostname: string) => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 10_000) {
    try {
      const { response, json } = await fetchJson(`${edgeBaseUrl}/tunnel/demo`, {
        headers: {
          host: '127.0.0.1',
          'x-utunnel-route-host': hostname,
        },
      })
      if (response.ok) {
        return { response, json }
      }
    } catch {}
    await sleep(500)
  }
  throw new Error(`http_smoke_failed_${hostname}`)
}

const waitForWebSocketEcho = async (edgePort: number, hostname: string, message: string) => {
  const startedAt = Date.now()
  const websocketUrl = `ws://127.0.0.1:${edgePort}/tunnel/__utunnel_host/${encodeURIComponent(hostname)}/socket`
  while (Date.now() - startedAt < 10_000) {
    try {
      const echoed = await new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(websocketUrl)
        const timeout = setTimeout(() => {
          ws.close()
          reject(new Error('ws_timeout'))
        }, 3_000)

        ws.addEventListener(
          'open',
          () => {
            ws.send(message)
          },
          { once: true },
        )

        ws.addEventListener(
          'message',
          (event) => {
            clearTimeout(timeout)
            ws.close()
            resolve(String(event.data))
          },
          { once: true },
        )

        ws.addEventListener(
          'error',
          () => {
            clearTimeout(timeout)
            ws.close()
            reject(new Error('websocket_upgrade_failed'))
          },
          { once: true },
        )

        ws.addEventListener(
          'close',
          () => {
            clearTimeout(timeout)
          },
          { once: true },
        )
      })
      return echoed
    } catch {
      await sleep(500)
    }
  }
  throw new Error(`timeout_waiting_for_websocket_echo:${hostname}`)
}

const buildWebShellIfNeeded = () => {
  const distIndexPath = '/data/workspace/utunnel/apps/web/dist/index.html'
  if (existsSync(distIndexPath)) {
    return
  }

  const result = Bun.spawnSync(['bun', 'run', '--cwd', '/data/workspace/utunnel/apps/web', 'build'], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (result.exitCode !== 0) {
    throw new Error('web_shell_build_failed')
  }
}

const main = async () => {
  const runSuffix = String(Date.now())
  const edgePort = await getAvailablePort()
  const servicePorts: DemoServicePorts = {
    host1Http: await getAvailablePort(),
    host2Http: await getAvailablePort(),
    host3Http: await getAvailablePort(),
    host3Ws: await getAvailablePort(),
  }
  const edgeBaseUrl = `http://127.0.0.1:${edgePort}`

  buildWebShellIfNeeded()

  const upstreamHttp1 = Bun.serve({
    port: servicePorts.host1Http,
    fetch() {
      return Response.json({ host: 'host-1', ok: true })
    },
  })
  const upstreamHttp2 = Bun.serve({
    port: servicePorts.host2Http,
    fetch() {
      return Response.json({ host: 'host-2', ok: true })
    },
  })
  const upstreamHttp3 = Bun.serve({
    port: servicePorts.host3Http,
    fetch() {
      return Response.json({ host: 'host-3', ok: true })
    },
  })
  const upstreamWs = Bun.serve({
    port: servicePorts.host3Ws,
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

  const agents: ManagedProcess[] = []
  let edge: ManagedProcess | null = null
  const demoAgentConfigs = createV1DemoAgentConfigs(
    edgeBaseUrl,
    ROOT_DOMAIN,
    OPERATOR_TOKEN,
    servicePorts,
    runSuffix,
  )
  const demoConfigs = await createTempDemoConfigDir(demoAgentConfigs)

  try {
    console.log(
      `[smoke] upstreams ready on ${servicePorts.host1Http}, ${servicePorts.host2Http}, ${servicePorts.host3Http}, ${servicePorts.host3Ws}`,
    )

    edge = startLoggedProcess(
      'edge',
      ['bun', 'x', 'wrangler', 'dev', '--port', String(edgePort)],
      {
        cwd: '/data/workspace/utunnel/apps/edge',
        env: {
          ...process.env,
          ROOT_DOMAIN,
          OPERATOR_TOKEN,
        },
      },
    )

    await waitFor(async () => {
      try {
        const response = await fetch(`${edgeBaseUrl}/`)
        return response.ok
      } catch {
        return false
      }
    }, 30_000, 'edge_ready')

    for (const configPath of demoConfigs.configPaths) {
      agents.push(
        startLoggedProcess('agent', ['bun', 'run', 'src/index.ts'], {
          cwd: '/data/workspace/utunnel/apps/agent',
          env: {
            ...process.env,
            UTUNNEL_AGENT_CONFIG: configPath,
          },
        }),
      )
    }

    await waitFor(async () => {
      try {
        const response = await fetch(`${edgeBaseUrl}/api/routes`, {
          headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
        })
        const json = await response.json()
        return response.ok && Array.isArray(json) && json.length >= 4
      } catch {
        return false
      }
    }, 30_000, 'routes_registered')

    const httpServices = demoAgentConfigs.flatMap((config) =>
      config.services.filter((service) => service.protocol === 'http'),
    )
    for (const service of httpServices) {
      const { response, json } = await fetchTunnelHost(edgeBaseUrl, service.subdomain)
      if (!response.ok || !json.ok) {
        throw new Error(`http_smoke_failed_${service.subdomain}`)
      }
      const expectedHost = service.serviceName.startsWith('host-1-')
        ? 'host-1'
        : service.serviceName.startsWith('host-2-')
          ? 'host-2'
          : 'host-3'
      if (json.host !== expectedHost) {
        throw new Error(`unexpected_response_for_${service.subdomain}`)
      }
    }

    const websocketService = demoAgentConfigs
      .flatMap((config) => config.services)
      .find((service) => service.protocol === 'websocket')
    if (!websocketService) {
      throw new Error('missing_websocket_service')
    }

    const echoed = await waitForWebSocketEcho(edgePort, websocketService.subdomain, 'hello-v1')
    if (echoed !== 'hello-v1') {
      throw new Error('websocket_smoke_failed')
    }

    console.log('smoke:v1 PASS')
  } finally {
    await Promise.allSettled(agents.map(stopProcess))
    if (edge) {
      await stopProcess(edge)
    }
    upstreamWs.stop(true)
    upstreamHttp3.stop(true)
    upstreamHttp2.stop(true)
    upstreamHttp1.stop(true)
    await demoConfigs.cleanup()
  }

  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
