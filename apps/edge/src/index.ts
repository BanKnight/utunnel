import { DurableObject } from 'cloudflare:workers'
import {
  appliedHostConfigSchema,
  configDispatchMessageSchema,
  currentHostConfigSchema,
  desiredHostConfigSchema,
  heartbeatMessageSchema,
  reconcileAckMessageSchema,
  responseEnvelopeSchema,
  serviceProbeRecordSchema,
  serviceReachabilitySummarySchema,
  websocketCloseSchema,
  websocketFrameSchema,
  type AppliedHostConfig,
  type CurrentHostConfig,
  type DesiredHostConfig,
  type HostSessionRecord,
  type HttpRequestMessage,
  type HttpResponseMessage,
  type RoutingEntry,
  type ServiceDefinition,
  type ServiceProbeFailureKind,
  type ServiceProbeRecord,
  type ServiceReachability,
  type ServiceReachabilitySummary,
  type WebSocketCloseMessage,
  type WebSocketFrameMessage,
  type WebSocketOpenMessage,
} from '@utunnel/protocol'
import { handleEdgeFetch } from './worker-entry'
import type { EdgeBindings } from './types'
import { markSessionDisconnected, markSessionHeartbeat, normalizeServiceDefinitions } from './lib'
import { deriveServiceReachability } from './reachability'

const decoder = new TextDecoder()

type AppliedRouteProjection = {
  hostId: string
  serviceId: string
  hostname: string
  generation: number
  projectedAt: number
}

type BootstrapRecord = {
  hostId: string
  hostname: string
  bootstrapToken: string
  issuedAt: number
  expiresAt: number
  claimedAt: number | null
}

type BootstrapState = Omit<BootstrapRecord, 'bootstrapToken'>

type HostAccessTokenRecord = {
  token: string
  issuedAt: number
}

type ControlApiTokenRecord = {
  tokenId: string
  prefix: string
  tokenHash: string
  label?: string
  createdAt: number
  rotatedAt: number | null
  revokedAt: number | null
  lastUsedAt: number | null
}

type ControlApiTokenMetadata = Omit<ControlApiTokenRecord, 'tokenHash'>

type ProbeExecutionResult = {
  hostId: string
  serviceId: string
  checkedAt: number
  success: boolean
  statusCode?: number | undefined
  latencyMs?: number | undefined
  failureKind?: ServiceProbeFailureKind | undefined
}

type HostControlState = {
  hostId: string
  bootstrap: BootstrapState | null
  desired: DesiredHostConfig | null
  current: CurrentHostConfig | null
  applied: AppliedHostConfig | null
  projectedRoutes: AppliedRouteProjection[]
}

type ConfigDispatchMessage = ReturnType<typeof configDispatchMessageSchema.parse>
type ReconcileAckMessage = ReturnType<typeof reconcileAckMessageSchema.parse>

type RelayHttpRequest = {
  expectedSessionId: string
  expectedVersion: number
  request: HttpRequestMessage
}

type RelayWebSocketRequest = {
  expectedSessionId: string
  expectedVersion: number
  request: WebSocketOpenMessage
}

type ConnectionRole =
  | { type: 'host' }
  | { type: 'client'; streamId: string }

type ReachabilityObservation = ProbeExecutionResult

export class RoutingDirectory extends DurableObject<EdgeBindings> {
  private static readonly PROBE_HISTORY_LIMIT = 5

  private bootstrapKey(hostId: string) {
    return `bootstrap:${hostId}`
  }

  private desiredKey(hostId: string) {
    return `desired:${hostId}`
  }

  private desiredGenerationKey(hostId: string) {
    return `desired-generation:${hostId}`
  }

  private currentKey(hostId: string) {
    return `current:${hostId}`
  }

  private appliedKey(hostId: string) {
    return `applied:${hostId}`
  }

  private hostTokenKey(hostId: string) {
    return `host-token:${hostId}`
  }

  private apiTokenKey(tokenId: string) {
    return `api-token:${tokenId}`
  }

  private probeKey(hostId: string, serviceId: string, checkedAt: number) {
    return `probe:${hostId}:${serviceId}:${checkedAt}`
  }

  private probePrefix(hostId: string, serviceId: string) {
    return `probe:${hostId}:${serviceId}:`
  }

