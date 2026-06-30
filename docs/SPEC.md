# agent-smith spec

An MCP (Model Context Protocol) gateway: one MCP server that aggregates many downstream MCP
servers behind a single endpoint. For list ops the gateway fans inbound `tools/*`,
`resources/*`, `prompts/*` out across backends; for call ops it routes them to one backend.
Either way it passes them through a middleware chain and returns the merged result.
Everything is mutable at runtime: you can add or remove gateways, backends, and middleware
without a restart.

![Overview: clients hit per-gateway HTTP routes, each gateway runs a middleware chain and pool that fans out to backends](./diagrams/spec-overview.png)

<!-- Diagram source: docs/diagrams/spec-overview.mmd -->

## Packages

| Path | npm name | Role |
| --- | --- | --- |
| `packages/mcp-gateway` | `@agent-smith/mcp-gateway` | Core. Gateway, Pool, middleware contract, connector registry. No web framework dep. |
| `packages/mcp-gateway-middleware-logging` | `@agent-smith/mcp-gateway-middleware-logging` | A Middleware that logs every operation with timing. |
| `packages/mcp-gateway-backend-child-process` | `@agent-smith/mcp-gateway-backend-child-process` | A Connector that runs a backend as a raw child process over stdio. |
| `apps/server` | `@agent-smith/server` (private) | Hono app. Loads config, builds a GatewayHost, exposes it over HTTP, offers an admin API. |

Packages are flat under `packages/`, one directory per published package, with the
directory name matching the unscoped npm name. The Hono glue ships as a core subpath
`@agent-smith/mcp-gateway/hono` with `hono` as an optional `peerDependency`, so the core
main entry stays framework-free.

Root `package.json` workspaces:

```json
"workspaces": ["packages/*", "apps/*"]
```

## Core contracts

All types below live in `@agent-smith/mcp-gateway`. `Transport`, `Tool`, `Resource`,
`Prompt`, and result types come from `@modelcontextprotocol/sdk`.

### Connector

A Connector knows how to produce and own a live `Transport` to one backend running in
some isolation model (child process, docker, microvm, remote http). It is the per-package
extension point. One package per isolation model.

```ts
interface BackendConnector {
  readonly alias: string;
  // Called on first connect and on every restart. Slow boots (vm cold start) happen here.
  connect(signal: AbortSignal): Promise<Transport>;
  // Optional isolation-specific teardown beyond closing the transport (kill vm, rm container).
  dispose?(): Promise<void>;
}

type ConnectorFactory = (config: unknown, ctx: ConnectorContext) => BackendConnector;

interface ConnectorContext {
  alias: string;
  logger: Logger;
}

interface ConnectorRegistry {
  register(type: string, factory: ConnectorFactory): void;
  create(type: string, alias: string, config: unknown): BackendConnector;
}
```

Core ships the `command` (child process) and `http` (remote) connectors but registers
nothing by default; the operator registers what they want reachable. Registration is the
security boundary: not registering `command` means no admin call can spawn a local process.
Extra packages register their own type, for example `docker`, and validate their own config
slice.

### Backend

Internal to core. Wraps an SDK `Client` plus a Connector, and owns supervision:
detect `onclose`/`onerror`, back off, call `connector.connect()` again. Restart policy is
uniform and lives here, not in the connector.

```ts
interface Backend {
  readonly alias: string;
  readonly status: "connecting" | "ready" | "down";
  listTools(): Promise<Tool[]>;
  callTool(name: string, args: unknown): Promise<CallToolResult>;
  listResources(): Promise<Resource[]>;
  readResource(uri: string): Promise<ReadResourceResult>;
  listPrompts(): Promise<Prompt[]>;
  getPrompt(name: string, args: unknown): Promise<GetPromptResult>;
  // Fires when the backend reports notifications/*/list_changed.
  onListChanged(cb: () => void): () => void;
  dispose(): Promise<void>;
}
```

### Pool

Internal to core. Holds the live Backends for one Gateway and owns the namespace map.

- Aliases are validated at add time against `^[a-z0-9][a-z0-9-]*$`, so they can never
  contain the separator or break a uri. The operator picks the alias; a backend only
  controls the original name/uri, which always lands after the alias prefix, so a backend
  cannot forge or collide with another backend's namespace.
- Tools and prompts: exposed name = `<alias>__<original>`. Decode splits on the FIRST `__`;
  since the alias has no `__`, this is unambiguous even when the original name itself
  contains `__`.
