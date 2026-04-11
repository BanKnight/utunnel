# utunnel

## Repo basics

- This repo is a Bun monorepo.
- Main apps:
  - `apps/edge` — Cloudflare edge worker
  - `apps/agent` — Bun host agent
  - `apps/web` — reserved only, not part of v1 delivery
- Shared packages:
  - `packages/protocol`
  - `packages/config`
  - `packages/testkit`
- Keep `.claude/` local only. Do not commit it.

## Commands

- `bun run typecheck`
- `bun run test`
- `bun run check`

## Architecture

- `apps/edge/src/app.ts`
  - Hono ingress and control API
  - public `/tunnel/*` routing logic lives here
- `apps/edge/src/index.ts`
  - Cloudflare Durable Objects runtime glue
  - `RoutingDirectory` owns hostname bindings
  - `HostSession` owns live host session state and relay behavior
- `apps/agent/src/index.ts`
  - host registration
  - reconnect/rebind flow
  - HTTP relay
  - minimal WebSocket relay
- `packages/protocol/src/index.ts`
  - shared schemas and tunnel message types

## Project invariants

- Service routing is per-subdomain.
- HTTP and WebSocket relay both use the same session/version model.
- Forwarding must fail closed when the route binding session/version does not match the active host session.
- Reject unsafe relay paths.
- Strip forwarded/proxy-style headers before relaying upstream.
- Preserve hostname across reconnect/rebind for the same host/service identity.
- Do not expand `apps/web` into a required v1 surface.

## Change guidelines

- If tunnel message shapes change, update `packages/protocol` first.
- Keep `apps/edge/src/app.ts` Bun-testable.
- Keep Cloudflare-specific Durable Object behavior in `apps/edge/src/index.ts`.
- When changing relay behavior, update tests together with code:
  - `apps/edge/src/index.test.ts`
  - `apps/agent/src/runtime.test.ts`
- Before concluding work, run:
  - `bun run typecheck`
  - `bun run test`
