import { describe, expect, test } from 'bun:test'
import tailWorker, { extractObservations, parseObservation } from './index'

describe('edge tail worker', () => {
  test('parses reachability observation logs', () => {
    const parsed = parseObservation(
      JSON.stringify({
        kind: 'utunnel_reachability_observation',
        hostId: 'host-1',
        serviceId: 'svc-1',
        hostname: 'svc.example.test',
        method: 'GET',
        path: '/health',
        checkedAt: 123,
        success: false,
        statusCode: 503,
        latencyMs: 42,
        failureKind: 'status-code',
      }),
    )

    expect(parsed).toEqual({
      kind: 'utunnel_reachability_observation',
      hostId: 'host-1',
      serviceId: 'svc-1',
      hostname: 'svc.example.test',
      method: 'GET',
      path: '/health',
      checkedAt: 123,
      success: false,
      statusCode: 503,
      latencyMs: 42,
      failureKind: 'status-code',
    })
  })

  test('extracts only utunnel reachability observations from tail events', () => {
    const observations = extractObservations({
      outcome: 'ok',
      logs: [
        {
          message: [
            'plain log line',
            JSON.stringify({
              kind: 'utunnel_reachability_observation',
              hostId: 'host-1',
              serviceId: 'svc-1',
              hostname: 'svc.example.test',
              method: 'GET',
              path: '/health',
              checkedAt: 123,
              success: true,
              statusCode: 200,
              latencyMs: 12,
            }),
          ],
        },
      ],
    })

    expect(observations).toHaveLength(1)
    expect(observations[0]?.serviceId).toBe('svc-1')
  })

  test('writes analytics datapoints for parsed observations', async () => {
    const writes: Array<{ blobs?: string[]; doubles?: number[]; indexes?: string[] }> = []

    await tailWorker.tail(
      [
        {
          outcome: 'ok',
          logs: [
            {
              message: [
                JSON.stringify({
                  kind: 'utunnel_reachability_observation',
                  hostId: 'host-1',
                  serviceId: 'svc-1',
                  hostname: 'svc.example.test',
                  method: 'GET',
                  path: '/health',
                  checkedAt: 123,
                  success: true,
                  statusCode: 200,
                  latencyMs: 12,
                }),
              ],
            },
          ],
        },
      ],
      {
        REACHABILITY_ANALYTICS: {
          writeDataPoint(data) {
            writes.push(data)
          },
        },
      },
    )

    expect(writes).toHaveLength(1)
    expect(writes[0]?.indexes).toEqual(['svc-1'])
    expect(writes[0]?.blobs?.slice(0, 4)).toEqual(['host-1', 'svc.example.test', 'GET', '/health'])
    expect(writes[0]?.doubles).toEqual([200, 12, 123])
  })
})
