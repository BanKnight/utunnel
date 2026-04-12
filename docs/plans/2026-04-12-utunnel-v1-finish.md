# utunnel V1 Finish Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish utunnel v1 by adding a repo-runnable multi-host demo/smoke flow, protocol heartbeat + observable host health, and light bounded-concurrency proof.

**Architecture:** Keep the existing edge/agent split and Durable Object ownership model intact. Extend the current session record with heartbeat metadata, expose a minimal operator health view from the existing control API, add testkit-powered local smoke orchestration, and prove bounded concurrency with focused tests instead of a full load framework.

**Tech Stack:** Bun monorepo, Hono, Cloudflare Durable Objects, Bun test, workspace packages (`@utunnel/protocol`, `@utunnel/testkit`, `@utunnel/config`).

---

### Task 1: Add heartbeat metadata to the session model

**Files:**
- Modify: `packages/protocol/src/index.ts:27-60`
- Modify: `packages/protocol/src/index.test.ts:1-49`
- Modify: `apps/edge/src/lib.ts:70-101`
- Modify: `apps/edge/src/lib.test.ts:31-80`

**Step 1: Write the failing protocol and helper tests**

Add assertions that a host session record carries `lastHeartbeatAt`, and that health helpers can distinguish healthy vs stale sessions.

```ts
const result = hostSessionRecordSchema.parse({
  hostId: 'host-1',
  sessionId: 'session-1',
  version: 1,
  connectedAt: 100,
  lastHeartbeatAt: 100,
  disconnectedAt: null,
  services: [...],
})
expect(result.lastHeartbeatAt).toBe(100)
```

```ts
expect(isSessionHealthy(session, 30_000, 20_000)).toBe(true)
expect(isSessionHealthy(session, 30_000, 31_000)).toBe(false)
```

**Step 2: Run tests to verify they fail**

Run: `bun test packages/protocol/src/index.test.ts apps/edge/src/lib.test.ts`
Expected: FAIL because `lastHeartbeatAt` and health helper do not exist yet.

**Step 3: Write the minimal implementation**

- Extend `hostSessionRecordSchema` with `lastHeartbeatAt`
- Initialize it in `buildHostSessionRecord`
- Add a helper like `markSessionHeartbeat(session, now)`
- Add a helper like `isSessionHealthy(session, graceMs, now)`

**Step 4: Run tests to verify they pass**

Run: `bun test packages/protocol/src/index.test.ts apps/edge/src/lib.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/protocol/src/index.ts packages/protocol/src/index.test.ts apps/edge/src/lib.ts apps/edge/src/lib.test.ts
git commit -m "feat: track heartbeat metadata on host sessions"
```

### Task 2: Send heartbeat from the agent and persist it on the edge

**Files:**
- Modify: `apps/agent/src/index.ts:97-120,333-398`
- Modify: `apps/agent/src/runtime.test.ts:32-344`
- Modify: `apps/edge/src/index.ts:83-118,190-227,233-318`

**Step 1: Write the failing tests**

Add one agent-side test proving the heartbeat sender emits a protocol message instead of raw `ping`, and one edge-side test/helper-focused assertion proving a heartbeat updates session health state.

Representative agent expectation:

```ts
expect(JSON.parse(fakeSocket.sent[0]!)).toEqual({
  type: 'heartbeat',
  payload: {
    hostId: 'host-1',
    sessionId: 'session-1',
    timestamp: expect.any(String),
  },
})
```

**Step 2: Run target tests to verify they fail**

Run: `bun test apps/agent/src/runtime.test.ts apps/edge/src/index.test.ts`
Expected: FAIL because the agent still sends `ping` and edge does not handle heartbeat messages.

**Step 3: Write the minimal implementation**

- Change `startHeartbeat()` to send JSON heartbeat messages using the current `hostId/sessionId`
- In `HostSession.webSocketMessage()`, parse `heartbeat` messages from the host socket
- When the `sessionId/hostId` matches the active session, update `lastHeartbeatAt` in Durable Object storage

**Step 4: Re-run target tests**

Run: `bun test apps/agent/src/runtime.test.ts apps/edge/src/index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/agent/src/index.ts apps/agent/src/runtime.test.ts apps/edge/src/index.ts
git commit -m "feat: propagate structured heartbeat messages"
```

### Task 3: Expose minimal operator health view

**Files:**
- Modify: `packages/config/src/index.ts:3-7`
- Modify: `packages/config/src/index.test.ts:1-35`
- Modify: `apps/edge/wrangler.jsonc:6-10`
- Modify: `apps/edge/src/app.ts:315-377`
- Modify: `apps/edge/src/index.test.ts:13-245,247-320`

**Step 1: Write the failing health endpoint tests**

Add an operator-facing test for `GET /api/hosts/:hostId/health` that expects:
- `healthy: true` when heartbeat is recent
- `healthy: false` when heartbeat is stale or session is disconnected

```ts
expect(json).toEqual({
  hostId: 'host-1',
  sessionId: 'session-1',
  version: 1,
  healthy: true,
  lastHeartbeatAt: expect.any(Number),
  disconnectedAt: null,
  serviceCount: 1,
})
```

