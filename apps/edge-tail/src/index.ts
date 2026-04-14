type AnalyticsEngineDatasetLike = {
  writeDataPoint(data: {
    blobs?: string[]
    doubles?: number[]
    indexes?: string[]
  }): void
}

type ReachabilityObservation = {
  kind: 'utunnel_reachability_observation'
  hostId: string
  serviceId: string
  hostname: string
  method: string
  path: string
  checkedAt: number
  success: boolean
  statusCode?: number | undefined
  latencyMs?: number | undefined
  failureKind?: 'status-code' | 'edge' | undefined
}

type TailLogLine = {
  message?: unknown[]
}

type TailEvent = {
  outcome?: string
  logs?: TailLogLine[]
}

interface Env {
  REACHABILITY_ANALYTICS: AnalyticsEngineDatasetLike
}

export const parseObservation = (value: unknown): ReachabilityObservation | null => {
  if (typeof value !== 'string') {
    return null
  }

  try {
    const parsed = JSON.parse(value) as Partial<ReachabilityObservation>
    if (
      parsed.kind !== 'utunnel_reachability_observation' ||
      typeof parsed.hostId !== 'string' ||
      typeof parsed.serviceId !== 'string' ||
      typeof parsed.hostname !== 'string' ||
      typeof parsed.method !== 'string' ||
      typeof parsed.path !== 'string' ||
      typeof parsed.checkedAt !== 'number' ||
      typeof parsed.success !== 'boolean'
    ) {
      return null
    }

    return {
      kind: parsed.kind,
      hostId: parsed.hostId,
      serviceId: parsed.serviceId,
      hostname: parsed.hostname,
      method: parsed.method,
      path: parsed.path,
      checkedAt: parsed.checkedAt,
      success: parsed.success,
      statusCode: typeof parsed.statusCode === 'number' ? parsed.statusCode : undefined,
      latencyMs: typeof parsed.latencyMs === 'number' ? parsed.latencyMs : undefined,
      failureKind:
        parsed.failureKind === 'status-code' || parsed.failureKind === 'edge' ? parsed.failureKind : undefined,
    }
  } catch {
    return null
  }
}

export const extractObservations = (event: TailEvent) => {
  return (event.logs ?? [])
    .flatMap((line) => line.message ?? [])
    .map((entry) => parseObservation(entry))
    .filter((entry): entry is ReachabilityObservation => entry !== null)
}

const tailWorker = {
  async tail(events: TailEvent[], env: Env) {
    for (const event of events) {
      const observations = extractObservations(event)
      for (const observation of observations) {
        env.REACHABILITY_ANALYTICS.writeDataPoint({
          indexes: [observation.serviceId],
          blobs: [
            observation.hostId,
            observation.hostname,
            observation.method,
            observation.path,
            observation.success ? 'ok' : 'fail',
            observation.failureKind ?? 'none',
            event.outcome ?? 'unknown',
          ],
          doubles: [observation.statusCode ?? 0, observation.latencyMs ?? 0, observation.checkedAt],
        })
      }
    }
  },
}

export default tailWorker
