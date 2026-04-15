# utunnel

## Repo basics

- This repo is a Bun monorepo.
- Main apps:
  - `apps/edge` — Cloudflare edge worker
  - `apps/agent` — Bun host agent
  - `apps/web` — v2 control shell UI for browser login, dashboard, host management, and desired-state editing
  - `apps/edge-tail` — local/dev tail consumer for edge observability workflows when enabled
- Shared packages:
  - `packages/protocol`
  - `packages/config`
  - `packages/testkit`
- Keep `.claude/` local only. Do not commit it.

## Commands

- `bun run demo:v1` — alias of the repo-runnable v1 smoke flow
- `bun run smoke:v1` — boot local edge + demo agents and verify 3-host HTTP/WebSocket routing
- `bun run smoke:v2` — boot local v2 control-plane flow and verify login/bootstrap/import/desired/apply/HTTP/WS end to end
- `bun run typecheck`
- `bun run test`
- `bun run check`

## Architecture

- `apps/edge/src/app.ts`
  - Hono ingress and control API
  - public `/tunnel/*` routing logic lives here
  - operator health endpoint lives here: `GET /api/hosts/:hostId/health`
  - local dev ingress overrides are resolved here via `x-utunnel-route-host`, query `__utunnel_host`, or `/tunnel/__utunnel_host/:hostname/...`
- `apps/edge/src/index.ts`
  - Cloudflare Durable Objects runtime glue
  - `RoutingDirectory` owns hostname bindings
  - `HostSession` owns live host session state and relay behavior
  - top-level fetch handles `/tunnel/*` websocket upgrades before Hono routing when needed by local dev / wrangler
  - host heartbeat updates are persisted here
- `apps/edge/src/control-shell.ts`
  - browser session login/logout and dashboard summary shaping for the v2 UI
- `apps/edge/src/trpc.ts`
  - session-protected control-shell API for hosts, bootstrap, tokens, and desired-state mutations
- `apps/agent/src/index.ts`
  - host registration
  - reconnect/rebind flow
  - structured heartbeat sender
  - HTTP relay
  - WebSocket relay with frame queueing until upstream socket open
- `apps/web/src/router.tsx`
  - v2 control shell routes, host cards, desired/current/applied display, desired service editor, and per-host static import UI
- `packages/protocol/src/index.ts`
  - shared schemas and tunnel message types
  - host session heartbeat schema lives here
- `packages/testkit/src/index.ts`
  - demo config generation and local smoke helpers
- `packages/testkit/src/v1-smoke.ts`
  - repo-runnable multi-host v1 smoke orchestration

## Project invariants

- Service routing is per-subdomain.
- HTTP and WebSocket relay both use the same session/version model.
- Forwarding must fail closed when the route binding session/version does not match the active host session.
- Reject unsafe relay paths.
- Strip forwarded/proxy-style headers before relaying upstream.
- Preserve hostname across reconnect/rebind for the same host/service identity.
- Agent heartbeat updates `lastHeartbeatAt`, and host health is derived using `HEARTBEAT_GRACE_MS`.
- Local dev tunnel access may use override host resolution, but override-only headers/query state must never leak upstream.
- WebSocket frames must not be sent to the upstream socket before that socket is open.
- Do not expand `apps/web` into a required v1 surface.

## Change guidelines

- If tunnel message shapes change, update `packages/protocol` first.
- Keep `apps/edge/src/app.ts` Bun-testable.
- Keep Cloudflare-specific Durable Object behavior in `apps/edge/src/index.ts`.
- When changing relay behavior, update tests together with code:
  - `apps/edge/src/index.test.ts`
  - `apps/agent/src/runtime.test.ts`
- When changing local dev ingress override or websocket tunnel behavior, update `apps/edge/src/app.ts`, `apps/edge/src/index.ts`, and `apps/edge/src/index.test.ts` together.
- When changing repo-runnable demo/smoke behavior, update `packages/testkit/src/index.ts`, `packages/testkit/src/v1-smoke.ts`, and root `package.json` scripts together.
- Before concluding work, run:
  - `bun run typecheck`
  - `bun run test`
  - `bun run smoke:v1` for edge/agent/testkit changes that affect v1 routing, health, websocket relay, or startup flow
  - `bun run smoke:v2` for v2 control-shell, bootstrap, desired-state editing/import, token lifecycle, or control-plane convergence changes