  private async hashToken(token: string) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  }

  private buildApiTokenValue() {
    return `utapi_${crypto.randomUUID().replace(/-/g, '')}`
  }

  private toApiTokenMetadata(record: ControlApiTokenRecord): ControlApiTokenMetadata {
    const { tokenHash: _tokenHash, ...metadata } = record
    return metadata
  }

  private async listApiTokens() {
    const entries = await this.ctx.storage.list<ControlApiTokenRecord>({ prefix: 'api-token:' })
    return Array.from(entries.values())
      .map((record) => this.toApiTokenMetadata(record))
      .sort((left, right) => right.createdAt - left.createdAt)
  }

  private async findApiTokenByValue(token: string) {
    const tokenHash = await this.hashToken(token)
    const entries = await this.ctx.storage.list<ControlApiTokenRecord>({ prefix: 'api-token:' })
    for (const record of entries.values()) {
      if (record.revokedAt === null && record.tokenHash === tokenHash) {
        return record
      }
    }
    return null
  }

  private buildProjectedRoutes(applied: AppliedHostConfig | null): AppliedRouteProjection[] {
    if (!applied) {
      return []
    }

    return applied.services.map((service) => ({
      hostId: applied.hostId,
      serviceId: service.serviceId,
      hostname: service.subdomain,
      generation: applied.generation,
      projectedAt: applied.appliedAt,
    }))
  }

  private collectServices(state: HostControlState) {
    const serviceById = new Map<string, ServiceDefinition>()

    for (const service of state.desired?.services ?? []) {
      serviceById.set(service.serviceId, service)
    }
    for (const service of state.current?.services ?? []) {
      if (!serviceById.has(service.serviceId)) {
        serviceById.set(service.serviceId, service)
      }
    }
    for (const service of state.applied?.services ?? []) {
      if (!serviceById.has(service.serviceId)) {
        serviceById.set(service.serviceId, service)
      }
    }

    return Array.from(serviceById.values())
  }

  private async listRecentProbeRecords(hostId: string, serviceId: string): Promise<ServiceProbeRecord[]> {
    const entries = await this.ctx.storage.list<ServiceProbeRecord>({ prefix: this.probePrefix(hostId, serviceId) })
    return Array.from(entries.values())
      .sort((left, right) => right.checkedAt - left.checkedAt)
      .slice(0, RoutingDirectory.PROBE_HISTORY_LIMIT)
  }

  private async buildServiceReachabilitySummary(
    hostId: string,
    service: ServiceDefinition,
  ): Promise<ServiceReachabilitySummary> {
    const recentResults = await this.listRecentProbeRecords(hostId, service.serviceId)
    const lastSuccess = recentResults.find((result) => result.success) ?? null
    const lastFailure = recentResults.find((result) => !result.success) ?? null

    return serviceReachabilitySummarySchema.parse({
      hostId,
      serviceId: service.serviceId,
      serviceName: service.serviceName,
      subdomain: service.subdomain,
      protocol: service.protocol,
      reachability: deriveServiceReachability(recentResults),
      checkedAt: recentResults[0]?.checkedAt ?? null,
      lastSuccessAt: lastSuccess?.checkedAt ?? null,
      lastFailureAt: lastFailure?.checkedAt ?? null,
      recentResults: recentResults.map((result) => ({
        checkedAt: result.checkedAt,
        success: result.success,
        statusCode: result.statusCode,
        latencyMs: result.latencyMs,
        failureKind: result.failureKind,
      })),
    })
  }

  private async listServiceReachabilitySummaries(): Promise<ServiceReachabilitySummary[]> {
    const states = await this.listHostControlStates()
    const summaries = await Promise.all(
      states.flatMap((state) =>
        (state.applied?.services ?? []).map((service) => this.buildServiceReachabilitySummary(state.hostId, service)),
      ),
    )

    return summaries.sort((left, right) => {
      if (left.hostId !== right.hostId) {
        return left.hostId.localeCompare(right.hostId)
      }
      return left.serviceId.localeCompare(right.serviceId)
    })
  }

  private async recordProbeResult(result: ReachabilityObservation) {
    const record = serviceProbeRecordSchema.parse(result)
    await this.ctx.storage.put(this.probeKey(result.hostId, result.serviceId, result.checkedAt), record)
    const entries = await this.ctx.storage.list<ServiceProbeRecord>({ prefix: this.probePrefix(result.hostId, result.serviceId) })
    const staleKeys = Array.from(entries.entries())
      .sort((left, right) => right[1].checkedAt - left[1].checkedAt)
      .slice(RoutingDirectory.PROBE_HISTORY_LIMIT)
      .map(([key]) => key)

    if (staleKeys.length > 0) {
      await Promise.all(staleKeys.map((key) => this.ctx.storage.delete(key)))
    }
  }

  private async executeServiceProbe(hostId: string, service: ServiceDefinition): Promise<ProbeExecutionResult> {
    const startedAt = Date.now()
    try {
      const response = await fetch(`https://${service.subdomain}/`, {
        method: 'GET',
        headers: {
          'user-agent': 'utunnel-reachability-probe/1.0',
          'x-utunnel-probe': '1',
        },
      })

      const checkedAt = Date.now()
      const latencyMs = checkedAt - startedAt
      const success = response.status < 500
      return success
        ? {
            hostId,
            serviceId: service.serviceId,
            checkedAt,
            success: true,
            statusCode: response.status,
            latencyMs,
          }
        : {
            hostId,
            serviceId: service.serviceId,
            checkedAt,
            success: false,
            statusCode: response.status,
            latencyMs,
            failureKind: 'status-code',
          }
    } catch {
      const checkedAt = Date.now()
      return {
        hostId,
        serviceId: service.serviceId,
        checkedAt,
        success: false,
        latencyMs: checkedAt - startedAt,
        failureKind: 'unknown',
      }
    }
  }

  private async runReachabilityProbePass() {
    const states = await this.listHostControlStates()
    for (const state of states) {
      for (const service of state.applied?.services ?? []) {
        if (service.protocol !== 'http') {
          continue
        }

        try {
          const result = await this.executeServiceProbe(state.hostId, service)
          await this.recordProbeResult(result)
        } catch (error) {
          console.error('reachability_probe_failed', {
            hostId: state.hostId,
            serviceId: service.serviceId,
            reason: error instanceof Error ? error.message : 'unknown_error',
          })
        }
      }
    }
  }

  private scheduleNextProbeRun(_delayMs = 30_000) {
    return
  }

  private async readHostControlState(hostId: string): Promise<HostControlState> {
    const [bootstrap, desired, current, applied] = await Promise.all([
      this.ctx.storage.get<BootstrapRecord>(this.bootstrapKey(hostId)),
      this.ctx.storage.get<DesiredHostConfig>(this.desiredKey(hostId)),
      this.ctx.storage.get<CurrentHostConfig>(this.currentKey(hostId)),
      this.ctx.storage.get<AppliedHostConfig>(this.appliedKey(hostId)),
    ])

    return {
      hostId,
      bootstrap: bootstrap
        ? {
            hostId: bootstrap.hostId,
            hostname: bootstrap.hostname,
            issuedAt: bootstrap.issuedAt,
            expiresAt: bootstrap.expiresAt,
            claimedAt: bootstrap.claimedAt,
          }
        : null,
      desired: desired ?? null,
      current: current ?? null,
      applied: applied ?? null,
      projectedRoutes: this.buildProjectedRoutes(applied ?? null),
    }
  }

  private async listHostControlStates(): Promise<HostControlState[]> {
    const [bootstrapEntries, desiredEntries, currentEntries, appliedEntries] = await Promise.all([
      this.ctx.storage.list<BootstrapRecord>({ prefix: 'bootstrap:' }),
      this.ctx.storage.list<DesiredHostConfig>({ prefix: 'desired:' }),
      this.ctx.storage.list<CurrentHostConfig>({ prefix: 'current:' }),
      this.ctx.storage.list<AppliedHostConfig>({ prefix: 'applied:' }),
    ])

    const hostIds = new Set<string>()
    for (const key of bootstrapEntries.keys()) {
      hostIds.add(key.replace(/^bootstrap:/, ''))
    }
    for (const key of desiredEntries.keys()) {
      hostIds.add(key.replace(/^desired:/, ''))
    }
    for (const key of currentEntries.keys()) {
      hostIds.add(key.replace(/^current:/, ''))
    }
    for (const key of appliedEntries.keys()) {
      hostIds.add(key.replace(/^applied:/, ''))
    }

    return Promise.all(
      Array.from(hostIds)
        .sort((left, right) => left.localeCompare(right))
        .map((hostId) => this.readHostControlState(hostId)),
    )
  }

  private async listAppliedRouteProjections(): Promise<AppliedRouteProjection[]> {
    const states = await this.listHostControlStates()
    return states.flatMap((state) => state.projectedRoutes)
  }

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

    if (request.method === 'GET' && url.pathname === '/control/hosts') {
      return Response.json(await this.listHostControlStates())
    }

    if (request.method === 'GET' && url.pathname === '/control/routes') {
      return Response.json(await this.listAppliedRouteProjections())
    }

    if (request.method === 'GET' && url.pathname === '/control/services/reachability') {
      return Response.json(await this.listServiceReachabilitySummaries())
    }

    if (request.method === 'POST' && url.pathname === '/control/probes/record') {
      const result = serviceProbeRecordSchema.parse(await request.json())
      await this.recordProbeResult(result)
      return Response.json({ ok: true })
    }

    if (request.method === 'POST' && url.pathname === '/control/probes/run') {
      return Response.json({ ok: true, mode: 'disabled' })
    }

    if (request.method === 'GET' && url.pathname === '/control/tokens') {
      return Response.json(await this.listApiTokens())
    }

    if (request.method === 'POST' && url.pathname === '/control/tokens') {
      const body = (await request.json().catch(() => null)) as { label?: string } | null
      const label = body?.label?.trim() ? body.label.trim() : undefined
      const token = this.buildApiTokenValue()
      const createdAt = Date.now()
      const record: ControlApiTokenRecord = label
        ? {
            tokenId: crypto.randomUUID(),
            prefix: token.slice(0, 12),
            tokenHash: await this.hashToken(token),
            label,
            createdAt,
            rotatedAt: null,
            revokedAt: null,
            lastUsedAt: null,
          }
        : {
            tokenId: crypto.randomUUID(),
            prefix: token.slice(0, 12),
            tokenHash: await this.hashToken(token),
            createdAt,
            rotatedAt: null,
            revokedAt: null,
            lastUsedAt: null,
          }
      await this.ctx.storage.put(this.apiTokenKey(record.tokenId), record)
      return Response.json({
        ...this.toApiTokenMetadata(record),
        token,
      })
    }

    if (request.method === 'POST' && url.pathname === '/control/tokens/verify') {
      const body = (await request.json().catch(() => null)) as { token?: string } | null
      if (!body?.token) {
        return Response.json({ ok: false })
      }

      const record = await this.findApiTokenByValue(body.token)
      if (!record) {
        return Response.json({ ok: false })
      }

      const updatedRecord = {
        ...record,
        lastUsedAt: Date.now(),
      } satisfies ControlApiTokenRecord
      await this.ctx.storage.put(this.apiTokenKey(record.tokenId), updatedRecord)
      return Response.json({ ok: true, tokenId: record.tokenId })
    }

    const controlTokenMatch = url.pathname.match(/^\/control\/tokens\/([^/]+?)\/(rotate|revoke)$/)
    if (controlTokenMatch && request.method === 'POST') {
      const tokenId = decodeURIComponent(controlTokenMatch[1] ?? '')
      const action = controlTokenMatch[2]
      if (!tokenId) {
        return Response.json({ ok: false, reason: 'token_id_required' }, { status: 400 })
      }

      const record = await this.ctx.storage.get<ControlApiTokenRecord>(this.apiTokenKey(tokenId))
      if (!record) {
        return Response.json({ ok: false, reason: 'token_not_found' }, { status: 404 })
      }

      if (action === 'rotate') {
        if (record.revokedAt !== null) {
          return Response.json({ ok: false, reason: 'token_revoked' }, { status: 409 })
        }

        const token = this.buildApiTokenValue()
        const rotatedRecord = {
          ...record,
          prefix: token.slice(0, 12),
          tokenHash: await this.hashToken(token),
          rotatedAt: Date.now(),
          lastUsedAt: null,
        } satisfies ControlApiTokenRecord
        await this.ctx.storage.put(this.apiTokenKey(tokenId), rotatedRecord)
        return Response.json({
          ...this.toApiTokenMetadata(rotatedRecord),
          token,
        })
      }

      const revokedRecord = {
        ...record,
        revokedAt: record.revokedAt ?? Date.now(),
      } satisfies ControlApiTokenRecord
      await this.ctx.storage.put(this.apiTokenKey(tokenId), revokedRecord)
      return Response.json(this.toApiTokenMetadata(revokedRecord))
    }

    const bootstrapMatch = url.pathname.match(/^\/control\/hosts\/([^/]+?)\/bootstrap$/)
    if (bootstrapMatch) {
      const hostId = decodeURIComponent(bootstrapMatch[1] ?? '')
      if (!hostId) {
        return Response.json({ ok: false, reason: 'host_id_required' }, { status: 400 })
      }

      if (request.method === 'POST') {
        const existingHostToken = await this.ctx.storage.get<HostAccessTokenRecord>(this.hostTokenKey(hostId))
        if (existingHostToken) {
          return Response.json({ ok: false, reason: 'host_already_claimed' }, { status: 409 })
        }

        const body = (await request.json().catch(() => null)) as { hostname?: string; expiresInMs?: number } | null
        const hostname = body?.hostname?.trim()
        if (!hostname) {
          return Response.json({ ok: false, reason: 'hostname_required' }, { status: 400 })
        }

        const expiresInMs = body?.expiresInMs ?? 10 * 60 * 1000
        if (!Number.isInteger(expiresInMs) || expiresInMs <= 0) {
          return Response.json({ ok: false, reason: 'invalid_bootstrap_expiry' }, { status: 400 })
        }

        const issuedAt = Date.now()
        const bootstrap = {
          hostId,
          hostname,
          bootstrapToken: crypto.randomUUID(),
          issuedAt,
          expiresAt: issuedAt + expiresInMs,
          claimedAt: null,
        } satisfies BootstrapRecord
        await this.ctx.storage.put(this.bootstrapKey(hostId), bootstrap)
        return Response.json(bootstrap)
      }
    }

    const claimMatch = url.pathname.match(/^\/control\/hosts\/([^/]+?)\/claim$/)
    if (claimMatch) {
      const hostId = decodeURIComponent(claimMatch[1] ?? '')
      if (!hostId) {
        return Response.json({ ok: false, reason: 'host_id_required' }, { status: 400 })
      }

      if (request.method === 'POST') {
        const body = (await request.json().catch(() => null)) as { hostname?: string; bootstrapToken?: string } | null
        const bootstrap = await this.ctx.storage.get<BootstrapRecord>(this.bootstrapKey(hostId))
        if (!bootstrap) {
          return Response.json({ ok: false, reason: 'bootstrap_not_found' }, { status: 404 })
        }
        if (bootstrap.claimedAt !== null) {
          return Response.json({ ok: false, reason: 'bootstrap_already_used' }, { status: 409 })
        }
        if (Date.now() > bootstrap.expiresAt) {
          return Response.json({ ok: false, reason: 'bootstrap_expired' }, { status: 409 })
        }
        if (!body?.hostname || body.hostname !== bootstrap.hostname) {
          return Response.json({ ok: false, reason: 'hostname_mismatch' }, { status: 409 })
        }
        if (!body?.bootstrapToken || body.bootstrapToken !== bootstrap.bootstrapToken) {
          return Response.json({ ok: false, reason: 'invalid_bootstrap_token' }, { status: 401 })
        }

        const claimedAt = Date.now()
        const hostToken = {
          token: `${hostId}.${crypto.randomUUID()}`,
          issuedAt: claimedAt,
        } satisfies HostAccessTokenRecord
        await Promise.all([
          this.ctx.storage.put(this.bootstrapKey(hostId), { ...bootstrap, claimedAt }),
          this.ctx.storage.put(this.hostTokenKey(hostId), hostToken),
        ])
        return Response.json({ ok: true, hostId, token: hostToken.token, claimedAt })
      }
    }

    const tokenVerifyMatch = url.pathname.match(/^\/control\/hosts\/([^/]+?)\/token\/verify$/)
    if (tokenVerifyMatch) {
      const hostId = decodeURIComponent(tokenVerifyMatch[1] ?? '')
      if (!hostId) {
        return Response.json({ ok: false, reason: 'host_id_required' }, { status: 400 })
      }

      if (request.method === 'POST') {
        const body = (await request.json().catch(() => null)) as { token?: string } | null
        const hostToken = await this.ctx.storage.get<HostAccessTokenRecord>(this.hostTokenKey(hostId))
        const ok = Boolean(body?.token) && body?.token === hostToken?.token
        return Response.json({ ok })
      }
    }

    const controlMatch = url.pathname.match(/^\/control\/hosts\/([^/]+?)(?:\/(desired|current|applied))?$/)
    if (controlMatch) {
      const hostId = decodeURIComponent(controlMatch[1] ?? '')
      const action = controlMatch[2] ?? null

      if (!hostId) {
        return Response.json({ ok: false, reason: 'host_id_required' }, { status: 400 })
      }

      if (request.method === 'GET' && action === null) {
        const state = await this.readHostControlState(hostId)
        if (!state.bootstrap && !state.desired && !state.current && !state.applied) {
          return Response.json({ ok: false, reason: 'host_not_found' }, { status: 404 })
        }
        return Response.json(state)
      }

      if (request.method === 'DELETE' && action === null) {
        await Promise.all([
          this.ctx.storage.delete(this.bootstrapKey(hostId)),
          this.ctx.storage.delete(this.desiredKey(hostId)),
          this.ctx.storage.delete(this.currentKey(hostId)),
          this.ctx.storage.delete(this.appliedKey(hostId)),
        ])
        return Response.json({ ok: true })
      }

      if (request.method === 'PUT' && action === 'desired') {
        try {
          const body = (await request.json()) as { services: DesiredHostConfig['services'] }
          const existing = await this.ctx.storage.get<DesiredHostConfig>(this.desiredKey(hostId))
          const generationCounter = await this.ctx.storage.get<number>(this.desiredGenerationKey(hostId))
          const generation = Math.max(existing?.generation ?? 0, generationCounter ?? 0) + 1
          const desired = desiredHostConfigSchema.parse({
            hostId,
            generation,
            services: normalizeServiceDefinitions(body.services ?? []),
            updatedAt: Date.now(),
          })
          await Promise.all([
            this.ctx.storage.put(this.desiredKey(hostId), desired),
            this.ctx.storage.put(this.desiredGenerationKey(hostId), generation),
          ])
          return Response.json(desired)
        } catch (error) {
          return Response.json(
            { ok: false, reason: error instanceof Error ? error.message : 'invalid_desired_payload' },
            { status: 400 },
          )
        }
      }

      if (request.method === 'POST' && action === 'current') {
        const desired = await this.ctx.storage.get<DesiredHostConfig>(this.desiredKey(hostId))
        if (!desired) {
          return Response.json({ ok: false, reason: 'desired_not_found' }, { status: 409 })
        }

        try {
          const body = (await request.json()) as {
            generation: number
            status: CurrentHostConfig['status']
            services: CurrentHostConfig['services']
            error?: string
          }
          const current = currentHostConfigSchema.parse({
            hostId,
            generation: body.generation,
            status: body.status,
            services: normalizeServiceDefinitions(body.services ?? []),
            error: body.error,
            reportedAt: Date.now(),
          })

          if (current.generation !== desired.generation) {
            return Response.json({ ok: false, reason: 'generation_mismatch' }, { status: 409 })
          }

          await this.ctx.storage.put(this.currentKey(hostId), current)
          return Response.json(current)
        } catch (error) {
          return Response.json(
            { ok: false, reason: error instanceof Error ? error.message : 'invalid_current_payload' },
            { status: 400 },
          )
        }
      }

      if (request.method === 'POST' && action === 'applied') {
        const desired = await this.ctx.storage.get<DesiredHostConfig>(this.desiredKey(hostId))
        const current = await this.ctx.storage.get<CurrentHostConfig>(this.currentKey(hostId))

        if (!desired) {
          return Response.json({ ok: false, reason: 'desired_not_found' }, { status: 409 })
        }
        if (!current) {
          return Response.json({ ok: false, reason: 'current_not_found' }, { status: 409 })
        }
        if (current.status !== 'acknowledged') {
          return Response.json({ ok: false, reason: 'current_not_acknowledged' }, { status: 409 })
        }

        try {
          const body = (await request.json()) as {
            generation: number
            services: AppliedHostConfig['services']
          }
          const applied = appliedHostConfigSchema.parse({
            hostId,
            generation: body.generation,
            services: normalizeServiceDefinitions(body.services ?? []),
            appliedAt: Date.now(),
          })

          if (applied.generation !== desired.generation || applied.generation !== current.generation) {
            return Response.json({ ok: false, reason: 'generation_mismatch' }, { status: 409 })
          }

          await this.ctx.storage.put(this.appliedKey(hostId), applied)
          return Response.json(applied)
        } catch (error) {
          return Response.json(
            { ok: false, reason: error instanceof Error ? error.message : 'invalid_applied_payload' },
            { status: 400 },
          )
        }
      }
    }

    return Response.json({ error: 'not_found' }, { status: 404 })
  }

  async alarm() {
    return
  }
}

