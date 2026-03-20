# mcp-mux

A stdio-to-stdio MCP multiplexer that presents itself to Claude Code as a single MCP server while sharing backend server processes across sessions via a background broker.

## Problem

Claude Code spawns every configured stdio MCP server as a child process **per session**. With 9 servers and 12 concurrent sessions, that's 108+ long-lived Node processes.

mcp-mux reduces this to **N shim processes + 9 shared servers**, regardless of session count.

```
Claude Code Session A                Claude Code Session B
        │                                    │
    stdin/stdout                         stdin/stdout
        │                                    │
   ┌────▼─────┐                        ┌─────▼────┐
   │  Shim A  │                        │  Shim B  │
   │ (stdio)  │                        │ (stdio)  │
   └────┬─────┘                        └─────┬────┘
        │            local socket            │
        └──────────────┬─────────────────────┘
                       │
              ┌────────▼────────┐
              │     Broker      │
              │  (background)   │
              └───┬────┬────┬───┘
                  │    │    │
            ┌─────▼┐ ┌▼────▼──┐  ┌────────┐
            │Server│ │Server  │  │ etc... │
            │  A   │ │  B     │  │        │
            │stdio │ │stdio   │  │ stdio  │
            └──────┘ └────────┘  └────────┘
```

## How it works

1. **Shim** — Lightweight stdio process spawned by Claude Code (one per session). Speaks MCP over stdin/stdout to Claude Code, connects to the broker over a local socket.
2. **Broker** — Long-lived background process managing all backend MCP servers. Auto-started by the first shim, auto-exits after 5 minutes of inactivity.

The shim aggregates tools from all backend servers into a single namespace, routes `tools/call` requests to the correct backend, and handles request ID remapping so multiple sessions can share servers without conflicts.

## Install

```bash
# Install from GitHub
npm install -g github:jasonwarta/mcp-mux

# Or use npx directly from GitHub (no install)
npx github:jasonwarta/mcp-mux
```

## Setup

### 1. Create `.mcp-mux.json` in your project root

```json
{
  "servers": {
    "pare-git": {
      "command": "npx",
      "args": ["-y", "@paretools/git"]
    },
    "pare-test": {
      "command": "npx",
      "args": ["-y", "@paretools/test"]
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"],
      "mode": "per-session",
      "lazy": true
    }
  }
}
```

### 2. Point Claude Code at the mux

In your `.mcp.json`:

```json
{
  "mcpServers": {
    "mcp-mux": {
      "type": "stdio",
      "command": "npx",
      "args": ["github:jasonwarta/mcp-mux"]
    }
  }
}
```

Or if you cloned the repo locally:

```json
{
  "mcpServers": {
    "mcp-mux": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/mcp-mux/src/shim.mjs"]
    }
  }
}
```

That's it. The shim auto-starts the broker on first use. No daemon management required.

## Configuration

### Server options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | string | **required** | Executable to spawn |
| `args` | string[] | `[]` | Arguments to the command |
| `env` | object | `{}` | Additional environment variables |
| `cwd` | string | project root | Working directory for the server |
| `mode` | `"shared"` \| `"per-session"` | `"shared"` | Shared: one process for all sessions. Per-session: one per shim (for stateful servers like Playwright) |
| `lazy` | boolean | `false` | If true, don't spawn until first `tools/call`. Tools are probed at startup then the process is killed. |
| `maxRestarts` | integer | `5` | Max consecutive restart attempts before marking as failed |
| `restartBackoffMs` | integer | `1000` | Initial backoff (doubles each failure, capped at 30s) |

### Global options

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `idleTimeoutMs` | integer | `300000` | Broker shuts down after this many ms with no connected shims |
| `requestTimeoutMs` | integer | `60000` | Timeout for individual tool call requests |

### Server modes

**Shared** (default) — One server process handles all sessions. Good for stateless tools (git, test runners, linters). The backend servers must accept explicit path/cwd parameters per request rather than relying on `process.cwd()`.

**Per-session** — One server process per Claude Code session. Required for stateful servers that maintain session context (e.g., Playwright browser sessions, code-graph indexes). The process is spawned on first tool call and killed when the session disconnects.

**Lazy** — The server is probed for capabilities at broker startup (so its tools appear in the tool list), then the process is killed. A real instance is spawned on the first `tools/call`. Works with both shared and per-session modes. Good for heavy, rarely-used servers.

## Tool naming

Tools are namespaced to avoid collisions. A tool named `status` from server `pare-git` appears in Claude Code as:

```
mcp__mcp-mux__pare-git__status
```

The format is `mcp__<mcp-server-name>__<backend-server>__<tool>`.

## CLI

The shim doubles as a CLI for broker management:

```bash
# Check broker status (server states, connected shims, uptime)
npx github:jasonwarta/mcp-mux status

# Stop the broker
npx github:jasonwarta/mcp-mux stop

# Restart the broker
npx github:jasonwarta/mcp-mux restart
```

If installed globally or cloned locally, replace `npx github:jasonwarta/mcp-mux` with `mcp-mux` or `node src/shim.mjs`.

All commands accept `--config <path>` to specify an alternate config file.

## How request routing works

1. Claude Code sends `tools/call` with a namespaced tool name
2. Shim looks up the routing table to find the backend server
3. Shim remaps the tool name back to the original and forwards to the broker
4. Broker remaps the request ID to a unique internal ID (so multiple shims can share a server without ID collisions)
5. Backend server processes the request and responds
6. Broker remaps the ID back and routes the response to the correct shim
7. Shim returns the response to Claude Code on stdout

## Crash recovery

- Backend servers that crash are automatically restarted with exponential backoff
- After `maxRestarts` consecutive failures, the server is marked as failed
- In-flight requests to a crashed server get an error response (not a hang)
- If the broker itself crashes, the next shim connection auto-starts a new one

## Socket paths

The broker listens on a local socket derived from the config file path:

- **Linux/macOS**: `$XDG_RUNTIME_DIR/mcp-mux-<hash>.sock` (or `/tmp/`)
- **Windows**: `\\.\pipe\mcp-mux-<hash>`

Where `<hash>` is the first 8 chars of SHA-256 of the absolute config path. Different projects get different sockets.

## Requirements

- Node.js >= 20
- Any stdio MCP server as a backend

Zero npm dependencies. Uses only Node.js built-in modules.

## License

MIT
