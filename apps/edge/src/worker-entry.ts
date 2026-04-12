import { app, handleTunnelRequest } from './app'
import type { EdgeBindings } from './types'

type ExecutionContextLike = {
  waitUntil?: (promise: Promise<unknown>) => void
  passThroughOnException?: () => void
}

export const handleEdgeFetch = async (
  request: Request,
  env: EdgeBindings,
  executionCtx?: ExecutionContextLike,
) => {
  const url = new URL(request.url)
  if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket' && url.pathname.startsWith('/tunnel/')) {
    return handleTunnelRequest(request, env)
  }

  const response = await app.fetch(request, env, executionCtx as ExecutionContext)
  const isBrowserRoute =
    request.method === 'GET' &&
    !url.pathname.startsWith('/api/') &&
    !url.pathname.startsWith('/trpc') &&
    !url.pathname.startsWith('/tunnel/') &&
    url.pathname !== '/connect'

  if (env.ASSETS && isBrowserRoute) {
    const assetPath = url.pathname === '/' || !url.pathname.includes('.') ? '/index.html' : url.pathname
    return env.ASSETS.fetch(new Request(new URL(assetPath, request.url), request))
  }

  return response
}