- Resources: exposed uri = `agent-smith://<alias>/<percent-encoded-original-uri>`. Percent
  encoding collapses the original uri into a single path segment, so it cannot inject extra
  authority or path structure, and the `agent-smith` scheme avoids the scheme-collision the
  old `<alias>+<uri>` form had.
- Routing is by an authoritative `NamespaceIndex` (`exposed -> { alias, original, value }`)
  rebuilt on each aggregation pass, not by re-parsing the string in the hot path. Call ops
  resolve through it; an unknown or stale exposed id returns an error rather than being
  decoded and forwarded blindly. The `encode`/`decode` helpers exist for building and
  echoing identifiers, but `resolve()` is the source of truth for whether a target exists.
- List ops (`tools/list`, `resources/list`, `resources/templates/list`, `prompts/list`):
  drain every ready backend's pages, encode each entry, merge, and return one un-paginated
  response (a composite upstream cursor can come later). A per-backend item cap bounds the
  drain so a hostile or huge backend cannot exhaust memory: on exceed, truncate and log. The
  cap is configurable, default 1000 items per backend per list type. A down backend
  contributes nothing and does not fail the list.
- Call ops (`tools/call`, `resources/read`, `resources/subscribe`, `resources/unsubscribe`,
  `prompts/get`, `completion/complete`): resolve the name/uri/ref through the
  `NamespaceIndex` to its single target backend, forward the original name/uri. Never fan a
  call out. A backend that does not support completions returns empty values rather than an
  error.
- Subscriptions: the Pool tracks which session subscribed to which namespaced uri and
  forwards backend `notifications/resources/updated` up to those sessions, re-prefixing
  the uri.
- The map is rebuilt whenever a backend is added, removed, or fires `list_changed`.
- `ping` is answered locally; `logging/setLevel` broadcasts to every backend.

![Pool routing: list ops fan out to every backend and merge, call ops resolve the namespace and route to one backend](./diagrams/pool-routing.png)

<!-- Diagram source: docs/diagrams/pool-routing.mmd -->

### Middleware

This is the gateway operation chain, distinct from the HTTP middleware in the server layer
(`apps/server`). HTTP middleware handles transport concerns like auth; this chain wraps
resolved MCP operations. A Middleware wraps one client-facing operation after the target
backend(s) have been resolved. Middleware never talks to backends directly; the Pool does
that inside `next()`. The chain is snapshotted at the start of each operation, so a
concurrent `use()`/disposer call never mutates a chain mid-flight.

```ts
type CompletionRef =
  | { type: "ref/prompt"; name: string }        // namespaced
  | { type: "ref/resource"; uri: string };      // namespaced

type GatewayOperation =
  // list ops: fan out, merge
  | { kind: "tools/list" }
  | { kind: "resources/list" }
  | { kind: "resources/templates/list" }
  | { kind: "prompts/list" }
  // call ops: route to one backend
  | { kind: "tools/call"; name: string }
  | { kind: "resources/read"; uri: string }
  | { kind: "resources/subscribe"; uri: string }
  | { kind: "resources/unsubscribe"; uri: string }
  | { kind: "prompts/get"; name: string }
  | { kind: "completion/complete"; ref: CompletionRef };

interface GatewayContext {
  operation: GatewayOperation;
  backends: { alias: string }[];   // one entry for call ops, many for list ops
  request: unknown;                // mutable: rewrite args before next()
  response?: unknown;              // set after next(); mutable on the way out
  meta: Record<string, unknown>;   // scratch (timing, request id, auth principal)
}

type Next = () => Promise<void>;
type Middleware = (ctx: GatewayContext, next: Next) => Promise<void>;
```

Patterns: logging wraps `next()` with a timer. Sanitizing mutates `ctx.request` or
`ctx.response` around `next()`. Access control denies by throwing (call ops) or filters
`ctx.response` after `next()` (list ops); both halves are required, since a client can
call a tool whose name it already knows even if it was hidden from the list.

### Access control

Ships as a middleware. Glob rules over namespaced names, so backend-level rules like
`github__*` work without a separate config path.

```ts
interface AccessRule { allow?: string[]; deny?: string[]; }   // glob patterns
// If allow is set: deny-by-default, only matches pass. deny always subtracts on top.
```

Rules are replaceable at runtime via `Gateway.setAccessRules()`, so an operator can tighten
or relax access without dropping sessions. The principal to match against arrives in
`ctx.meta.auth`, populated by the server layer (see Hono server). Core never reads it; it
treats the principal as opaque.

