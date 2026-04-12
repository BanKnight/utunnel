import { describe, expect, test } from 'bun:test'
import {
  buildHostSessionRecord,
  buildHostToken,
  buildRoutingEntry,
  extractBearerToken,
  extractHostnameFromRequest,
  hasHostnameConflict,
  isHostAuthorized,
  isLocalDevHostname,
  isHostnameInRootDomain,
  isOperatorAuthorized,
  isSessionHealthy,
  markSessionDisconnected,
  markSessionHeartbeat,
  normalizeHostname,
  normalizeServiceDefinitions,
  shouldCleanupStaleRoute,
} from './lib'

const payload = {
  sessionId: 'session-1',
  version: 1,
  services: [
    {
      serviceId: 'svc-1',
      serviceName: 'echo',
      localUrl: 'http://127.0.0.1:3001',
      protocol: 'http' as const,
      subdomain: 'Echo.Example.test:443',
    },
  ],
}

describe('edge lifecycle helpers', () => {
  test('builds a routing entry with normalized hostname', () => {
    const entry = buildRoutingEntry('host-1', payload, payload.services[0]!, 123)
    expect(entry.hostname).toBe('echo.example.test')
    expect(entry.updatedAt).toBe(123)
  })

  test('marks a session disconnected and checks stale cleanup', () => {
    const session = buildHostSessionRecord('host-1', payload, 100)
    const disconnected = markSessionDisconnected(session, 150)

    expect(shouldCleanupStaleRoute(disconnected, 100, 200)).toBe(false)
    expect(shouldCleanupStaleRoute(disconnected, 100, 260)).toBe(true)
  })

  test('updates heartbeat timestamp and reports health within grace window', () => {
    const session = buildHostSessionRecord('host-1', payload, 100)
    const withHeartbeat = markSessionHeartbeat(session, 180)

    expect(withHeartbeat.lastHeartbeatAt).toBe(180)
    expect(isSessionHealthy(withHeartbeat, 50, 220)).toBe(true)
    expect(isSessionHealthy(withHeartbeat, 30, 220)).toBe(false)
  })

  test('detects local dev hostnames', () => {
    expect(isLocalDevHostname('127.0.0.1:8787')).toBe(true)
    expect(isLocalDevHostname('localhost:8787')).toBe(true)
    expect(isLocalDevHostname('echo.example.test')).toBe(false)
  })

  test('normalizes hostname and strips port', () => {
    expect(normalizeHostname('Echo.Example.test:443')).toBe('echo.example.test')
    expect(extractHostnameFromRequest('https://fallback.example.test/tunnel', 'Header.Example.test:8443')).toBe('header.example.test')
    expect(extractHostnameFromRequest('https://fallback.example.test/tunnel')).toBe('fallback.example.test')
  })

  test('checks root-domain membership', () => {
    expect(isHostnameInRootDomain('echo.example.test', 'example.test')).toBe(true)
    expect(isHostnameInRootDomain('example.test', 'example.test')).toBe(false)
    expect(isHostnameInRootDomain('echo.other.test', 'example.test')).toBe(false)
  })

  test('builds and verifies host/operator tokens', () => {
    const hostToken = buildHostToken('host-1', 'operator-secret')
    expect(extractBearerToken(`Bearer ${hostToken}`)).toBe(hostToken)
    expect(isHostAuthorized(hostToken, 'host-1', 'operator-secret')).toBe(true)
    expect(isHostAuthorized(hostToken, 'host-2', 'operator-secret')).toBe(false)
    expect(isOperatorAuthorized('operator-secret', 'operator-secret')).toBe(true)
  })

  test('normalizes service definitions and detects route conflicts', () => {
    const [service] = normalizeServiceDefinitions(payload.services)
    expect(service?.subdomain).toBe('echo.example.test')

    const current = buildRoutingEntry('host-1', payload, payload.services[0]!, 100)
    const sameOwner = buildRoutingEntry('host-1', payload, payload.services[0]!, 200)
    const otherOwner = {
      ...sameOwner,
      hostId: 'host-2',
    }

    expect(hasHostnameConflict(current, sameOwner)).toBe(false)
    expect(hasHostnameConflict(current, otherOwner)).toBe(true)
  })
})
