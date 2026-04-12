import { trpcServer } from '@hono/trpc-server'
import type { Hono } from 'hono'
import { appRouter } from './trpc'
import type { HonoEnv } from './types'

export const attachTrpc = (app: Hono<HonoEnv>) => {
  app.use(
    '/trpc/*',
    trpcServer({
      endpoint: '/trpc',
      router: appRouter,
      createContext: (opts, c) => {
        return {
          env: c.env,
          req: c.req.raw,
          setHeader: (name: string, value: string) => opts.resHeaders.append(name, value),
        }
      },
    }),
  )
}
