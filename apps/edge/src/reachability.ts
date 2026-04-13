import type { ServiceProbeRecord, ServiceReachability } from '@utunnel/protocol'

export const deriveServiceReachability = (recentResults: ServiceProbeRecord[]): ServiceReachability => {
  if (recentResults.length === 0) {
    return 'unknown'
  }

  const recentWindow = recentResults.slice(0, 3)
  const successes = recentWindow.filter((result) => result.success).length
  const failures = recentWindow.length - successes

  if (successes === 0) {
    return 'unreachable'
  }
  if (failures === 0 && recentWindow[0]?.success) {
    return 'reachable'
  }
  if (recentWindow[0]?.success) {
    return 'reachable'
  }
  return 'degraded'
}
