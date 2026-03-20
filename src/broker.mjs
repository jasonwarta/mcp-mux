#!/usr/bin/env node

/**
 * MCP Mux Broker
 *
 * Long-lived background process that manages backend MCP server child processes.
 * Accepts connections from shims over a local socket, multiplexes requests to
 * the appropriate backend server, and routes responses back.
 *
 * Spawned automatically by the first shim. Not intended to be run directly
 * (though it can be for debugging).
 *
 * Usage:
 *   node scripts/mcp-mux/broker.mjs --config <path> --socket <path>
 */

import { createServer } from 'node:net'
import { writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { log } from './log.mjs'
import { loadConfig, derivePidPath } from './config.mjs'
import { ServerManager } from './server-manager.mjs'
import { createMessageReader, sendMessage } from './ipc-protocol.mjs'

const { values: args } = parseArgs({
  options: {
    config: { type: 'string' },
    socket: { type: 'string' },
  },
})

if (!args.config || !args.socket) {
  console.error('Usage: broker.mjs --config <path> --socket <path>')
  process.exit(1)
}

const socketPath = args.socket
const pidPath = derivePidPath(args.config)

// --- State ---

/** @type {Map<string, { socket: import('node:net').Socket, reader: object }>} */
const shims = new Map()
let idleTimer = null
let serverManager = null
let server = null
let serversReady = false
let serversReadyResolve
const serversReadyPromise = new Promise((r) => { serversReadyResolve = r })

// --- Main ---

let idleTimeoutMs = 300_000
let requestTimeoutMs = 60_000

async function main() {
  const { config, projectRoot } = loadConfig(args.config)
  idleTimeoutMs = config.idleTimeoutMs
  requestTimeoutMs = config.requestTimeoutMs

  serverManager = new ServerManager(config.servers, projectRoot)

  // Clean up stale socket
  if (process.platform !== 'win32' && existsSync(socketPath)) {
    try { unlinkSync(socketPath) } catch {}
  }

  server = createServer(handleShimConnection)

  // Wait for the socket to be ready before doing anything else
  await new Promise((resolve, reject) => {
    server.on('error', (err) => {
      log.error(`Socket server error`, { error: err.message })
      reject(err)
    })
    server.listen(socketPath, () => {
      log.info(`Broker listening`, { socket: socketPath, pid: process.pid })
      // Restrict socket to owner-only on Unix
      if (process.platform !== 'win32') {
        try { chmodSync(socketPath, 0o700) } catch {}
      }
      writeFileSync(pidPath, String(process.pid))
      resolve()
    })
  })

  // Start/probe all backend servers
  await serverManager.startAll()
  serversReady = true
  serversReadyResolve()
  log.info(`All servers initialized`)

  resetIdleTimer(idleTimeoutMs)

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

async function shutdown(signal) {
  log.info(`Shutting down`, { signal })
  clearTimeout(idleTimer)

  // Notify shims
  for (const [, shim] of shims) {
    try {
      sendMessage(shim.socket, { type: 'broker_shutdown' })
      shim.socket.end()
    } catch {}
  }
  shims.clear()

  if (server) server.close()
  if (serverManager) await serverManager.shutdownAll()

  cleanup()
  process.exit(0)
}

function cleanup() {
  try { unlinkSync(pidPath) } catch {}
  if (process.platform !== 'win32') {
    try { unlinkSync(socketPath) } catch {}
  }
}

function resetIdleTimer(timeoutMs) {
  if (idleTimer) clearTimeout(idleTimer)
  if (shims.size > 0) return // not idle if shims connected

  idleTimer = setTimeout(() => {
    if (shims.size === 0) {
      log.info(`Idle timeout reached, shutting down`)
      shutdown('idle')
    }
  }, timeoutMs)
}

// --- Shim connection handling ---

function handleShimConnection(socket) {
  let shimId = null

  const reader = createMessageReader(socket, async (msg) => {
    switch (msg.type) {
      case 'shim_hello':
        shimId = msg.shimId
        shims.set(shimId, { socket, reader })
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
        log.info(`Shim connected`, { shimId, pid: msg.pid })

        // Wait for servers to be ready before sending tool list
        if (!serversReady) {
          await serversReadyPromise
        }

        const { tools, routingTable } = serverManager.getAggregatedTools()
        sendMessage(socket, {
          type: 'broker_hello',
          protocolVersion: '2025-11-25',
          capabilities: serverManager.getCapabilities(),
          serverInfo: serverManager.getServerInfo(),
          tools: tools.map((t) => ({
            ...t,
            _server: routingTable.get(t.name),
          })),
        })
        break

      case 'tool_call':
        if (!shimId || msg.shimId !== shimId) {
          log.warn(`tool_call shimId mismatch or missing`, { expected: shimId, got: msg.shimId })
          break
        }
        try {
          const response = await serverManager.routeToolCall(
            msg.serverName,
            shimId,
            msg.request,
            requestTimeoutMs
          )
          sendMessage(socket, {
            type: 'tool_result',
            shimId,
            response,
          })
        } catch (err) {
          sendMessage(socket, {
            type: 'error',
            shimId,
            response: {
              jsonrpc: '2.0',
              id: msg.request?.id,
              error: { code: -32000, message: err.message },
            },
          })
        }
        break

      case 'forward':
        log.debug(`Forward request not implemented`, { shimId: msg.shimId, serverName: msg.serverName })
        if (msg.request?.id != null) {
          sendMessage(socket, {
            type: 'error',
            shimId: msg.shimId,
            response: {
              jsonrpc: '2.0',
              id: msg.request.id,
              error: { code: -32601, message: 'Generic forwarding not implemented' },
            },
          })
        }
        break

      case 'shim_disconnect':
        log.info(`Shim disconnecting`, { shimId: msg.shimId })
        break

      case 'status':
        sendMessage(socket, {
          type: 'status_response',
          ...serverManager.getStatus(),
          shims: shims.size,
          uptime: process.uptime(),
        })
        break

      case 'shutdown':
        log.info(`Shutdown requested by shim`)
        process.kill(process.pid, 'SIGTERM')
        break

      default:
        log.warn(`Unknown message type from shim`, { type: msg.type, shimId })
    }
  })

  socket.on('close', async () => {
    reader.destroy()
    if (shimId) {
      shims.delete(shimId)
      await serverManager.cleanupShim(shimId)
      log.info(`Shim disconnected`, { shimId })
      resetIdleTimer(idleTimeoutMs)
    }
  })

  socket.on('error', (err) => {
    log.warn(`Shim socket error`, { shimId, error: err.message })
  })
}

main().catch((err) => {
  log.error(`Broker fatal error`, { error: err.message, stack: err.stack })
  cleanup()
  process.exit(1)
})
