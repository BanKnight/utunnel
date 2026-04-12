export type FetchStub = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export type NamespaceLike<T extends FetchStub> = {
  idFromName(name: string): string
  get(id: string): T
}

export type EdgeBindings = {
  ROOT_DOMAIN: string
  OPERATOR_TOKEN: string
  STALE_ROUTE_GRACE_MS: string
  HEARTBEAT_GRACE_MS: string
  UI_PASSWORD?: string
  SESSION_SECRET?: string
  SESSION_TTL_MS?: string
  ASSETS?: FetchStub
  ROUTING_DIRECTORY: NamespaceLike<FetchStub>
  HOST_SESSION: NamespaceLike<FetchStub>
}

export type HonoEnv = {
  Bindings: EdgeBindings
}
