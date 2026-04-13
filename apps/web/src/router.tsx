import { createRootRouteWithContext, createRoute, createRouter, Outlet, redirect } from '@tanstack/react-router'
import { useSetAtom } from 'jotai'
import { useEffect, useMemo, useState } from 'react'
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
    services: Array<{ serviceId: string; serviceName: string; subdomain: string }>
  } | null
  current: {
    generation: number
    status: 'pending' | 'acknowledged' | 'error'
    services: Array<{ serviceId: string; serviceName: string; subdomain: string }>
    error?: string
  } | null
  applied: {
    generation: number
    services: Array<{ serviceId: string; serviceName: string; subdomain: string }>
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
  const hosts = hostsRoute.useLoaderData() as ControlPlaneHost[]
  const [hostId, setHostId] = useState('')
  const [hostname, setHostname] = useState('')
  const [command, setCommand] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [issuing, setIssuing] = useState(false)

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
            setError(null)
            try {
              const result = (await trpcClient.hosts.issueBootstrap.mutate({
                hostId,
                hostname,
                edgeBaseUrl: window.location.origin,
              })) as BootstrapIssueResult
              setCommand(result.command)
            } catch {
              setError('生成 onboarding command 失败。')
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
        {error ? <p className="text-sm text-rose-400">{error}</p> : null}
        {command ? (
          <div className="rounded-md border border-slate-800 bg-slate-950 p-4">
            <p className="mb-2 text-sm text-slate-400">Onboarding command</p>
            <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-slate-200">{command}</pre>
          </div>
        ) : null}
      </Card>
      <div className="space-y-4">
        {hosts.map((host) => (
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
                <p>applied g{host.applied?.generation ?? '—'}</p>
              </div>
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
        ))}
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