### Gateway (mutable)

A self-contained unit: a Pool plus a middleware chain plus access rules. Long-lived and
shared across client sessions. `createServer()` is the seam the Hono adapter uses: it
returns a fresh per-session MCP `Server` facade wired into this gateway's shared Pool, so
sessions are cheap and downstream processes are not respawned per client.

```ts
interface SessionContext {
  id: string;
  auth?: unknown;                  // opaque principal from the server layer; core never reads it
  headers?: Headers;
}

interface Gateway {
  readonly name: string;
  createServer(session: SessionContext): Server;            // per-session facade over shared Pool
  instructions(): string;                                   // merged backend instructions

  addBackend(alias: string, config: BackendConfig): Promise<void>;
  removeBackend(alias: string): Promise<void>;
  backends(): { alias: string; status: string }[];

  use(mw: Middleware): () => void;                          // append to the chain; returns a disposer
  setAccessRules(rules: AccessRule): void;                  // replace access rules atomically at runtime
  onChange(cb: () => void): () => void;                     // fires on backend add/remove/list_changed
  dispose(): Promise<void>;
}
```

Everything mutable is mutable for real: backends via `addBackend`/`removeBackend`,
middleware via `use()`'s disposer, access rules via `setAccessRules()`. `createServer`
takes the per-session context (`id`, opaque `auth` principal, raw `headers`) so the
principal reaches `ctx.meta.auth`. If the server layer set no principal, `auth` is
`undefined` and calls proceed; access-control middleware that requires a principal rejects
`undefined` itself.

On backend add/remove, the Gateway rebuilds the namespace map and emits
`notifications/tools/list_changed` (and the resources/prompts equivalents) to every live
session, so connected clients re-list and pick up changes without reconnecting.

### Instructions aggregation

A downstream server can return an `instructions` string in its `initialize` result.
The Gateway captures each backend's instructions at connect time and `instructions()`
merges them, labeled by alias so a model can tell which server said what:

```text
## fs
<fs server instructions>

## github
<github server instructions>
```

`createServer()` serves this merged string as the per-session Server's own `instructions`.
There is no `instructions_changed` notification in MCP, so a client only sees instructions
at `initialize`: new sessions pick up the current merge, existing sessions keep what they
got at connect. This is aggregation state, not a per-request operation, so it does not flow
through the middleware chain.

### GatewayHost (mutable)

Owns the set of named gateways. The transport host (Hono app, stdio launcher) is built on
top and stays thin.

```ts
function createGatewayHost(config: HostConfig): Promise<GatewayHost>;

interface GatewayHost {
  names(): string[];
  gateway(name: string): Gateway | undefined;
  addGateway(name: string, config: GatewayConfig): Promise<Gateway>;
  removeGateway(name: string): Promise<void>;               // tears down backends, closes sessions
  dispose(): Promise<void>;
}
```

## Config

```jsonc
{
  "gateways": {
    "project-a": {
      "backends": {
        "fs":  { "type": "command", "command": "mcp-server-fs", "args": ["--root", "."] },
        "gh":  { "type": "http",    "url": "https://example.com/mcp" }
      },
      "middleware": ["@agent-smith/mcp-gateway-middleware-logging"],
      "access": { "tools": { "allow": ["fs__*"] } }
    },
    "project-b": {
      "backends": { "fs": { "type": "command", "command": "mcp-server-fs", "args": [] } }
    }
  }
}
```

`type` selects the connector; it defaults to `command`. Each connector validates its own
config slice (zod). Config is the startup seed only; the live state is whatever the mutable
host holds after admin calls.

## Hono server (apps/server)

A single dynamic dispatch route so new gateways need no new route. Per-gateway handlers
manage their own session map.

```ts
import { Hono } from "hono";
import { createGatewayHost } from "@agent-smith/mcp-gateway";
import { honoMcp } from "@agent-smith/mcp-gateway/hono";

const host = await createGatewayHost(loadConfig());
const app = new Hono();

app.all("/:gateway/mcp", async (c) => {
  const gw = host.gateway(c.req.param("gateway"));
  if (!gw) return c.json({ error: "unknown gateway" }, 404);
  return honoMcp(gw)(c);                 // honoMcp caches one handler + session map per gateway
});

// Admin API (mutates the live host, no restart):
app.post("/admin/gateways/:name",            /* host.addGateway */);
app.delete("/admin/gateways/:name",          /* host.removeGateway */);
app.post("/admin/gateways/:name/backends",   /* gateway.addBackend */);
app.delete("/admin/gateways/:name/backends/:alias", /* gateway.removeBackend */);

export default app;   // Bun serves app.fetch
```

