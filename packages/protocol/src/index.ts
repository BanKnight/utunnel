import { z } from 'zod'

export const hostTokenSchema = z.object({
  token: z.string().min(1),
})

export const hostIdentitySchema = z.object({
  hostId: z.string().min(1),
  hostname: z.string().min(1),
})

export const serviceProtocolSchema = z.enum(['http', 'websocket'])

export const serviceDefinitionSchema = z.object({
  serviceId: z.string().min(1),
  serviceName: z.string().min(1),
  localUrl: z.string().url(),
  protocol: serviceProtocolSchema,
  subdomain: z.string().min(1),
})

export const serviceBindingPayloadSchema = z.object({
  sessionId: z.string().min(1),
  version: z.number().int().positive(),
  services: z.array(serviceDefinitionSchema).min(1),
})

export const hostSessionRecordSchema = z.object({
  hostId: z.string().min(1),
  sessionId: z.string().min(1),
  version: z.number().int().positive(),
  services: z.array(serviceDefinitionSchema),
  connectedAt: z.number().int().nonnegative(),
  lastHeartbeatAt: z.number().int().nonnegative(),
  disconnectedAt: z.number().int().nonnegative().nullable().default(null),
})

export const desiredHostConfigSchema = z.object({
  hostId: z.string().min(1),
  generation: z.number().int().positive(),
  services: z.array(serviceDefinitionSchema),
  updatedAt: z.number().int().nonnegative(),
})

export const currentHostConfigSchema = z.object({
  hostId: z.string().min(1),
  generation: z.number().int().positive(),
  status: z.enum(['pending', 'acknowledged', 'error']),
  reportedAt: z.number().int().nonnegative(),
  services: z.array(serviceDefinitionSchema),
  error: z.string().min(1).optional(),
})

export const appliedHostConfigSchema = z.object({
  hostId: z.string().min(1),
  generation: z.number().int().positive(),
  appliedAt: z.number().int().nonnegative(),
  services: z.array(serviceDefinitionSchema),
})

export const bootstrapClaimMessageSchema = z.object({
  type: z.literal('bootstrap_claim'),
  payload: hostIdentitySchema.extend({
    bootstrapToken: z.string().min(1),
  }),
})

export const configDispatchMessageSchema = z.object({
  type: z.literal('config_dispatch'),
  payload: z.object({
    hostId: z.string().min(1),
    generation: z.number().int().positive(),
    desired: desiredHostConfigSchema,
    dispatchedAt: z.number().int().nonnegative(),
    idempotencyKey: z.string().min(1),
  }),
})

export const configDispatchStatusBaseSchema = z.object({
  generation: z.number().int().positive(),
  status: z.enum(['acknowledged', 'applied', 'error']),
  acknowledgedAt: z.number().int().nonnegative(),
  error: z.string().min(1).optional(),
})

export const configDispatchStatusSchema = configDispatchStatusBaseSchema.refine(
  (value) => value.status !== 'error' || Boolean(value.error),
  {
    message: 'error_reason_required',
    path: ['error'],
  },
)

export const reconcileAckMessageSchema = z.object({
  type: z.literal('reconcile_ack'),
  payload: configDispatchStatusBaseSchema.extend({
    hostId: z.string().min(1),
  }).refine((value) => value.status !== 'error' || Boolean(value.error), {
    message: 'error_reason_required',
    path: ['error'],
  }),
})


export const registerHostMessageSchema = z.object({
  type: z.literal('register_host'),
  payload: hostIdentitySchema.extend({
    token: z.string().min(1),
  }),
})

export const registerServicesMessageSchema = z.object({
  type: z.literal('register_services'),
  payload: z.object({
    hostId: z.string().min(1),
    sessionId: z.string().min(1),
    version: z.number().int().positive(),
    services: z.array(serviceDefinitionSchema).min(1),
  }),
})

export const heartbeatMessageSchema = z.object({
  type: z.literal('heartbeat'),
  payload: z.object({
    hostId: z.string().min(1),
    sessionId: z.string().min(1),
    timestamp: z.string().datetime(),
  }),
})

export const requestEnvelopeSchema = z.object({
  type: z.literal('http_request'),
  payload: z.object({
    streamId: z.string().min(1),
    serviceId: z.string().min(1),
    method: z.string().min(1),
    path: z.string().min(1),
    headers: z.record(z.string()),
    body: z.string().default(''),
  }),
})

export const responseEnvelopeSchema = z.object({
  type: z.literal('http_response'),
  payload: z.object({
    streamId: z.string().min(1),
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string()),
    body: z.string().default(''),
  }),
})

export const websocketOpenSchema = z.object({
  type: z.literal('ws_open'),
  payload: z.object({
    streamId: z.string().min(1),
    serviceId: z.string().min(1),
    path: z.string().min(1),
    headers: z.record(z.string()),
  }),
})

export const websocketFrameSchema = z.object({
  type: z.literal('ws_frame'),
  payload: z.object({
    streamId: z.string().min(1),
    data: z.string(),
  }),
})

export const websocketCloseSchema = z.object({
  type: z.literal('ws_close'),
  payload: z.object({
    streamId: z.string().min(1),
    code: z.number().int().optional(),
    reason: z.string().optional(),
  }),
})

export const rebindServicesMessageSchema = z.object({
  type: z.literal('rebind_services'),
  payload: z.object({
    hostId: z.string().min(1),
    previousSessionId: z.string().min(1).optional(),
    nextSessionId: z.string().min(1),
    version: z.number().int().positive(),
    services: z.array(serviceDefinitionSchema).min(1),
  }),
})

export const tunnelMessageSchema = z.discriminatedUnion('type', [
  registerHostMessageSchema,
  registerServicesMessageSchema,
  heartbeatMessageSchema,
  requestEnvelopeSchema,
  responseEnvelopeSchema,
  websocketOpenSchema,
  websocketFrameSchema,
  websocketCloseSchema,
  rebindServicesMessageSchema,
])

export const controlPlaneMessageSchema = z.discriminatedUnion('type', [
  bootstrapClaimMessageSchema,
  configDispatchMessageSchema,
  reconcileAckMessageSchema,
])

export type HostIdentity = z.infer<typeof hostIdentitySchema>
export type ServiceDefinition = z.infer<typeof serviceDefinitionSchema>
export type ServiceBindingPayload = z.infer<typeof serviceBindingPayloadSchema>
export type HostSessionRecord = z.infer<typeof hostSessionRecordSchema>
export type DesiredHostConfig = z.infer<typeof desiredHostConfigSchema>
export type CurrentHostConfig = z.infer<typeof currentHostConfigSchema>
export type AppliedHostConfig = z.infer<typeof appliedHostConfigSchema>
export type ConfigDispatchStatus = z.infer<typeof configDispatchStatusSchema>
export type HttpRequestMessage = z.infer<typeof requestEnvelopeSchema>
export type HttpResponseMessage = z.infer<typeof responseEnvelopeSchema>
export type WebSocketOpenMessage = z.infer<typeof websocketOpenSchema>
export type WebSocketFrameMessage = z.infer<typeof websocketFrameSchema>
export type WebSocketCloseMessage = z.infer<typeof websocketCloseSchema>
export type TunnelMessage = z.infer<typeof tunnelMessageSchema>
export type ControlPlaneMessage = z.infer<typeof controlPlaneMessageSchema>

export type RoutingEntry = {
  hostname: string
  hostId: string
  serviceId: string
  sessionId: string
  version: number
  updatedAt: number
}

export type SessionBinding = {
  hostId: string
  sessionId: string
  version: number
}
