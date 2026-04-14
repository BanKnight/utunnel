import { z } from 'zod'
import { serviceDefinitionSchema } from '@utunnel/protocol'

export const edgeEnvSchema = z.object({
  ROOT_DOMAIN: z.string().min(1),
  OPERATOR_TOKEN: z.string().min(1),
  STALE_ROUTE_GRACE_MS: z.coerce.number().int().positive().default(30000),
  HEARTBEAT_GRACE_MS: z.coerce.number().int().positive().default(15000),
  UI_PASSWORD: z.string().min(1).optional(),
  SESSION_SECRET: z.string().min(1).optional(),
  SESSION_TTL_MS: z.coerce.number().int().positive().optional(),
  REACHABILITY_ANALYTICS_ACCOUNT_ID: z.string().min(1).optional(),
  REACHABILITY_ANALYTICS_API_TOKEN: z.string().min(1).optional(),
  REACHABILITY_ANALYTICS_DATASET: z.string().min(1).optional(),
})

export const agentConfigSchema = z
  .object({
    hostId: z.string().min(1),
    hostname: z.string().min(1),
    token: z.string().min(1).optional(),
    bootstrapToken: z.string().min(1).optional(),
    edgeBaseUrl: z.string().url(),
    reconnectDelayMs: z.number().int().positive().default(3000),
    maxReconnectAttempts: z.number().int().positive().default(5),
    services: z.array(serviceDefinitionSchema).default([]),
  })
  .refine((value) => Boolean(value.token ?? value.bootstrapToken), {
    message: 'token_or_bootstrap_token_required',
    path: ['token'],
  })

export type EdgeEnvConfig = z.infer<typeof edgeEnvSchema>
export type AgentConfig = z.infer<typeof agentConfigSchema>

export const parseAgentConfig = (input: unknown): AgentConfig => {
  return agentConfigSchema.parse(input)
}

export const parseEdgeEnv = (input: unknown): EdgeEnvConfig => {
  return edgeEnvSchema.parse(input)
}