export class HostSession extends DurableObject<EdgeBindings> {
  private pendingResponses = new Map<string, (message: HttpResponseMessage) => void>()

  constructor(ctx: DurableObjectState, env: EdgeBindings) {
    super(ctx, env)
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private dispatchKey(generation: number) {
    return `dispatch:${generation}`
  }

  private getRoutingStub() {
    return this.env.ROUTING_DIRECTORY.get(this.env.ROUTING_DIRECTORY.idFromName('global'))
  }

  private getHostSocket() {
    return this.ctx.getWebSockets('host')[0]
  }

  private getClientSocket(streamId: string) {
    return this.ctx.getWebSockets(streamId)[0]
  }

  private readMessage(message: string | ArrayBuffer) {
    return typeof message === 'string' ? message : decoder.decode(message)
  }

  private getSocketRole(ws: WebSocket) {
    return ws.deserializeAttachment() as ConnectionRole | null
  }

  private async ensureActiveSession(expectedSessionId: string, expectedVersion: number) {
    const session = await this.ctx.storage.get<HostSessionRecord>('session')
    if (
      !session ||
      session.disconnectedAt !== null ||
      session.sessionId !== expectedSessionId ||
      session.version !== expectedVersion
    ) {
      return null
    }
    return session
  }

  private async relayHttpRequest(payload: RelayHttpRequest) {
    const session = await this.ensureActiveSession(payload.expectedSessionId, payload.expectedVersion)
    if (!session) {
      return Response.json({ ok: false, reason: 'stale_session_binding' }, { status: 409 })
    }

    const socket = this.getHostSocket()
    if (!socket) {
      return Response.json({ ok: false, reason: 'host_not_connected' }, { status: 503 })
    }

    const responseMessage = await new Promise<HttpResponseMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(payload.request.payload.streamId)
        reject(new Error('relay_timeout'))
      }, 5_000)

