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
  pendingBootstrapCount: number
  desiredDriftCount: number
  reachableServiceCount: number
  degradedServiceCount: number
  unreachableServiceCount: number
  staleServiceCount: number
  recentHosts: Array<{
    hostId: string
    healthy: boolean
    disconnectedAt: number | null
    lastHeartbeatAt: number | null
    serviceCount: number
    desiredGeneration: number | null
    currentGeneration: number | null
    currentStatus: 'pending' | 'acknowledged' | 'error' | null
    appliedGeneration: number | null
    projectedRouteCount: number
    problematicServiceCount: number
    staleServiceCount: number
  }>
  problemServices: Array<{
    hostId: string
    serviceId: string
    serviceName: string
    subdomain: string
    reachability: 'reachable' | 'degraded' | 'unreachable' | 'unknown'
    checkedAt: number | null
    currentStatus: 'pending' | 'acknowledged' | 'error' | null
    runtimeHealthy: boolean | null
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

type HostsLocateSearch = {
  hostId?: string
  serviceId?: string
  focus?: 'reachability'
}

type PageNotice = {
  tone: 'info' | 'error'
  text: string
}

type ServiceValidationResult = {
  fieldErrors: ServiceFieldError[]
  messages: string[]
  hasErrors: boolean
}

const normalizeHostsLocateSearch = (search: Record<string, unknown>): HostsLocateSearch => {
  const hostId = typeof search.hostId === 'string' && search.hostId.length > 0 ? search.hostId : null
  const serviceId = typeof search.serviceId === 'string' && search.serviceId.length > 0 ? search.serviceId : null
  const focus = search.focus === 'reachability' ? 'reachability' : null

  const normalized: HostsLocateSearch = {}
  if (hostId) {
    normalized.hostId = hostId
  }
  if (serviceId) {
    normalized.serviceId = serviceId
  }
  if (focus) {
    normalized.focus = focus
  }
  return normalized
}

const buildHostsLocateKey = (search: HostsLocateSearch) => {
  if (!search.hostId) {
    return null
  }
  return `${search.hostId}::${search.serviceId ?? ''}::${search.focus ?? ''}`
}

const buildReachabilityRowKey = (hostId: string, serviceId: string) => {
  return `${hostId}::${serviceId}`
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

const REACHABILITY_BAR_COUNT = 12
const REACHABILITY_STALE_MS = 15 * 60 * 1000
const LOCATE_HIGHLIGHT_MS = 2_000

const scrollNodeIntoView = (node: HTMLElement | null) => {
  node?.scrollIntoView({ behavior: 'smooth', block: 'center' })
}


type ReachabilityBarResult = ControlPlaneServiceReachabilitySummary['recentResults'][number]

const buildReachabilityBars = (results: ReachabilityBarResult[]) => {
  const chronological = [...results].reverse().slice(-REACHABILITY_BAR_COUNT)
  const padded = Array.from(
    { length: Math.max(REACHABILITY_BAR_COUNT - chronological.length, 0) },
    () => null as ReachabilityBarResult | null,
  )
  return [...padded, ...chronological]
}

const isReachabilityStale = (checkedAt: number | null) => {
  if (checkedAt === null) {
    return false
  }
  return Date.now() - checkedAt > REACHABILITY_STALE_MS
}

const getReachabilityLabel = (summary: ControlPlaneServiceReachabilitySummary) => {
  if (summary.checkedAt === null) {
    return { text: '无数据', className: 'text-slate-400' }
  }
  if (isReachabilityStale(summary.checkedAt)) {
    return { text: '已过期', className: 'text-slate-400' }
  }
  if (summary.reachability === 'reachable') {
    return { text: '可达', className: 'text-emerald-400' }
  }
  if (summary.reachability === 'degraded') {
    return { text: '不稳定', className: 'text-amber-400' }
  }
  if (summary.reachability === 'unreachable') {
    return { text: '不可达', className: 'text-rose-400' }
  }
  return { text: '未知', className: 'text-slate-400' }
}

const formatReachabilityTooltip = (result: ReachabilityBarResult | null) => {
  if (!result) {
    return '暂无数据'
  }

  return [
    `时间：${new Date(result.checkedAt).toLocaleString()}`,
    `结果：${result.success ? '成功' : '失败'}`,
    result.statusCode === undefined ? null : `状态码：${result.statusCode}`,
    result.latencyMs === undefined ? null : `耗时：${result.latencyMs}ms`,
    result.failureKind ? `失败原因：${result.failureKind}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

const getReachabilityBarClassName = (summary: ControlPlaneServiceReachabilitySummary, result: ReachabilityBarResult | null) => {
  if (!result) {
    return 'bg-slate-700'
  }
  if (isReachabilityStale(summary.checkedAt)) {
    return result.success ? 'bg-emerald-700/70' : 'bg-rose-700/70'
  }
  return result.success ? 'bg-emerald-400' : 'bg-rose-400'
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
  validateSearch: normalizeHostsLocateSearch,
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
  const navigate = dashboardRoute.useNavigate()
  const hostCards = useMemo(
    () => [
      { label: '总 Hosts', value: loaderData.hostCount, tone: 'text-slate-50' },
      { label: '在线 Hosts', value: loaderData.onlineHostCount, tone: 'text-emerald-400' },
      { label: '待认领', value: loaderData.pendingBootstrapCount, tone: 'text-amber-400' },
      { label: '配置未收敛', value: loaderData.desiredDriftCount, tone: 'text-amber-400' },
    ],
    [loaderData],
  )
  const serviceCards = useMemo(
    () => [
      { label: '可达 services', value: loaderData.reachableServiceCount, tone: 'text-emerald-400' },
      { label: '不稳定', value: loaderData.degradedServiceCount, tone: 'text-amber-400' },
      { label: '不可达', value: loaderData.unreachableServiceCount, tone: 'text-rose-400' },
      { label: '已过期', value: loaderData.staleServiceCount, tone: 'text-slate-300' },
    ],
    [loaderData],
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-slate-50">总览</h2>
          <p className="mt-1 text-sm text-slate-400">先看异常 host 和 service 连通性，再进入 Hosts 页面处理。</p>
        </div>
        <Button onClick={() => navigate({ to: '/hosts' })}>进入 Hosts</Button>
      </div>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-4">
          <div>
            <h3 className="text-lg font-medium text-slate-50">Host 概览</h3>
            <p className="text-sm text-slate-400">看接入、在线和配置收敛情况。</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {hostCards.map((card) => (
              <div key={card.label} className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                <p className="text-sm text-slate-400">{card.label}</p>
                <p className={`mt-3 text-3xl font-semibold ${card.tone}`}>{card.value}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-3 text-sm text-slate-400 sm:grid-cols-2">
            <div className="rounded-md border border-slate-800 px-4 py-3">
              <p className="text-slate-200">已投影 routes</p>
              <p className="mt-1 text-xl font-semibold text-slate-50">{loaderData.routeCount}</p>
            </div>
            <div className="rounded-md border border-slate-800 px-4 py-3">
              <p className="text-slate-200">离线 / 不健康</p>
              <p className="mt-1 text-xl font-semibold text-rose-400">{loaderData.unhealthyHostCount}</p>
            </div>
          </div>
        </Card>

        <Card className="space-y-4">
          <div>
            <h3 className="text-lg font-medium text-slate-50">Service 连通性</h3>
            <p className="text-sm text-slate-400">看当前可达、抖动、失败和结果是否过期。</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {serviceCards.map((card) => (
              <div key={card.label} className="rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                <p className="text-sm text-slate-400">{card.label}</p>
                <p className={`mt-3 text-3xl font-semibold ${card.tone}`}>{card.value}</p>
              </div>
            ))}
          </div>
          <p className="text-sm text-slate-500">过期表示最近结果太旧，不代表最新一定失败，但当前已经不够可信。</p>
        </Card>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <Card className="space-y-4">
          <div>
            <h3 className="text-lg font-medium text-slate-50">优先关注的 Hosts</h3>
            <p className="text-sm text-slate-400">按最近活动排序，优先看离线、未收敛或有异常 service 的 host。</p>
          </div>
          <div className="space-y-3">
            {loaderData.recentHosts.length > 0 ? loaderData.recentHosts.map((host) => {
              const statusText = host.healthy ? '在线' : '离线'
              const statusClassName = host.healthy ? 'text-emerald-400' : 'text-rose-400'
              return (
                <button
                  key={host.hostId}
                  type="button"
                  className="w-full rounded-md border border-slate-800 px-4 py-3 text-left hover:border-sky-500"
                  onClick={() => navigate({
                    to: '/hosts',
                    search: {
                      hostId: host.hostId,
                    },
                  })}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-slate-100">{host.hostId}</p>
                      <p className="text-sm text-slate-400">
                        service 数: {host.serviceCount} · routes: {host.projectedRouteCount}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm ${statusClassName}`}>{statusText}</p>
                      <p className="text-xs text-slate-500">
                        最近心跳：{host.lastHeartbeatAt ? new Date(host.lastHeartbeatAt).toLocaleTimeString() : '—'}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-500">
                    <p>desired g{host.desiredGeneration ?? '—'}</p>
                    <p>current g{host.currentGeneration ?? '—'} · {host.currentStatus ?? '—'}</p>
                    <p>applied g{host.appliedGeneration ?? '—'}</p>
                    <p>异常 services: {host.problematicServiceCount}</p>
                    <p>过期结果: {host.staleServiceCount}</p>
                  </div>
                </button>
              )
            }) : <p className="text-sm text-slate-500">当前还没有 host。</p>}
          </div>
        </Card>

        <Card className="space-y-4">
          <div>
            <h3 className="text-lg font-medium text-slate-50">需要优先处理的 Services</h3>
            <p className="text-sm text-slate-400">这里只列不稳定、不可达或已过期的 service。</p>
          </div>
          <div className="space-y-3">
            {loaderData.problemServices.length > 0 ? loaderData.problemServices.map((service) => {
              const reachabilityText = service.reachability === 'unreachable'
                ? '不可达'
                : service.reachability === 'degraded'
                  ? '不稳定'
                  : '已过期'
              const reachabilityClassName = service.reachability === 'unreachable'
                ? 'text-rose-400'
                : service.reachability === 'degraded'
                  ? 'text-amber-400'
                  : 'text-slate-300'

              return (
                <button
                  key={`${service.hostId}-${service.serviceId}`}
                  type="button"
                  className="w-full rounded-md border border-slate-800 px-4 py-3 text-left hover:border-sky-500"
                  onClick={() => navigate({
                    to: '/hosts',
                    search: {
                      hostId: service.hostId,
                      serviceId: service.serviceId,
                      focus: 'reachability',
                    },
                  })}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="font-medium text-slate-100">{service.serviceName}</p>
                      <p className="text-sm text-slate-400">{service.hostId} · {service.subdomain}</p>
                    </div>
                    <div className="text-right">
                      <p className={`text-sm ${reachabilityClassName}`}>{reachabilityText}</p>
                      <p className="text-xs text-slate-500">
                        最近检查：{service.checkedAt ? new Date(service.checkedAt).toLocaleTimeString() : '—'}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-3 text-xs text-slate-500">
                    <p>current: {service.currentStatus ?? '—'}</p>
                    <p>runtime: {service.runtimeHealthy === null ? '—' : service.runtimeHealthy ? 'healthy' : 'unhealthy'}</p>
                  </div>
                </button>
              )
            }) : <p className="text-sm text-slate-500">当前没有需要优先处理的 service。</p>}
          </div>
        </Card>
      </section>
    </div>
  )
}

