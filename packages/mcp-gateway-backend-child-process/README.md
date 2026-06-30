# @agent-smith/mcp-gateway-backend-child-process

A [`@agent-smith/mcp-gateway`](../mcp-gateway) connector that runs a downstream MCP server as a
raw child process and talks to it over stdio. This is the simplest isolation model and
covers most MCP servers shipping today. Other isolation models (docker, microvm) live in
their own packages behind the same `BackendConnector` contract.

![Child process connector: the backend's connector spawns an MCP server process with Bun.spawn and talks over stdio](./diagrams/child-process.png)

<!-- Diagram source: packages/mcp-gateway-backend-child-process/diagrams/child-process.mmd -->

## Install

```sh
bun add @agent-smith/mcp-gateway-backend-child-process
```

## Usage

Register it under a config `type`, then reference that type from a backend config:

```ts
import { ConnectorRegistry } from "@agent-smith/mcp-gateway";
import { childProcess } from "@agent-smith/mcp-gateway-backend-child-process";

const registry = new ConnectorRegistry().register("command", childProcess);
```

```jsonc
{
  "fs": { "type": "command", "command": "mcp-server-fs", "args": ["--root", "."] }
}
```

## Config

| Field | Type | Description |
| --- | --- | --- |
| `command` | `string` | Executable to spawn. |
| `args` | `string[]` | Arguments. Optional. |
| `env` | `Record<string, string>` | Extra environment. Optional. |

## Status

Stub. `connect()` logs what it would spawn and returns a placeholder transport. Wiring
`Bun.spawn` to the SDK `StdioClientTransport` is the next step. See the spec for details.