      this.pendingResponses.set(payload.request.payload.streamId, (message) => {
        clearTimeout(timeout)
        resolve(message)
      })

      socket.send(JSON.stringify(payload.request))
    })

    return new Response(responseMessage.payload.body, {
      status: responseMessage.payload.status,
      headers: responseMessage.payload.headers,
    })
  }

  private async relayWebSocket(request: Request, payload: RelayWebSocketRequest) {
    const session = await this.ensureActiveSession(payload.expectedSessionId, payload.expectedVersion)
    if (!session) {
      return Response.json({ ok: false, reason: 'stale_session_binding' }, { status: 409 })
    }

    const hostSocket = this.getHostSocket()
    if (!hostSocket) {
      return Response.json({ ok: false, reason: 'host_not_connected' }, { status: 503 })
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 })
    }

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    this.ctx.acceptWebSocket(server, [payload.request.payload.streamId])
    server.serializeAttachment({ type: 'client', streamId: payload.request.payload.streamId } satisfies ConnectionRole)
    hostSocket.send(JSON.stringify(payload.request))
    return new Response(null, { status: 101, webSocket: client })
  }

  private async handleReconcileAck(message: ReconcileAckMessage) {
    const dispatch = await this.ctx.storage.get<ConfigDispatchMessage>(this.dispatchKey(message.payload.generation))
    if (!dispatch || dispatch.payload.hostId !== message.payload.hostId) {
      return
    }

    const services = dispatch.payload.desired.services
    const routing = this.getRoutingStub()

    if (message.payload.status === 'error') {
      await routing.fetch(
        new Request(`https://routing.internal/control/hosts/${encodeURIComponent(message.payload.hostId)}/current`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            generation: message.payload.generation,
            status: 'error',
            services,
            error: message.payload.error,
          }),
        }),
      )
      return
    }

    await routing.fetch(
      new Request(`https://routing.internal/control/hosts/${encodeURIComponent(message.payload.hostId)}/current`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          generation: message.payload.generation,
          status: 'acknowledged',
          services,
        }),
      }),
    )

    if (message.payload.status === 'applied') {
      await routing.fetch(
        new Request(`https://routing.internal/control/hosts/${encodeURIComponent(message.payload.hostId)}/applied`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            generation: message.payload.generation,
            services,
          }),
        }),
      )
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.headers.get('Upgrade') === 'websocket' && url.pathname === '/connect') {
      for (const existing of this.ctx.getWebSockets('host')) {
        existing.close(1012, 'replaced_host_socket')
      }

      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      this.ctx.acceptWebSocket(server, ['host'])
      server.serializeAttachment({ type: 'host' } satisfies ConnectionRole)
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

    if (request.method === 'POST' && url.pathname === '/control/dispatch') {
      const message = configDispatchMessageSchema.parse(await request.json())
      await this.ctx.storage.put(this.dispatchKey(message.payload.generation), message)
      this.getHostSocket()?.send(JSON.stringify(message))
      return Response.json({ ok: true })
    }

    if (request.method === 'POST' && url.pathname === '/relay-http') {
      return this.relayHttpRequest((await request.json()) as RelayHttpRequest)
    }

    if (request.method === 'GET' && url.pathname === '/relay-ws') {
      const relayHeader = request.headers.get('x-utunnel-relay-payload')
      if (!relayHeader) {
        return Response.json({ ok: false, reason: 'missing_relay_payload' }, { status: 400 })
      }
      return this.relayWebSocket(request, JSON.parse(relayHeader) as RelayWebSocketRequest)
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
    const text = this.readMessage(message)
    if (text === 'ping' || text === 'pong') {
      return
    }

    const role = this.getSocketRole(ws)
    if (!role) {
      return
    }

    if (role.type === 'host') {
      let heartbeat: { payload: { hostId: string; sessionId: string; timestamp: string } } | null = null
      try {
        heartbeat = heartbeatMessageSchema.parse(JSON.parse(text))
      } catch {}

      if (heartbeat) {
        const session = await this.ctx.storage.get<HostSessionRecord>('session')
        if (
          session &&
          session.hostId === heartbeat.payload.hostId &&
          session.sessionId === heartbeat.payload.sessionId &&
          session.disconnectedAt === null
        ) {
          await this.ctx.storage.put('session', markSessionHeartbeat(session, Date.parse(heartbeat.payload.timestamp)))
        }
        return
      }

      let reconcileAck: ReconcileAckMessage | null = null
      try {
        reconcileAck = reconcileAckMessageSchema.parse(JSON.parse(text))
      } catch {}

      if (reconcileAck) {
        await this.handleReconcileAck(reconcileAck)
        return
      }

      let httpParsed: HttpResponseMessage | null = null
      try {
        httpParsed = responseEnvelopeSchema.parse(JSON.parse(text))
      } catch {}

      if (httpParsed) {
        const resolve = this.pendingResponses.get(httpParsed.payload.streamId)
        if (!resolve) {
          return
        }

        this.pendingResponses.delete(httpParsed.payload.streamId)
        resolve(httpParsed)
        return
      }

      let wsFrame: WebSocketFrameMessage | null = null
      try {
        wsFrame = websocketFrameSchema.parse(JSON.parse(text))
      } catch {}

      if (wsFrame) {
        this.getClientSocket(wsFrame.payload.streamId)?.send(wsFrame.payload.data)
        return
      }

      let wsClose: WebSocketCloseMessage | null = null
      try {
        wsClose = websocketCloseSchema.parse(JSON.parse(text))
      } catch {}

      if (wsClose) {
        this.getClientSocket(wsClose.payload.streamId)?.close(wsClose.payload.code, wsClose.payload.reason)
      }

      return
    }

    const frameMessage: WebSocketFrameMessage = {
      type: 'ws_frame',
      payload: {
        streamId: role.streamId,
        data: text,
      },
    }
    this.getHostSocket()?.send(JSON.stringify(frameMessage))
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    const role = this.getSocketRole(ws)
    if (!role) {
      return
    }

    if (role.type === 'client') {
      const closeMessage: WebSocketCloseMessage = {
        type: 'ws_close',
        payload: {
          streamId: role.streamId,
          code,
          reason,
        },
      }
      this.getHostSocket()?.send(JSON.stringify(closeMessage))
      return
    }

    for (const client of this.ctx.getWebSockets()) {
      const clientRole = client.deserializeAttachment() as ConnectionRole | null
      if (clientRole?.type === 'client') {
        client.close(1011, 'host_socket_closed')
      }
    }
  }
}

export default {
  async fetch(request: Request, env: EdgeBindings, executionCtx: ExecutionContext) {
    return handleEdgeFetch(request, env, executionCtx)
  },
}