function HostsPage() {
  const loaderData = hostsRoute.useLoaderData() as ControlPlaneHost[]
  const locateSearch = hostsRoute.useSearch() as HostsLocateSearch
  const [hosts, setHosts] = useState<ControlPlaneHost[]>(loaderData)
  const hostsRef = useRef(loaderData)
  const [hostEditors, setHostEditors] = useState<Record<string, ControlPlaneServiceDraft[]>>(() => buildHostEditors(loaderData))
  const [hostNotices, setHostNotices] = useState<Record<string, HostNotice | null>>({})
  const [pageNotice, setPageNotice] = useState<PageNotice | null>(null)
  const [savingHostIds, setSavingHostIds] = useState<Record<string, boolean>>({})
  const [deletingHostIds, setDeletingHostIds] = useState<Record<string, boolean>>({})
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
  const [reachabilityState, setReachabilityState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [importingHostIds, setImportingHostIds] = useState<Record<string, boolean>>({})
  const [importOpenHostIds, setImportOpenHostIds] = useState<Record<string, boolean>>({})
  const [highlightedHostId, setHighlightedHostId] = useState<string | null>(null)
  const [highlightedReachabilityKey, setHighlightedReachabilityKey] = useState<string | null>(null)
  const hostCardRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const reachabilityRowRefs = useRef<Record<string, HTMLDivElement | null>>({})
  const locateProgressRef = useRef<{
    key: string | null
    hostDone: boolean
    serviceDone: boolean
    settled: boolean
  }>({
    key: null,
    hostDone: false,
    serviceDone: false,
    settled: false,
  })
  const hostHighlightTimeoutRef = useRef<number | null>(null)
  const reachabilityHighlightTimeoutRef = useRef<number | null>(null)

  const flashHostHighlight = (nextHostId: string) => {
    setHighlightedHostId(nextHostId)
    if (hostHighlightTimeoutRef.current !== null) {
      window.clearTimeout(hostHighlightTimeoutRef.current)
    }
    hostHighlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightedHostId((current) => (current === nextHostId ? null : current))
      hostHighlightTimeoutRef.current = null
    }, LOCATE_HIGHLIGHT_MS)
  }

  const flashReachabilityHighlight = (nextKey: string) => {
    setHighlightedReachabilityKey(nextKey)
    if (reachabilityHighlightTimeoutRef.current !== null) {
      window.clearTimeout(reachabilityHighlightTimeoutRef.current)
    }
    reachabilityHighlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightedReachabilityKey((current) => (current === nextKey ? null : current))
      reachabilityHighlightTimeoutRef.current = null
    }, LOCATE_HIGHLIGHT_MS)
  }

  const reloadHosts = async (syncHostIds: string[] = []) => {
    const previousHosts = hostsRef.current
    const nextHosts = await (trpcClient.hosts.list.query() as Promise<ControlPlaneHost[]>)
    setHostEditors((currentEditors) => mergeHostEditors(currentEditors, previousHosts, nextHosts, syncHostIds))
    hostsRef.current = nextHosts
    setHosts(nextHosts)

    setReachabilityState('loading')
    try {
      const nextReachability = await (trpcClient.services.reachability.query() as Promise<ControlPlaneServiceReachabilitySummary[]>)
      setReachabilitySummaries(nextReachability)
      setReachabilityState('ready')
    } catch {
      setReachabilityState('error')
    }
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

    setReachabilityState('loading')
    void trpcClient.services.reachability.query().then((result) => {
      setReachabilitySummaries(result as ControlPlaneServiceReachabilitySummary[])
      setReachabilityState('ready')
    }).catch(() => {
      setReachabilityState('error')
    })
  }, [])

  useEffect(() => {
    return () => {
      if (hostHighlightTimeoutRef.current !== null) {
        window.clearTimeout(hostHighlightTimeoutRef.current)
      }
      if (reachabilityHighlightTimeoutRef.current !== null) {
        window.clearTimeout(reachabilityHighlightTimeoutRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const nextKey = buildHostsLocateKey(locateSearch)
    if (nextKey !== locateProgressRef.current.key) {
      locateProgressRef.current = {
        key: nextKey,
        hostDone: false,
        serviceDone: false,
        settled: false,
      }
      setPageNotice(null)
    }
  }, [locateSearch])

  useEffect(() => {
    const locateKey = buildHostsLocateKey(locateSearch)
    if (!locateKey || !locateSearch.hostId) {
      return
    }

    const progress = locateProgressRef.current
    if (progress.key !== locateKey) {
      return
    }
    if (progress.settled) {
      return
    }

    const targetHost = hosts.find((host) => host.hostId === locateSearch.hostId)
    if (!targetHost) {
      setPageNotice({ tone: 'error', text: '目标已不存在或状态已变化。' })
      progress.settled = true
      return
    }

    if (!progress.hostDone) {
      scrollNodeIntoView(hostCardRefs.current[targetHost.hostId] ?? null)
      flashHostHighlight(targetHost.hostId)
      progress.hostDone = true

      if (!locateSearch.serviceId || locateSearch.focus !== 'reachability') {
        progress.serviceDone = true
        progress.settled = true
        setPageNotice(null)
        return
      }
    }

    if (!locateSearch.serviceId || locateSearch.focus !== 'reachability') {
      progress.settled = true
      return
    }

    if (reachabilityState === 'loading') {
      setPageNotice({ tone: 'info', text: '正在定位目标 service 的连通性位置…' })
      return
    }

    if (reachabilityState === 'error') {
      setPageNotice({ tone: 'error', text: '连通性数据加载失败。' })
      progress.settled = true
      return
    }

    const targetSummary = reachabilitySummaries.find(
      (summary) => summary.hostId === locateSearch.hostId && summary.serviceId === locateSearch.serviceId,
    )

    if (!targetSummary) {
      setPageNotice({ tone: 'error', text: '目标已不存在或状态已变化。' })
      progress.settled = true
      return
    }

    const rowKey = buildReachabilityRowKey(targetSummary.hostId, targetSummary.serviceId)
    const rowNode = reachabilityRowRefs.current[rowKey] ?? null
    if (!rowNode) {
      return
    }

    scrollNodeIntoView(rowNode)
    flashReachabilityHighlight(rowKey)
    progress.serviceDone = true
    progress.settled = true
    setPageNotice(null)
  }, [hosts, locateSearch, reachabilityState, reachabilitySummaries])

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold text-slate-50">Hosts</h2>
        <p className="text-sm text-slate-400">Phase 4 增加最小 bootstrap onboarding command 生成。</p>
      </div>
      {pageNotice ? (
        <Card className={pageNotice.tone === 'error' ? 'border-rose-500/40 bg-rose-500/10' : 'border-sky-500/40 bg-sky-500/10'}>
          <p className={pageNotice.tone === 'error' ? 'text-sm text-rose-300' : 'text-sm text-sky-200'}>{pageNotice.text}</p>
        </Card>
      ) : null}
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
          const isDeletingHost = Boolean(deletingHostIds[host.hostId])
          const isHostBusy = isSavingHost || isImportingHost || isDeletingHost
          const isImportOpen = Boolean(importOpenHostIds[host.hostId])
          const hostNotice = hostNotices[host.hostId] ?? null
          const importDraft = importDrafts[host.hostId] ?? ''
          const serviceSummaries = reachabilitySummaries.filter((summary) => summary.hostId === host.hostId)
          const isHostHighlighted = highlightedHostId === host.hostId
          return (
          <div
            key={host.hostId}
            ref={(node: HTMLDivElement | null) => {
              hostCardRefs.current[host.hostId] = node
            }}
          >
            <Card className={`space-y-4 ${isHostHighlighted ? 'border-sky-500 bg-sky-500/10' : ''}`}>
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
                <p className="text-sm text-slate-500">用 12 个小竖条展示最近观测结果，左边更早，右边更新。灰色表示无数据；如果最近结果太旧，当前状态会显示为已过期。</p>
              </div>
              {serviceSummaries.length > 0 ? (
                <div className="space-y-3">
                  {serviceSummaries.map((summary) => {
                    const reachabilityLabel = getReachabilityLabel(summary)
                    const bars = buildReachabilityBars(summary.recentResults)
                    const reachabilityKey = buildReachabilityRowKey(summary.hostId, summary.serviceId)
                    const isReachabilityHighlighted = highlightedReachabilityKey === reachabilityKey
                    return (
                      <div
                        key={`${summary.hostId}-${summary.serviceId}`}
                        className={`rounded-md border px-4 py-3 ${isReachabilityHighlighted ? 'border-sky-500 bg-sky-500/10' : 'border-slate-800'}`}
                        ref={(node: HTMLDivElement | null) => {
                          reachabilityRowRefs.current[reachabilityKey] = node
                        }}
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="font-medium text-slate-100">{summary.serviceName} · {summary.subdomain}</p>
                            <p className="text-sm text-slate-400">{summary.serviceId} · {summary.protocol} · {summary.hasProjectedRoute ? 'projected' : 'not projected'}</p>
                          </div>
                          <div className="text-right">
                            <p className={`text-sm ${reachabilityLabel.className}`}>{reachabilityLabel.text}</p>
                            <p className="text-xs text-slate-500">最近检查：{summary.checkedAt ? new Date(summary.checkedAt).toLocaleTimeString() : '—'}</p>
                          </div>
                        </div>
                        <div className="mt-3 flex items-end gap-1" aria-label={`${summary.serviceName} 最近 12 次观测结果`}>
                          {bars.map((result, index) => (
                            <span
                              key={`${summary.serviceId}-bar-${index}-${result?.checkedAt ?? 'empty'}`}
                              className={`h-8 w-2 rounded-sm ${getReachabilityBarClassName(summary, result)}`}
                              title={formatReachabilityTooltip(result)}
                            />
                          ))}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-3 text-xs text-slate-500">
                          <p>最近成功：{summary.lastSuccessAt ? new Date(summary.lastSuccessAt).toLocaleTimeString() : '—'}</p>
                          <p>最近失败：{summary.lastFailureAt ? new Date(summary.lastFailureAt).toLocaleTimeString() : '—'}</p>
                        </div>
                        <div className="mt-3 grid gap-2 text-xs text-slate-500 md:grid-cols-3">
                          <p>desired g{summary.desiredGeneration ?? '—'}</p>
                          <p>current g{summary.currentGeneration ?? '—'} · {summary.currentStatus ?? '—'}</p>
                          <p>applied g{summary.appliedGeneration ?? '—'}</p>
                        </div>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="text-sm text-slate-500">当前 host 还没有 service reachability 摘要。</p>
              )}
            </div>
            <div className="rounded-md border border-slate-800 p-4 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-200">Desired services editor</p>
                  <p className="text-sm text-slate-500">直接编辑并保存 desired.services；必要时可清空当前 host 的 control state。</p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    className="bg-slate-800 text-slate-100 hover:bg-slate-700"
                    disabled={isHostBusy}
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
                    disabled={isHostBusy}
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
                    disabled={!isDirty || isHostBusy}
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
                    disabled={isHostBusy || !isDirty || validation.hasErrors}
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
                  <Button
                    type="button"
                    className="bg-rose-900 text-rose-100 hover:bg-rose-800"
                    disabled={isHostBusy}
                    onClick={async () => {
                      if (!window.confirm(`确认清空 host ${host.hostId} 的 control state 吗？这不会断开当前在线 session；主要清空 bootstrap / desired/current/applied 等控制面记录。`)) {
                        return
                      }

                      setDeletingHostIds((current) => ({ ...current, [host.hostId]: true }))
                      setHostNotices((current) => ({ ...current, [host.hostId]: null }))
                      try {
                        await trpcClient.hosts.remove.mutate({ hostId: host.hostId })
                        await reloadHosts([host.hostId])
                        setImportDrafts((current) => ({ ...current, [host.hostId]: '' }))
                        setHostNotices((current) => ({
                          ...current,
                          [host.hostId]: { tone: 'success', text: 'control state 已清空。' },
                        }))
                      } catch {
                        setHostNotices((current) => ({
                          ...current,
                          [host.hostId]: { tone: 'error', text: '清空 control state 失败。' },
                        }))
                      } finally {
                        setDeletingHostIds((current) => ({ ...current, [host.hostId]: false }))
                      }
                    }}
                  >
                    {deletingHostIds[host.hostId] ? '清空中...' : '清空 control state'}
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
                          disabled={isHostBusy}
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
                          disabled={isHostBusy}
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
                          disabled={isHostBusy}
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
                          disabled={isHostBusy}
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
                          disabled={isHostBusy}
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
                        disabled={isHostBusy}
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
                      <p className="text-sm font-medium text-slate-200">Import static config</p>
                      <p className="text-sm text-slate-500">把旧静态配置迁移到当前 host 的 desired.services。导入后会立即接管到可视化编辑器。</p>
                    </div>
                    <Button
                      type="button"
                      className="bg-slate-800 text-slate-100 hover:bg-slate-700"
                      disabled={isHostBusy}
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
                    disabled={isHostBusy}
                    onChange={(event) => {
                      const value = event.target.value
                      setImportDrafts((current) => ({ ...current, [host.hostId]: value }))
                    }}
                  />
                  <div className="flex justify-end">
                    <Button
                      type="button"
                      disabled={isHostBusy || importDraft.length === 0}
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
                          await trpcClient.hosts.upsertDesired.mutate({
                            hostId: host.hostId,
                            services: result.services,
                          })
                          await reloadHosts([host.hostId])
                          setImportDrafts((current) => ({ ...current, [host.hostId]: '' }))
                          setImportOpenHostIds((current) => ({ ...current, [host.hostId]: false }))
                          setHostNotices((current) => ({
                            ...current,
                            [host.hostId]: { tone: 'success', text: 'static config 已导入，已切换到可视化编辑。' },
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
                      {isImportingHost ? '导入中...' : '导入到该 Host'}
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
        </div>
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