`honoMcp(gateway)` keeps `Map<sessionId, WebStandardStreamableHTTPServerTransport>`. On a
new session it calls `gateway.createServer(session)`, building the `SessionContext` from the
Hono context: `id`, `auth` read from `c.get("auth")`, and `c.req.raw.headers`. It then
connects a fresh transport and stores it. The SDK transport is fetch-native, so
`transport.handleRequest(c.req.raw)` returns a `Response` directly.

Auth is the operator's responsibility, not core's. Both the data plane (`/:gateway/mcp`)
and the admin API are unauthenticated by default; the operator wraps each with HTTP
middleware. With Hono, `bearer-auth` reads the header and the operator sets the principal
via `c.set("auth", ...)` for access-control middleware to use:

```ts
import { bearerAuth } from "hono/bearer-auth";

app.use("/admin/*", bearerAuth({ verifyToken: async (t) => isValidAdminToken(t) }));
app.use("/:gateway/mcp", bearerAuth({ verifyToken: async (t) => isValidClientToken(t) }));
```

The `command` connector spawns local processes, so an open admin API is remote code
execution. Two boundaries guard this: the operator's auth middleware, and not registering
the `command` connector when local-process execution is unacceptable.

## Known gaps and open decisions

These came out of a three-way design review (protocol correctness, architecture, and
operational edge cases). Ranked by how much they block a real deployment. Items marked
**decided** have been resolved and folded into the contracts above; the rest are "do it
this way when wiring the layer."

### Blockers for a working gateway

> Namespace routing (validated aliases, first-separator split, `agent-smith://` resource
> uris, authoritative `NamespaceIndex`) is now implemented in `src/namespace.ts` and folded
> into the Pool section above.

- **No upward capability negotiation.** The gateway must advertise an `initialize`
  capability set. Content capabilities are the union of its backends: `tools`/`resources`/
  `prompts` if any backend has them; `resources.subscribe` as an OR; `completions` and
  `logging` if any backend advertises them. `*.listChanged` is the exception: always
  advertised for tools/resources/prompts regardless of backend support, because the gateway
  itself is dynamic (admin add/remove changes the list and fires `list_changed`). A client
  must therefore tolerate `list_changed` for a currently-empty list type. Subscribe must
  route only to backends that declared it. Recompute on backend add/remove; new sessions get
  the new set (MCP has no mid-session renegotiation), existing sessions keep theirs. The
  client capabilities advertised *downward* to backends are a separate, fixed minimal set,
  not a union: v1 advertises no `sampling`/`elicitation`/`roots` (see Server-to-client).
- **The connector registry never reaches a Gateway.** `createGatewayHost` takes a registry
  but the `Gateway` interface has no way to turn `{ type: "command" }` into a connector ->
  `Backend`. Thread the `ConnectorRegistry` into the Gateway; `addBackend` resolves
  `config.type` via `registry.create(...)` into a supervised `Backend`, and rejects when the
  type is unregistered.
- **Pagination on list ops.** Resolved in the Pool section: drain each backend's pages,
  merge, return one un-paginated response, bounded by a configurable per-backend item cap
  (truncate and log on exceed, default 1000). A composite upstream cursor can come later.

### Security (decided)

- **Auth is the operator's job, not core's.** Decided: the gateway is single-purpose and
  ships no auth. Both the data plane and the admin API are unauthenticated by default; the
  operator wraps each with HTTP middleware (Hono `bearer-auth`), documented in the gateway
  README. Core stays header-blind and carries an opaque `auth` principal from the server
  layer into `ctx.meta.auth` (see Hono server). The tradeoff accepted: a forgetful operator
  can expose RCE, in exchange for keeping core focused.
- **No separate connector-type gating.** Decided: the connector registry is the boundary.
  Core ships `command`/`http` but auto-registers nothing; an operator who does not want
  local-process execution simply never registers `command`. No redundant allowlist in core.
- **Treat backend output as hostile.** Validate tool names and URIs from backends; escape or
  reject glob metacharacters before access-control matching; match access rules on the
  structured `{ alias, originalName }`, not the joined string; assert the list-filter and
  call-deny halves share one compiled predicate so they cannot desync.