**Step 2: Run the edge test file and verify failure**

Run: `bun test apps/edge/src/index.test.ts`
Expected: FAIL because the route and config do not exist yet.

**Step 3: Write the minimal implementation**

- Add `HEARTBEAT_GRACE_MS` to edge env parsing with a reasonable default
- Add the same var to `wrangler.jsonc`
- In `app.ts`, add `GET /api/hosts/:hostId/health`
- Reuse the existing `/session` fetch and derive a compact health response from it

**Step 4: Re-run edge tests**

Run: `bun test apps/edge/src/index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add packages/config/src/index.ts packages/config/src/index.test.ts apps/edge/wrangler.jsonc apps/edge/src/app.ts apps/edge/src/index.test.ts
git commit -m "feat: expose host health status"
```

### Task 4: Add bounded concurrency and slow-service proof

**Files:**
- Modify: `apps/edge/src/index.test.ts:434-640,969-1060`
- Modify: `packages/testkit/src/index.ts:1-33` (only if helper extraction reduces duplication)

**Step 1: Write the failing bounded-concurrency tests**

Add two focused tests:
1. A slow HTTP service on one host does not block a concurrent fast HTTP service on the same host
2. A slow HTTP relay does not prevent a concurrent WebSocket upgrade on the same host from succeeding

Representative expectation:

```ts
expect(fastFinishedAt).toBeLessThan(slowFinishedAt)
expect(fastJson.serviceId).toBe('svc-fast')
expect(wsResponse.status).toBe(101)
```

**Step 2: Run the edge test file and verify failure**

Run: `bun test apps/edge/src/index.test.ts`
Expected: FAIL because the fake host stub does not simulate slow-path timing yet.

**Step 3: Write the minimal implementation**

- Teach the fake host stub to delay selected relay paths
- Keep the test bounded and deterministic (small fixed delay)
- Avoid turning this into a benchmark; only assert correctness and obvious non-starvation

**Step 4: Re-run the edge test file**

Run: `bun test apps/edge/src/index.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add apps/edge/src/index.test.ts packages/testkit/src/index.ts
git commit -m "test: add bounded concurrency proof"
```

### Task 5: Build repo-runnable v1 smoke orchestration

**Files:**
- Create: `packages/testkit/src/v1-smoke.ts`
- Modify: `packages/testkit/src/index.ts:1-33`
- Modify: `package.json:7-13`
- Optionally modify: `packages/testkit/package.json:1-12`

**Step 1: Write the smoke script first**

Create a Bun script that:
- starts three local upstream servers
- writes three temporary agent config files
- spawns `bun --cwd apps/edge run dev`
- spawns three agent processes pointed at those configs
- waits until 4 routes exist (3 HTTP + 1 WS, or equivalent chosen layout)
- verifies HTTP routing and one WebSocket echo
- cleans up child processes on exit

Skeleton:

```ts
const edge = Bun.spawn(['bun', '--cwd', 'apps/edge', 'run', 'dev'])
const agents = agentConfigs.map((config) =>
  Bun.spawn(['bun', '--cwd', 'apps/agent', 'run', 'src/index.ts'], {
    env: { ...process.env, UTUNNEL_AGENT_CONFIG: configPath },
  }),
)
```

**Step 2: Add root scripts**

Update `package.json` with commands like:
- `demo:v1`
- `smoke:v1`

Keep them repo-local and self-explanatory.

**Step 3: Run the smoke script manually**

Run: `bun run smoke:v1`
Expected: PASS with output showing edge ready, 3 hosts registered, HTTP routes verified, WebSocket echo verified.

**Step 4: Tighten the script until it is deterministic**

- Poll for readiness instead of sleeping blindly
- Always clean up spawned processes
- Print concise pass/fail checkpoints

**Step 5: Commit**

```bash
git add packages/testkit/src/v1-smoke.ts packages/testkit/src/index.ts package.json packages/testkit/package.json
git commit -m "feat: add repo-runnable v1 smoke flow"
```

### Task 6: Final verification and finish gate

**Files:**
- No code changes expected unless verification finds issues

**Step 1: Run the targeted smoke flow**

Run: `bun run smoke:v1`
Expected: PASS

**Step 2: Run the full project verification**

Run: `bun run typecheck && bun run test`
Expected: all commands pass

**Step 3: Confirm the original v1 evidence chain**

Checklist:
- 3 hosts can register independently
- each host exposes at least one service
- HTTP routing works
- WebSocket relay works
- reconnect/rebind still works
- stale route cleanup still works
- bounded concurrency proof exists
- host health is observable
- local demo/smoke is repo-runnable

**Step 4: Commit the finish line**

```bash
git add apps/agent/src apps/edge/src packages/config/src packages/protocol/src packages/testkit/src package.json
git commit -m "feat: finish utunnel v1 acceptance flow"
```

**Step 5: Optional follow-up note**

Record the known non-blocking race note from review: route pruning still uses time-based deletion and may deserve `sessionId/version` tightening in a future hardening pass.
