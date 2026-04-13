import { initTRPC, TRPCError } from '@trpc/server'
import { serviceDefinitionSchema } from '@utunnel/protocol'
import { z } from 'zod'
import {
  getAuthenticatedControlShellUser,
  loginControlShell,
  logoutControlShell,
  summarizeDashboard,
} from './control-shell'
import {
  applyDesiredHostServices,
  createControlApiToken,
  listControlApiTokens,
  listControlPlaneHosts,
  listServiceReachabilitySummaries,
  issueHostBootstrap,
  revokeControlApiToken,
  rotateControlApiToken,
} from './control-plane'
import type { EdgeBindings } from './types'

export type TrpcContext = {
  env: EdgeBindings
  req: Request
  setHeader: (name: string, value: string) => void
}

const t = initTRPC.context<TrpcContext>().create()

const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  const user = await getAuthenticatedControlShellUser(ctx.req, ctx.env)
  if (!user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid_session' })
  }

  return next({
    ctx: {
      ...ctx,
      user,
    },
  })
})

export const appRouter = t.router({
  auth: t.router({
    login: t.procedure
      .input(
        z.object({
          password: z.string().min(1),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await loginControlShell(ctx.env, input.password)
        if (!result.ok) {
          if (result.reason === 'control_shell_not_configured') {
            throw new TRPCError({ code: 'NOT_FOUND', message: result.reason })
          }
          throw new TRPCError({ code: 'UNAUTHORIZED', message: result.reason })
        }

        ctx.setHeader('set-cookie', result.setCookie)
        return { ok: true, user: result.user }
      }),
    me: protectedProcedure.query(({ ctx }) => {
      return { ok: true, user: ctx.user }
    }),
    logout: t.procedure.mutation(({ ctx }) => {
      const result = logoutControlShell(ctx.env)
      if (!result.ok) {
        throw new TRPCError({ code: 'NOT_FOUND', message: result.reason })
      }

      ctx.setHeader('set-cookie', result.setCookie)
      return { ok: true }
    }),
  }),
  dashboard: t.router({
    summary: protectedProcedure.query(async ({ ctx }) => {
      return summarizeDashboard(ctx.env)
    }),
  }),
  hosts: t.router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return listControlPlaneHosts(ctx.env)
    }),
    issueBootstrap: protectedProcedure
      .input(
        z.object({
          hostId: z.string().min(1),
          hostname: z.string().min(1),
          edgeBaseUrl: z.string().url(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await issueHostBootstrap(ctx.env, input)
        if (!result.ok) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: result.reason })
        }
        return result.value
      }),
    upsertDesired: protectedProcedure
      .input(
        z.object({
          hostId: z.string().min(1),
          services: z.array(serviceDefinitionSchema),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await applyDesiredHostServices(ctx.env, input.hostId, input.services)
        if (!result.ok) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: result.reason })
        }
        return result.value
      }),
    importStaticConfig: protectedProcedure
      .input(
        z.object({
          hostId: z.string().min(1),
          services: z.array(serviceDefinitionSchema),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const result = await applyDesiredHostServices(ctx.env, input.hostId, input.services)
        if (!result.ok) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: result.reason })
        }
        return result.value
      }),
  }),
  services: t.router({
    reachability: protectedProcedure.query(async ({ ctx }) => {
      return listServiceReachabilitySummaries(ctx.env)
    }),
  }),
  tokens: t.router({
    list: protectedProcedure.query(async ({ ctx }) => {
      return listControlApiTokens(ctx.env)
    }),
    create: protectedProcedure
      .input(z.object({ label: z.string().min(1).optional() }))
      .mutation(async ({ ctx, input }) => {
        const createInput = input.label ? { label: input.label } : {}
        const result = await createControlApiToken(ctx.env, createInput)
        if (!result.ok) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: result.reason })
        }
        return result.value
      }),
    rotate: protectedProcedure
      .input(z.object({ tokenId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const result = await rotateControlApiToken(ctx.env, input.tokenId)
        if (!result.ok) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: result.reason })
        }
        return result.value
      }),
    revoke: protectedProcedure
      .input(z.object({ tokenId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const result = await revokeControlApiToken(ctx.env, input.tokenId)
        if (!result.ok) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: result.reason })
        }
        return result.value
      }),
  }),
})

export type AppRouter = typeof appRouter