### Server-to-client surface

- **Sampling, elicitation, roots (decided: unsupported in v1).** Backends can call up to the
  real client, but many sessions share one backend connection, so the gateway would have to
  decide whose client answers. v1 sidesteps this by not advertising these client
  capabilities downward, so backends never initiate them. Route-to-originating-session is the
  eventual design, deferred to the correlation-table work below since it needs the same
  table.
- **Progress, cancellation, backend log messages (do this when wiring).** Forward inbound
  `progressToken` and relay backend `notifications/progress` to the originating session;
  maintain a per-session client-reqid <-> backend-reqid table and forward
  `notifications/cancelled` both ways; relay backend `notifications/message` upward, tagged
  with the alias and filtered by each session's log level. This correlation table is also
  what unlocks route-to-originating for sampling/elicitation/roots, so build all four
  together.

### Lifecycle and concurrency

- **Mid-call removal and replace semantics (decided: graceful then forceful).**
  `removeBackend` while a call is in flight: remove from the namespace index first so nothing
  new routes there, let in-flight calls drain up to a configurable timeout (default 10s), on
  timeout force-abort the stragglers with a typed `GatewayError` (rendered as a proper
  JSON-RPC error), then `connector.dispose()`. `addBackend` / `addGateway` on an existing
  name must dispose the prior instance (await teardown) instead of overwriting and leaking
  it. All mutations on one gateway run through a per-gateway queue, so concurrent add/remove
  of the same alias are strictly ordered.
- **Gateway removal vs the Hono session map.** `honoMcp` holds its own
  `Map<sessionId, transport>`. `removeGateway` must close those transports and end open
  streams; key the per-gateway handler cache on the gateway instance and evict on removal so
  a remove-then-readd does not reuse a stale session map.
- **Supervision needs bounds.** Exponential backoff with a cap and a max-consecutive-failure
  ceiling that parks the backend in `down` with a reason (no infinite crash loop); a connect
  timeout that fires the `AbortSignal` passed to `connector.connect()`; `addBackend` is
  fire-and-connect (registers and returns immediately, status observable via `onChange`), so
  a slow or broken backend never hangs the admin call.
- **Subscription lifecycle.** When a subscribed backend goes `down` or is removed, drop its
  subscription entries and nudge the subscribed sessions so they can re-subscribe; re-issue
  downstream subscribes on restart for still-connected sessions; tie subscription entries to
  session teardown so they do not leak.
- **Per-session state that is actually shared downstream.** `logging/setLevel` is per-client
  but the backend connection is shared: track each session's level at the gateway, set the
  backend to the most verbose requested level, and filter relayed log records per session.
  Never pass a client's raw request or progress id straight downstream.

### Resource limits (untrusted backends)

- Per-call timeout and a max response-byte ceiling (stream-counted, abort on exceed); a cap
  on tools/resources a single backend may register (truncate and log); a token bucket on
  inbound notifications per backend; debounce/coalesce `list_changed` so a flapping backend
  cannot trigger O(sessions x backends) rebuilds per flap; per-backend and per-session
  in-flight concurrency caps; idle teardown of backends and a max-backends ceiling per host.

### Contract and typing polish

- Parameterize `GatewayContext` by operation (`GatewayContext<Op extends GatewayOperation>`)
  so narrowing on `operation.kind` narrows `request`/`response`, instead of `unknown`.
- `Backend` is missing `subscribe`/`unsubscribe`/`complete`/`setLevel`, plus `capabilities`
  and `instructions`; `onListChanged` should carry which list (tools/resources/prompts)
  changed instead of collapsing all three.
- `ConnectorRegistry` is a concrete class, not an interface: align the spec; `register`
  returns `this` and there is a `has()`; guard duplicate `type` registration; consider a
  connector `apiVersion` for the third-party compat story.
- `BackendInfo.status` should use the `"connecting" | "ready" | "down"` union, not `string`.
- Connector config validation needs a real seam (zod in the factory) rather than the current
  `as` cast.

### Intentionally deferred

- Remote backend auth beyond a static token/header (no OAuth flow in v1).
- A `connector.restart?()` hook for isolation that wants warm-pool or snapshot-resume
  instead of cold reconnect. Add only when a backend package needs it.
- Per-backend middleware hooks. For now the Pool writes per-backend timings into `ctx.meta`
  and the single chain sees the merged result.
- stdio host (serves exactly one gateway). HTTP host is the primary target.
