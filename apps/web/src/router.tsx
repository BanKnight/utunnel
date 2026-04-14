import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router'
import { useSetAtom } from 'jotai'
import { useEffect, useMemo, useRef, useState } from 'react'
import { currentUserAtom, sessionReadyAtom, type SessionUser } from './state/session'
import { trpcClient } from './lib/trpc'
import { Button } from './components/ui/button'
import { Input } from './components/ui/input'
import { Card } from './components/ui/card'

type RouterContext = {
  trpc: typeof trpcClient
}

type SessionResponse = {
  ok: true
  user: SessionUser
}

type DashboardSummary = {
  hostCount: number
  onlineHostCount: number
  routeCount: number
  unhealthyHostCount: number
  recentHosts: Array<{
    hostId: string
    healthy: boolean
    disconnectedAt: number | null
    lastHeartbeatAt: number | null
    serviceCount: number
  }>
}

type BootstrapIssueResult = {
  hostId: string
  hostname: string
  bootstrapToken: string
  issuedAt: number
  expiresAt: number
  claimedAt: number | null
  command: string
}

type ControlApiTokenMetadata = {
  tokenId: string
  prefix: string
  label?: string
  createdAt: number
  rotatedAt: number | null
  revokedAt: number | null
  lastUsedAt: number | null
}

type ControlApiTokenSecret = ControlApiTokenMetadata & {
  token: string
}

type ServiceProtocol = 'http' | 'websocket'

type ControlPlaneService = {
  serviceId: string
  serviceName: string
  localUrl: string
  protocol: ServiceProtocol
  subdomain: string
}

type ControlPlaneServiceDraft = ControlPlaneService & {
  rowId: string
}

type ControlPlaneHost = {
  hostId: string
  bootstrap: {
    hostname: string
    issuedAt: number
    expiresAt: number
    claimedAt: number | null
  } | null
  desired: {
    generation: number
    services: ControlPlaneService[]
  } | null
  current: {
    generation: number
    status: 'pending' | 'acknowledged' | 'error'
    services: ControlPlaneService[]
    error?: string
    reportedAt: number
  } | null
  applied: {
    generation: number
    services: ControlPlaneService[]
    appliedAt: number
  } | null
  projectedRoutes: Array<{ hostname: string; serviceId: string; generation: number }>
  runtime: {
    sessionId: string
    version: number
    healthy: boolean
    lastHeartbeatAt: number | null
    disconnectedAt: number | null
    serviceCount: number
  } | null
}

type ControlPlaneServiceReachabilitySummary = {
  hostId: string
  serviceId: string
  serviceName: string
  subdomain: string
  protocol: ServiceProtocol
  reachability: 'reachable' | 'degraded' | 'unreachable' | 'unknown'
  checkedAt: number | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  recentResults: Array<{
    checkedAt: number
    success: boolean
    statusCode?: number
    latencyMs?: number
    failureKind?: 'timeout' | 'dns' | 'edge' | 'upstream' | 'status-code' | 'unknown'
  }>
  hasProjectedRoute: boolean
  desiredGeneration: number | null
  currentGeneration: number | null
  currentStatus: 'pending' | 'acknowledged' | 'error' | null
  appliedGeneration: number | null
  runtime: {
    healthy: boolean
    lastHeartbeatAt: number | null
    disconnectedAt: number | null
  } | null
}

type HostNotice = {
  tone: 'error' | 'success'
  text: string
}

type ServiceFieldError = Partial<Record<'serviceId' | 'serviceName' | 'localUrl' | 'subdomain', string>>

type ServiceValidationResult = {
  fieldErrors: ServiceFieldError[]
  messages: string[]
  hasErrors: boolean
}

