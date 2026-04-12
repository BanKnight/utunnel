import { createTRPCProxyClient, httpBatchLink } from '@trpc/client'
import type { AppRouter } from '../../../edge/src/trpc'

export const trpcClient = createTRPCProxyClient<AppRouter>({
  links: [
    httpBatchLink({
      url: '/trpc',
      fetch(url, options) {
        const init: RequestInit = {
          credentials: 'include',
        }

        if (options?.method) {
          init.method = options.method
        }
        if (options?.headers) {
          init.headers = options.headers
        }
        if (options && 'body' in options) {
          init.body = options.body ?? null
        }
        if (options?.signal) {
          init.signal = options.signal
        }

        return fetch(url, init)
      },
    }),
  ],
})