const createServiceRowId = () => {
  return `svc-row-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

const toServiceDraft = (service: ControlPlaneService): ControlPlaneServiceDraft => {
  return {
    rowId: createServiceRowId(),
    ...service,
  }
}

const stripServiceDrafts = (services: ControlPlaneServiceDraft[] | null | undefined) => {
  return (services ?? []).map(({ rowId: _rowId, ...service }) => service)
}

const normalizeSubdomain = (subdomain: string) => {
  const trimmed = subdomain.trim().toLowerCase().replace(/\.$/, '')
  return trimmed.split(':')[0] ?? ''
}

const normalizeService = (service: ControlPlaneService): ControlPlaneService => {
  return {
    ...service,
    serviceId: service.serviceId.trim(),
    serviceName: service.serviceName.trim(),
    localUrl: service.localUrl.trim(),
    subdomain: normalizeSubdomain(service.subdomain),
  }
}

const normalizeServices = (services: ControlPlaneService[] | null | undefined) => {
  return (services ?? []).map((service) => normalizeService(service))
}

const cloneServices = (services: ControlPlaneService[] | null | undefined) => {
  return (services ?? []).map((service) => ({ ...service }))
}

const cloneServiceDrafts = (services: ControlPlaneServiceDraft[] | null | undefined) => {
  return (services ?? []).map((service) => ({ ...service }))
}

const buildBaselineServices = (host: ControlPlaneHost) => {
  return normalizeServices(host.desired?.services ?? host.current?.services ?? host.applied?.services)
}

const buildEditableServices = (host: ControlPlaneHost) => {
  return buildBaselineServices(host).map(toServiceDraft)
}

const buildHostEditors = (hosts: ControlPlaneHost[]) => {
  return Object.fromEntries(hosts.map((host) => [host.hostId, buildEditableServices(host)])) as Record<string, ControlPlaneServiceDraft[]>
}

const mergeHostEditors = (
  currentEditors: Record<string, ControlPlaneServiceDraft[]>,
  previousHosts: ControlPlaneHost[],
  nextHosts: ControlPlaneHost[],
  syncHostIds: string[] = [],
) => {
  const syncHostIdSet = new Set(syncHostIds)
  const previousHostsById = new Map(previousHosts.map((host) => [host.hostId, host]))

  return Object.fromEntries(
    nextHosts.map((host) => {
      const nextBaseline = buildBaselineServices(host)
      if (syncHostIdSet.has(host.hostId)) {
        return [host.hostId, nextBaseline.map(toServiceDraft)]
      }

      const currentEditor = currentEditors[host.hostId]
      if (!currentEditor) {
        return [host.hostId, nextBaseline.map(toServiceDraft)]
      }

      const previousHost = previousHostsById.get(host.hostId)
      if (!previousHost) {
        return [host.hostId, cloneServiceDrafts(currentEditor)]
      }

      const previousBaseline = buildBaselineServices(previousHost)
      if (areServicesEqual(currentEditor, previousBaseline)) {
        return [host.hostId, nextBaseline.map(toServiceDraft)]
      }

      return [host.hostId, cloneServiceDrafts(currentEditor)]
    }),
  ) as Record<string, ControlPlaneServiceDraft[]>
}

const areServicesEqual = (
  left: ControlPlaneServiceDraft[] | null | undefined,
  right: ControlPlaneService[] | null | undefined,
) => {
  return JSON.stringify(normalizeServices(stripServiceDrafts(left))) === JSON.stringify(normalizeServices(right))
}

const isValidSubdomain = (value: string) => {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(value)
}

const isValidLocalUrl = (value: string, protocol: ServiceProtocol) => {
  try {
    const parsed = new URL(value)
    if (protocol === 'http') {
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    }
    return parsed.protocol === 'ws:' || parsed.protocol === 'wss:'
  } catch {
    return false
  }
}

const validateServices = (services: ControlPlaneService[]): ServiceValidationResult => {
  const normalizedServices = normalizeServices(services)
  const fieldErrors = normalizedServices.map<ServiceFieldError>(() => ({}))
  const serviceIdRows = new Map<string, number[]>()
  const subdomainRows = new Map<string, number[]>()

  normalizedServices.forEach((service, index) => {
    const serviceId = service.serviceId
    const serviceName = service.serviceName
    const localUrl = service.localUrl
    const subdomain = service.subdomain

    if (!serviceId) {
      fieldErrors[index]!.serviceId = '请输入 service id'
    } else {
      serviceIdRows.set(serviceId, [...(serviceIdRows.get(serviceId) ?? []), index])
    }

    if (!serviceName) {
      fieldErrors[index]!.serviceName = '请输入 service name'
    }

    if (!localUrl) {
      fieldErrors[index]!.localUrl = '请输入 local url'
    } else if (!isValidLocalUrl(localUrl, service.protocol)) {
      fieldErrors[index]!.localUrl = service.protocol === 'http' ? 'HTTP 服务需使用 http(s) URL' : 'WebSocket 服务需使用 ws(s) URL'
    }

    if (!subdomain) {
      fieldErrors[index]!.subdomain = '请输入 subdomain'
    } else if (!isValidSubdomain(subdomain)) {
      fieldErrors[index]!.subdomain = 'subdomain 格式不合法'
    } else {
      subdomainRows.set(subdomain, [...(subdomainRows.get(subdomain) ?? []), index])
    }
  })

  for (const rows of serviceIdRows.values()) {
    if (rows.length > 1) {
      rows.forEach((row) => {
        fieldErrors[row]!.serviceId = 'service id 不能重复'
      })
    }
  }

  for (const rows of subdomainRows.values()) {
    if (rows.length > 1) {
      rows.forEach((row) => {
        fieldErrors[row]!.subdomain = 'subdomain 不能重复'
      })
    }
  }

  const messages = fieldErrors.flatMap((errors, index) => {
    const labels = Object.values(errors)
    return labels.length > 0 ? [`第 ${index + 1} 行有 ${labels.length} 个字段需要修正。`] : []
  })

  return {
    fieldErrors,
    messages,
    hasErrors: messages.length > 0,
  }
}

const createDraftService = (hostId: string): ControlPlaneServiceDraft => {
  const suffix = Date.now()
  return {
    rowId: createServiceRowId(),
    serviceId: `${hostId}-svc-${suffix}`,
    serviceName: '',
    localUrl: 'http://127.0.0.1:3000',
    protocol: 'http',
    subdomain: '',
  }
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginPage,
})

const authedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_authed',
  beforeLoad: async ({ context }) => {
    try {
      const me = (await context.trpc.auth.me.query()) as SessionResponse
      return { user: me.user }
    } catch {
      throw redirect({ to: '/login' })
    }
  },
  component: AuthedLayout,
})

const dashboardRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/',
  loader: async ({ context }) => {
    return context.trpc.dashboard.summary.query() as Promise<DashboardSummary>
  },
  component: DashboardPage,
})

const hostsRoute = createRoute({
  getParentRoute: () => authedRoute,
  path: '/hosts',
  loader: async ({ context }) => {
    return context.trpc.hosts.list.query() as Promise<ControlPlaneHost[]>
  },
  component: HostsPage,
})

const routeTree = rootRoute.addChildren([loginRoute, authedRoute.addChildren([dashboardRoute, hostsRoute])])

export const router = createRouter({
  routeTree,
  context: {
    trpc: trpcClient,
  },
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

function LoginPage() {
  const navigate = loginRoute.useNavigate()
  const setSessionReady = useSetAtom(sessionReadyAtom)
  const setCurrentUser = useSetAtom(currentUserAtom)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <Card className="w-full max-w-md space-y-5">
        <div className="space-y-2">
          <p className="text-sm text-sky-400">utunnel control shell</p>
          <h1 className="text-2xl font-semibold text-slate-50">登录</h1>
          <p className="text-sm text-slate-400">Phase 1 先只做个人控制台登录。</p>
        </div>
        <form
          className="space-y-4"
          onSubmit={async (event) => {
            event.preventDefault()
            setSubmitting(true)
            setError(null)
            try {
              const result = (await trpcClient.auth.login.mutate({ password })) as SessionResponse
              setCurrentUser(result.user)
              setSessionReady(true)
              await navigate({ to: '/' })
            } catch {
              setError('登录失败，请检查密码。')
            } finally {
              setSubmitting(false)
            }
          }}
        >
          <Input
            type="password"
            placeholder="输入控制台密码"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error ? <p className="text-sm text-rose-400">{error}</p> : null}
          <Button type="submit" className="w-full" disabled={submitting || password.length === 0}>
            {submitting ? '登录中...' : '登录'}
          </Button>
        </form>
      </Card>
    </main>
  )
}

function AuthedLayout() {
  const navigate = authedRoute.useNavigate()
  const context = authedRoute.useRouteContext() as { user: SessionUser }
  const setSessionReady = useSetAtom(sessionReadyAtom)
  const setCurrentUser = useSetAtom(currentUserAtom)

  useEffect(() => {
    setCurrentUser(context.user)
    setSessionReady(true)
  }, [context.user, setCurrentUser, setSessionReady])

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-950/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-sm text-sky-400">utunnel</p>
            <h1 className="text-lg font-semibold">Control Shell</h1>
          </div>
          <div className="flex items-center gap-3 text-sm text-slate-400">
            <span>{context.user.id}</span>
            <Button
              className="bg-slate-800 text-slate-100 hover:bg-slate-700"
              onClick={async () => {
                await trpcClient.auth.logout.mutate()
                setCurrentUser(null)
                setSessionReady(true)
                await navigate({ to: '/login' })
              }}
            >
              退出
            </Button>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl gap-6 px-6 py-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <nav className="space-y-2">
          <RouteLink to="/">总览</RouteLink>
          <RouteLink to="/hosts">Hosts</RouteLink>
        </nav>
        <main>
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function RouteLink({ to, children }: { to: '/' | '/hosts'; children: string }) {
  const navigate = authedRoute.useNavigate()
  return (
    <button
      className="flex w-full items-center rounded-md border border-slate-800 bg-slate-900 px-3 py-2 text-left text-sm text-slate-200 hover:border-sky-500 hover:text-sky-300"
      onClick={() => navigate({ to })}
      type="button"
    >
      {children}
    </button>
  )
}

function DashboardPage() {
  const loaderData = dashboardRoute.useLoaderData() as DashboardSummary
  const cards = useMemo(
    () => [
      ['Hosts', loaderData.hostCount],
      ['Online hosts', loaderData.onlineHostCount],
      ['Routes', loaderData.routeCount],
      ['Unhealthy hosts', loaderData.unhealthyHostCount],
    ],
    [loaderData],
  )

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-50">总览</h2>
        <p className="mt-1 text-sm text-slate-400">Phase 1 只展示最小摘要，不进入 desired/current/applied 可视化。</p>
      </div>
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {cards.map(([label, value]) => (
          <Card key={label}>
            <p className="text-sm text-slate-400">{label}</p>
            <p className="mt-3 text-3xl font-semibold text-slate-50">{value}</p>
          </Card>
        ))}
      </section>
      <Card className="space-y-4">
        <div>
          <h3 className="text-lg font-medium text-slate-50">最近 Host 状态</h3>
          <p className="text-sm text-slate-400">按最近心跳/断开时间排序。</p>
        </div>
        <div className="space-y-3">
          {loaderData.recentHosts.map((host) => (
            <div key={host.hostId} className="flex items-center justify-between rounded-md border border-slate-800 px-4 py-3">
              <div>
                <p className="font-medium text-slate-100">{host.hostId}</p>
                <p className="text-sm text-slate-400">services: {host.serviceCount}</p>
              </div>
              <div className={host.healthy ? 'text-emerald-400' : 'text-rose-400'}>
                {host.healthy ? 'healthy' : 'unhealthy'}
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

function HostsPage() {
  const loaderData = hostsRoute.useLoaderData() as ControlPlaneHost[]
  const [hosts, setHosts] = useState<ControlPlaneHost[]>(loaderData)
  const hostsRef = useRef(loaderData)
  const [hostEditors, setHostEditors] = useState<Record<string, ControlPlaneServiceDraft[]>>(() => buildHostEditors(loaderData))
  const [hostNotices, setHostNotices] = useState<Record<string, HostNotice | null>>({})
  const [savingHostIds, setSavingHostIds] = useState<Record<string, boolean>>({})
  const [tokens, setTokens] = useState<ControlApiTokenMetadata[]>([])
  const [hostId, setHostId] = useState('')
  const [hostname, setHostname] = useState('')
  const [importDrafts, setImportDrafts] = useState<Record<string, string>>({})
  const [command, setCommand] = useState<string | null>(null)
  const [tokenSecret, setTokenSecret] = useState<string | null>(null)
  const [onboardingError, setOnboardingError] = useState<string | null>(null)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)
  const [creatingToken, setCreatingToken] = useState(false)
  const [reachabilitySummaries, setReachabilitySummaries] = useState<ControlPlaneServiceReachabilitySummary[]>([])
  const [importingHostIds, setImportingHostIds] = useState<Record<string, boolean>>({})
  const [importOpenHostIds, setImportOpenHostIds] = useState<Record<string, boolean>>({})

  const reloadHosts = async (syncHostIds: string[] = []) => {
    const previousHosts = hostsRef.current
    const nextHosts = (await trpcClient.hosts.list.query()) as ControlPlaneHost[]
    setHostEditors((currentEditors) => mergeHostEditors(currentEditors, previousHosts, nextHosts, syncHostIds))
    hostsRef.current = nextHosts
    setHosts(nextHosts)
  }

  useEffect(() => {
    const previousHosts = hostsRef.current
    setHostEditors((currentEditors) => mergeHostEditors(currentEditors, previousHosts, loaderData))
    hostsRef.current = loaderData
    setHosts(loaderData)
  }, [loaderData])

  useEffect(() => {
    void trpcClient.tokens.list.query().then((result) => setTokens(result as ControlApiTokenMetadata[])).catch(() => {
      setTokens([])
    })

    void trpcClient.services.reachability.query().then((result) => {
      setReachabilitySummaries(result as ControlPlaneServiceReachabilitySummary[])
    }).catch(() => {
      setReachabilitySummaries([])
    })
  }, [])


  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-50">Hosts</h2>
        <p className="text-sm text-slate-400">Phase 4 增加最小 bootstrap onboarding command 生成。</p>
      </div>
      <Card className="space-y-4">
        <div>
          <h3 className="text-lg font-medium text-slate-50">新增 Host</h3>
          <p className="text-sm text-slate-400">先签发一次性 onboarding command，agent claim 后再进入常规 host session。</p>
        </div>
        <form
          className="grid gap-3 md:grid-cols-[1fr_1fr_auto]"
          onSubmit={async (event) => {
            event.preventDefault()
            setIssuing(true)
            setOnboardingError(null)
            try {
              const result = (await trpcClient.hosts.issueBootstrap.mutate({
                hostId,
                hostname,
                edgeBaseUrl: window.location.origin,
              })) as BootstrapIssueResult
              setCommand(result.command)
            } catch {
              setOnboardingError('生成 onboarding command 失败。')
            } finally {
              setIssuing(false)
            }
          }}
        >
          <Input placeholder="host id" value={hostId} onChange={(event) => setHostId(event.target.value)} />
          <Input placeholder="hostname" value={hostname} onChange={(event) => setHostname(event.target.value)} />
          <Button type="submit" disabled={issuing || hostId.length === 0 || hostname.length === 0}>
            {issuing ? '生成中...' : '生成命令'}
          </Button>
        </form>
        {onboardingError ? <p className="text-sm text-rose-400">{onboardingError}</p> : null}
        {command ? (
          <div className="rounded-md border border-slate-800 bg-slate-950 p-4">
            <p className="mb-2 text-sm text-slate-400">Onboarding command</p>
            <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-slate-200">{command}</pre>
          </div>
        ) : null}
      </Card>
      <Card className="space-y-4">
        <div>
          <h3 className="text-lg font-medium text-slate-50">API Tokens</h3>
          <p className="text-sm text-slate-400">Phase 5 增加最小 programmatic control-plane token 管理。</p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            disabled={creatingToken}
            onClick={async () => {
              setCreatingToken(true)
              setTokenError(null)
              try {
                const created = (await trpcClient.tokens.create.mutate({})) as ControlApiTokenSecret
                setTokenSecret(created.token)
                setTokens(await trpcClient.tokens.list.query() as ControlApiTokenMetadata[])
              } catch {
                setTokenError('创建 API token 失败。')
              } finally {
                setCreatingToken(false)
              }
            }}
          >
            {creatingToken ? '创建中...' : '创建 token'}
          </Button>
        </div>
        {tokenError ? <p className="text-sm text-rose-400">{tokenError}</p> : null}
        {tokenSecret ? (
          <div className="rounded-md border border-slate-800 bg-slate-950 p-4">
            <p className="mb-2 text-sm text-slate-400">One-time token secret</p>
            <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-slate-200">{tokenSecret}</pre>
          </div>
        ) : null}
        <div className="space-y-3">
          {tokens.length > 0 ? tokens.map((token) => (
            <div key={token.tokenId} className="flex items-center justify-between rounded-md border border-slate-800 px-4 py-3">
              <div>
                <p className="font-medium text-slate-100">{token.label ?? token.prefix}</p>
                <p className="text-sm text-slate-400">{token.prefix} · {token.revokedAt ? 'revoked' : 'active'}</p>
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  className="bg-slate-800 text-slate-100 hover:bg-slate-700"
                  onClick={async () => {
                    setTokenError(null)
                    try {
                      const rotated = (await trpcClient.tokens.rotate.mutate({ tokenId: token.tokenId })) as ControlApiTokenSecret
                      setTokenSecret(rotated.token)
                      setTokens(await trpcClient.tokens.list.query() as ControlApiTokenMetadata[])
                    } catch {
                      setTokenError('轮换 token 失败。')
                    }
                  }}
                >
                  rotate
                </Button>
                <Button
                  type="button"
                  className="bg-slate-800 text-slate-100 hover:bg-slate-700"
                  onClick={async () => {
                    setTokenError(null)
                    try {
                      await trpcClient.tokens.revoke.mutate({ tokenId: token.tokenId })
                      setTokens(await trpcClient.tokens.list.query() as ControlApiTokenMetadata[])
                    } catch {
                      setTokenError('撤销 token 失败。')
                    }
                  }}
                >
                  revoke
                </Button>
              </div>
            </div>
          )) : <p className="text-sm text-slate-500">暂无 API tokens</p>}
        </div>
      </Card>
      <div className="space-y-4">
        {hosts.map((host) => {
          const editableServices = hostEditors[host.hostId] ?? []
          const baselineServices = buildBaselineServices(host)
          const savedServices = baselineServices.map(toServiceDraft)
          const validation = validateServices(stripServiceDrafts(editableServices))
          const rowErrors = validation.fieldErrors
          const isDirty = !areServicesEqual(editableServices, baselineServices)
          const isSavingHost = Boolean(savingHostIds[host.hostId])
          const isImportingHost = Boolean(importingHostIds[host.hostId])
          const isImportOpen = Boolean(importOpenHostIds[host.hostId])
          const hostNotice = hostNotices[host.hostId] ?? null
          const importDraft = importDrafts[host.hostId] ?? ''
          const serviceSummaries = reachabilitySummaries.filter((summary) => summary.hostId === host.hostId)
          return (
          <Card key={host.hostId} className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h3 className="text-lg font-medium text-slate-50">{host.hostId}</h3>
                <p className="text-sm text-slate-400">
                  runtime: {host.runtime ? `${host.runtime.healthy ? 'healthy' : 'unhealthy'} / v${host.runtime.version}` : 'offline'}
                </p>
                <p className="text-sm text-slate-500">
                  bootstrap: {host.bootstrap ? `${host.bootstrap.hostname} · ${host.bootstrap.claimedAt ? 'claimed' : 'pending'}` : '—'}
                </p>
              </div>
              <div className="text-right text-sm text-slate-400">
                <p>desired g{host.desired?.generation ?? '—'}</p>
                <p>current g{host.current?.generation ?? '—'} · {host.current?.status ?? '—'}</p>
                <p>reported: {host.current?.reportedAt ? new Date(host.current.reportedAt).toLocaleTimeString() : '—'}</p>
                {host.current?.error ? <p className="text-rose-400">error: {host.current.error}</p> : null}
                <p>applied g{host.applied?.generation ?? '—'}</p>
                <p>applied: {host.applied?.appliedAt ? new Date(host.applied.appliedAt).toLocaleTimeString() : '—'}</p>
              </div>
            </div>
            <div className="rounded-md border border-slate-800 p-4 space-y-3">
              <div>
                <p className="text-sm font-medium text-slate-200">Service reachability</p>
                <p className="text-sm text-slate-500">从 utunnel 公网入口视角展示最近一次 probe 与最近几次结果。</p>
              </div>
              {serviceSummaries.length > 0 ? (
                <div className="space-y-3">
                  {serviceSummaries.map((summary) => (
                    <div key={`${summary.hostId}-${summary.serviceId}`} className="rounded-md border border-slate-800 px-4 py-3">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="font-medium text-slate-100">{summary.serviceName} · {summary.subdomain}</p>
                          <p className="text-sm text-slate-400">{summary.serviceId} · {summary.protocol} · {summary.hasProjectedRoute ? 'projected' : 'not projected'}</p>
                        </div>
                        <div className="text-right">
                          <p className={summary.reachability === 'reachable' ? 'text-sm text-emerald-400' : summary.reachability === 'degraded' ? 'text-sm text-amber-400' : summary.reachability === 'unreachable' ? 'text-sm text-rose-400' : 'text-sm text-slate-400'}>
                            {summary.reachability}
                          </p>
                          <p className="text-xs text-slate-500">checked: {summary.checkedAt ? new Date(summary.checkedAt).toLocaleTimeString() : '—'}</p>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs">
                        {summary.recentResults.length > 0 ? summary.recentResults.map((result) => (
                          <span key={`${summary.serviceId}-${result.checkedAt}`} className={result.success ? 'rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-emerald-300' : 'rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-rose-300'}>
                            {result.success ? 'ok' : result.failureKind ?? 'fail'} · {new Date(result.checkedAt).toLocaleTimeString()}
                          </span>
                        )) : <span className="text-slate-500">尚无 probe 结果</span>}
                      </div>
                      <div className="mt-3 grid gap-2 text-xs text-slate-500 md:grid-cols-3">
                        <p>desired g{summary.desiredGeneration ?? '—'}</p>
                        <p>current g{summary.currentGeneration ?? '—'} · {summary.currentStatus ?? '—'}</p>
                        <p>applied g{summary.appliedGeneration ?? '—'}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-500">当前 host 还没有 service reachability 摘要。</p>
              )}
            </div>
            <div className="rounded-md border border-slate-800 p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">Desired services editor</p>
                  <p className="text-sm text-slate-500">直接编辑并保存 desired.services。</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    className="bg-slate-800 text-slate-100 hover:bg-slate-700"
                    onClick={() => {
                      setHostNotices((current) => ({ ...current, [host.hostId]: null }))
                      setHostEditors((current) => ({
                        ...current,
                        [host.hostId]: [...(current[host.hostId] ?? []), createDraftService(host.hostId)],
                      }))
                    }}
                  >
                    新增 service
                  </Button>
                  <Button
                    type="button"
                    className="bg-slate-800 text-slate-100 hover:bg-slate-700"
                    onClick={() => {
                      setHostNotices((current) => ({ ...current, [host.hostId]: null }))
                      setImportOpenHostIds((current) => ({
                        ...current,
                        [host.hostId]: !current[host.hostId],
                      }))
                    }}
                  >
                    {isImportOpen ? '收起导入' : '导入 static config'}
                  </Button>
                  <Button
                    type="button"
                    className="bg-slate-800 text-slate-100 hover:bg-slate-700"
                    disabled={!isDirty || isSavingHost}
                    onClick={() => {
                      setHostNotices((current) => ({ ...current, [host.hostId]: null }))
                      setHostEditors((current) => ({
                        ...current,
                        [host.hostId]: cloneServiceDrafts(savedServices),
                      }))
                    }}
                  >
                    重置
                  </Button>
                  <Button
                    type="button"
                    disabled={isSavingHost || !isDirty || validation.hasErrors}
                    onClick={async () => {
                      if (validation.hasErrors) {
                        setHostNotices((current) => ({
                          ...current,
                          [host.hostId]: { tone: 'error', text: '请先修正表单中的字段错误。' },
                        }))
                        return
                      }

                      const normalizedServices = normalizeServices(stripServiceDrafts(editableServices))
                      setSavingHostIds((current) => ({ ...current, [host.hostId]: true }))
                      setHostNotices((current) => ({ ...current, [host.hostId]: null }))
                      try {
                        await trpcClient.hosts.upsertDesired.mutate({
                          hostId: host.hostId,
                          services: normalizedServices,
                        })
                        await reloadHosts([host.hostId])
                        setHostNotices((current) => ({
                          ...current,
                          [host.hostId]: { tone: 'success', text: 'desired services 已保存。' },
                        }))
                      } catch {
                        setHostNotices((current) => ({
                          ...current,
                          [host.hostId]: { tone: 'error', text: '保存 desired services 失败。' },
                        }))
                      } finally {
                        setSavingHostIds((current) => ({ ...current, [host.hostId]: false }))
                      }
                    }}
                  >
                    {isSavingHost ? '保存中...' : '保存 desired'}
                  </Button>
                </div>
              </div>
              {hostNotice ? (
                <p className={hostNotice.tone === 'error' ? 'text-sm text-rose-400' : 'text-sm text-emerald-400'}>{hostNotice.text}</p>
              ) : null}
              <p className={isDirty ? 'text-sm text-amber-400' : 'text-sm text-slate-500'}>
                {isDirty ? '有未保存更改。' : '当前草稿已与已知配置同步。'}
              </p>
              <div className="space-y-3">
                {validation.messages.length > 0 ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
                    {validation.messages.join(' ')}
                  </div>
                ) : null}
                {editableServices.length > 0 ? editableServices.map((service, index) => {
                  const rowError = rowErrors[index] ?? {}
                  return (
                  <div key={service.rowId} className="space-y-2 rounded-md border border-slate-800 p-3">
                    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[1fr_1fr_1.2fr_140px_1fr_auto]">
                      <div className="space-y-1">
                        <Input
                          placeholder="service id"
                          value={service.serviceId}
                          onChange={(event) => {
                            const value = event.target.value
                            setHostEditors((current) => ({
                              ...current,
                              [host.hostId]: (current[host.hostId] ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, serviceId: value } : item),
                            }))
                          }}
                        />
                        {rowError.serviceId ? <p className="text-xs text-rose-400">{rowError.serviceId}</p> : null}
                      </div>
                      <div className="space-y-1">
                        <Input
                          placeholder="service name"
                          value={service.serviceName}
                          onChange={(event) => {
                            const value = event.target.value
                            setHostEditors((current) => ({
                              ...current,
                              [host.hostId]: (current[host.hostId] ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, serviceName: value } : item),
                            }))
                          }}
                        />
                        {rowError.serviceName ? <p className="text-xs text-rose-400">{rowError.serviceName}</p> : null}
                      </div>
                      <div className="space-y-1">
                        <Input
                          placeholder="local url"
                          value={service.localUrl}
                          onChange={(event) => {
                            const value = event.target.value
                            setHostEditors((current) => ({
                              ...current,
                              [host.hostId]: (current[host.hostId] ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, localUrl: value } : item),
                            }))
                          }}
                        />
                        {rowError.localUrl ? <p className="text-xs text-rose-400">{rowError.localUrl}</p> : null}
                      </div>
                      <div className="space-y-1">
                        <select
                          className="flex h-10 w-full rounded-md border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500"
                          value={service.protocol}
                          onChange={(event) => {
                            const value = event.target.value as ServiceProtocol
                            setHostEditors((current) => ({
                              ...current,
                              [host.hostId]: (current[host.hostId] ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, protocol: value } : item),
                            }))
                          }}
                        >
                          <option value="http">http</option>
                          <option value="websocket">websocket</option>
                        </select>
                      </div>
                      <div className="space-y-1">
                        <Input
                          placeholder="subdomain"
                          value={service.subdomain}
                          onChange={(event) => {
                            const value = event.target.value
                            setHostEditors((current) => ({
                              ...current,
                              [host.hostId]: (current[host.hostId] ?? []).map((item, itemIndex) => itemIndex === index ? { ...item, subdomain: value } : item),
                            }))
                          }}
                        />
                        {rowError.subdomain ? <p className="text-xs text-rose-400">{rowError.subdomain}</p> : null}
                      </div>
                      <Button
                        type="button"
                        className="bg-slate-800 text-slate-100 hover:bg-slate-700"
                        onClick={() => {
                          setHostEditors((current) => ({
                            ...current,
                            [host.hostId]: (current[host.hostId] ?? []).filter((_, itemIndex) => itemIndex !== index),
                          }))
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                )}) : <p className="text-sm text-slate-500">暂无 desired services，可直接新增。</p>}
              </div>
              {isImportOpen ? (
                <div className="rounded-md border border-dashed border-slate-800 p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-slate-200">导入 static config</p>
                      <p className="text-sm text-slate-500">把旧静态配置导入到当前 host 的编辑草稿，确认后再保存 desired。</p>
                    </div>
                    <Button
                      type="button"
                      className="bg-slate-800 text-slate-100 hover:bg-slate-700"
                      onClick={() => {
                        setImportOpenHostIds((current) => ({ ...current, [host.hostId]: false }))
                      }}
                    >
                      取消
                    </Button>
                  </div>
                  <textarea
                    className="min-h-32 w-full rounded-md border border-slate-800 bg-slate-950 p-3 text-sm text-slate-100"
                    placeholder='{"services":[...]}'
                    value={importDraft}
                    onChange={(event) => {
                      const value = event.target.value
                      setImportDrafts((current) => ({ ...current, [host.hostId]: value }))
                    }}
                  />
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      disabled={isImportingHost || importDraft.length === 0}
                      onClick={async () => {
                        setImportingHostIds((current) => ({ ...current, [host.hostId]: true }))
                        setHostNotices((current) => ({ ...current, [host.hostId]: null }))
                        try {
                          const parsed = JSON.parse(importDraft) as { services?: ControlPlaneService[] } | ControlPlaneService[]
                          const importedServices = Array.isArray(parsed) ? parsed : (parsed.services ?? [])
                          const result = (await trpcClient.hosts.importStaticConfig.mutate({
                            hostId: host.hostId,
                            services: importedServices,
                          })) as { services: ControlPlaneService[] }
                          setHostEditors((current) => ({
                            ...current,
                            [host.hostId]: result.services.map(toServiceDraft),
                          }))
                          setImportDrafts((current) => ({ ...current, [host.hostId]: '' }))
                          setImportOpenHostIds((current) => ({ ...current, [host.hostId]: false }))
                          setHostNotices((current) => ({
                            ...current,
                            [host.hostId]: { tone: 'success', text: 'static config 已导入到草稿，请确认后保存。' },
                          }))
                        } catch {
                          setHostNotices((current) => ({
                            ...current,
                            [host.hostId]: { tone: 'error', text: '导入 static config 失败。' },
                          }))
                        } finally {
                          setImportingHostIds((current) => ({ ...current, [host.hostId]: false }))
                        }
                      }}
                    >
                      {isImportingHost ? '导入中...' : '导入到草稿'}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <StateColumn
                title="Desired"
                items={host.desired?.services.map((service) => `${service.serviceName} · ${service.subdomain}`) ?? []}
                empty="暂无 desired services"
              />
              <StateColumn
                title="Current"
                items={host.current?.services.map((service) => `${service.serviceName} · ${service.subdomain}`) ?? []}
                empty={host.current?.error ?? '暂无 current report'}
              />
              <StateColumn
                title="Applied"
                items={host.applied?.services.map((service) => `${service.serviceName} · ${service.subdomain}`) ?? []}
                empty="暂无 applied projection"
              />
            </div>
          </Card>
        )})}
        {hosts.length === 0 ? (
          <Card>
            <p className="text-sm text-slate-400">还没有 host。现在可以先生成 bootstrap command 再接入新机器。</p>
          </Card>
        ) : null}
      </div>
    </div>
  )
}


function StateColumn({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div className="rounded-md border border-slate-800 p-4">
      <p className="text-sm font-medium text-slate-200">{title}</p>
      {items.length > 0 ? (
        <div className="mt-3 space-y-2 text-sm text-slate-300">
          {items.map((item) => (
            <p key={`${title}-${item}`}>{item}</p>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-slate-500">{empty}</p>
      )}
    </div>
  )
}
