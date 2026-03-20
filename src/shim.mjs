#!/usr/bin/env node

/**
 * MCP Mux Shim
 *
 * A lightweight stdio MCP server that Claude Code spawns. It connects to the
 * broker over a local socket and aggregates tools from all backend servers
 * into a single MCP tool namespace.
 *
 * If the broker isn't running, the shim auto-starts it as a detached
 * background process.
 *
 * Usage as MCP server (spawned by Claude Code):
 *   node scripts/mcp-mux/shim.mjs [--config <path>]
 *
 * CLI commands:
 *   node scripts/mcp-mux/shim.mjs status  [--config <path>]
 *   node scripts/mcp-mux/shim.mjs stop    [--config <path>]
 *   node scripts/mcp-mux/shim.mjs restart [--config <path>]
 */

import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { loadConfig, deriveSocketPath, deriveLogPath } from './config.mjs'
import { createMessageReader, sendMessage } from './ipc-protocol.mjs'
import { log } from './log.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

const { values: opts, positionals } = parseArgs({
  options: {
    config: { type: 'string' },
  },
  allowPositionals: true,
})

const command = positionals[0] // undefined = MCP server mode

// --- CLI commands ---

if (command === 'status' || command === 'stop' || command === 'restart') {
  await runCli(command)
  process.exit(0)
}

if (command && command !== 'serve') {
  console.error(`Unknown command: ${command}`)
  console.error(`Usage: shim.mjs [status|stop|restart] [--config <path>]`)
  process.exit(1)
}

// --- MCP server mode ---

const shimId = randomUUID()
const { configPath } = loadConfig(opts.config)
const socketPath = deriveSocketPath(configPath)

/** @type {{ tools: object[], routingTable: Map<string, { serverName: string, originalName: string }> } | null} */
let brokerState = null
let brokerSocket = null
let brokerReader = null
/** @type {Map<string|number, { resolve: Function, timer: ReturnType<typeof setTimeout> }>} */
const pendingCalls = new Map()
const SHIM_REQUEST_TIMEOUT_MS = 120_000
let stdinBuffer = ''

async function main() {
  // Connect to broker (auto-start if needed)
  brokerSocket = await connectToBroker()
  wireUpBrokerSocket(brokerSocket)

  // Read MCP messages from Claude Code on stdin
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk) => {
    stdinBuffer += chunk
    processStdinBuffer()
  })

  process.stdin.on('end', () => {
    // Claude Code closed the session
    if (brokerSocket?.writable) {
      sendMessage(brokerSocket, { type: 'shim_disconnect', shimId })
      brokerSocket.end()
    }
    process.exit(0)
  })
}

function wireUpBrokerSocket(socket) {
  if (brokerReader) brokerReader.destroy()
  brokerReader = createMessageReader(socket, handleBrokerMessage)

  socket.on('close', () => {
    log.error(`Broker connection lost`)
    brokerState = null
    brokerSocket = null
    resetBrokerStatePromise()
    rejectAllPending('Broker connection lost')
    reconnect()
  })

  socket.on('error', (err) => {
    log.error(`Broker socket error`, { error: err.message })
  })
}

// --- Broker connection ---

async function connectToBroker() {
  // Try connecting first
  try {
    return await tryConnect(socketPath)
  } catch {
    // Broker not running, start it
    await startBroker()
    return await waitForBroker()
  }
}

function tryConnect(path) {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    const timeout = setTimeout(() => {
      socket.destroy()
      reject(new Error('Connection timeout'))
    }, 2000)

    socket.on('connect', () => {
      clearTimeout(timeout)
      // Send hello
      sendMessage(socket, {
        type: 'shim_hello',
        shimId,
        cwd: process.cwd(),
        pid: process.pid,
      })
      resolve(socket)
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })
}

async function startBroker() {
  const brokerPath = resolve(__dirname, 'broker.mjs')
  const { configPath } = loadConfig(opts.config)
  const socketPath = deriveSocketPath(configPath)
  const logPath = deriveLogPath(configPath)

  let logFd
  try {
    logFd = openSync(logPath, 'a')
  } catch {
    // If we can't open a log file, just discard output
    logFd = 'ignore'
  }

  log.info(`Starting broker`, { brokerPath, configPath, socketPath })

  const child = spawn(process.execPath, [brokerPath, '--config', configPath, '--socket', socketPath], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    cwd: dirname(configPath),
  })

  child.unref()

  // Close the fd — the child process has its own copy
  if (typeof logFd === 'number') {
    closeSync(logFd)
  }

  // Give it a moment to start
  await sleep(200)
}

async function waitForBroker() {
  const maxWait = 10_000
  const start = Date.now()
  let delay = 100

  while (Date.now() - start < maxWait) {
    try {
      return await tryConnect(socketPath)
    } catch {
      await sleep(delay)
      delay = Math.min(delay * 2, 1000)
    }
  }

  throw new Error(`Failed to connect to broker after ${maxWait}ms`)
}

async function reconnect() {
  try {
    brokerSocket = await connectToBroker()
    wireUpBrokerSocket(brokerSocket)
    log.info(`Reconnected to broker`)
  } catch (err) {
    log.error(`Failed to reconnect to broker`, { error: err.message })
    process.exit(1)
  }
}

// --- Broker message handling ---

function handleBrokerMessage(msg) {
  switch (msg.type) {
    case 'broker_hello': {
      // routingTable: namespacedName → { serverName, originalName }
      const routingTable = new Map()
      for (const tool of msg.tools) {
        routingTable.set(tool.name, tool._server)
      }
      brokerState = {
        tools: msg.tools.map(({ _server, ...rest }) => rest),
        routingTable,
        capabilities: msg.capabilities,
        serverInfo: msg.serverInfo,
        protocolVersion: msg.protocolVersion,
      }
      log.info(`Connected to broker`, { toolCount: msg.tools.length })
      if (_brokerStateResolve) {
        _brokerStateResolve()
        _brokerStateResolve = null
      }
      break
    }

    case 'tool_result':
    case 'error': {
      const response = msg.response
      const pending = pendingCalls.get(response.id)
      if (pending) {
        clearTimeout(pending.timer)
        pendingCalls.delete(response.id)
        pending.resolve(response)
      }
      break
    }

    case 'broker_shutdown':
      log.warn(`Broker is shutting down`)
      rejectAllPending('Broker shutting down')
      break

    default:
      log.debug(`Unknown broker message type`, { type: msg.type })
  }
}

// --- Stdin (Claude Code → Shim) processing ---

function processStdinBuffer() {
  let idx
  while ((idx = stdinBuffer.indexOf('\n')) !== -1) {
    const line = stdinBuffer.slice(0, idx)
    stdinBuffer = stdinBuffer.slice(idx + 1)
    if (!line.trim()) continue

    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }

    handleMcpMessage(msg)
  }
}

async function handleMcpMessage(msg) {
  // Initialize
  if (msg.method === 'initialize') {
    // Wait for broker_hello if not yet received
    if (!brokerState) {
      try {
        await waitForBrokerState()
      } catch (err) {
        writeStdout({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: err.message },
        })
        return
      }
    }

    writeStdout({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: brokerState.protocolVersion,
        capabilities: brokerState.capabilities,
        serverInfo: brokerState.serverInfo,
      },
    })
    return
  }

  // Initialized notification
  if (msg.method === 'notifications/initialized') {
    // No-op, already handled
    return
  }

  // Tools list
  if (msg.method === 'tools/list') {
    if (!brokerState) {
      try {
        await waitForBrokerState()
      } catch (err) {
        writeStdout({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: err.message },
        })
        return
      }
    }
    writeStdout({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: brokerState.tools,
      },
    })
    return
  }

  // Tools call
  if (msg.method === 'tools/call') {
    const toolName = msg.params?.name
    const route = brokerState?.routingTable?.get(toolName)

    if (!route) {
      writeStdout({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      })
      return
    }

    const { serverName, originalName } = route

    // Remap the tool name back to the original before forwarding
    const remappedRequest = {
      ...msg,
      params: { ...msg.params, name: originalName },
    }

    // Forward to broker and wait for response (with timeout)
    const responsePromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingCalls.delete(msg.id)
        resolve({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: `Request timed out after ${SHIM_REQUEST_TIMEOUT_MS}ms` },
        })
      }, SHIM_REQUEST_TIMEOUT_MS)
      pendingCalls.set(msg.id, { resolve, timer })
    })

    sendMessage(brokerSocket, {
      type: 'tool_call',
      shimId,
      serverName: serverName,
      request: remappedRequest,
    })

    const response = await responsePromise
    writeStdout(response)
    return
  }

  // Ping
  if (msg.method === 'ping') {
    writeStdout({ jsonrpc: '2.0', id: msg.id, result: {} })
    return
  }

  // Unknown method
  if (msg.id != null) {
    writeStdout({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    })
  }
}

let _brokerStateResolve = null
let _brokerStatePromise = null

function resetBrokerStatePromise() {
  _brokerStatePromise = new Promise((resolve, reject) => {
    _brokerStateResolve = resolve
    setTimeout(() => reject(new Error('Timed out waiting for broker to send tool list')), 10_000)
  })
}
resetBrokerStatePromise()

function waitForBrokerState() {
  if (brokerState) return Promise.resolve()
  return _brokerStatePromise
}

function writeStdout(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function rejectAllPending(reason) {
  for (const [id, pending] of pendingCalls) {
    clearTimeout(pending.timer)
    pending.resolve({
      jsonrpc: '2.0',
      id,
      error: { code: -32000, message: reason },
    })
  }
  pendingCalls.clear()
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

// --- CLI commands ---

async function runCli(cmd) {
  const { configPath } = loadConfig(opts.config)
  const socketPath = deriveSocketPath(configPath)

  if (cmd === 'stop' || cmd === 'restart') {
    try {
      const socket = await tryConnect(socketPath)
      sendMessage(socket, { type: 'shutdown' })
      socket.end()
      console.log('Broker shutdown requested.')
      // Wait a moment for it to die
      await sleep(1000)
    } catch {
      console.log('Broker is not running.')
    }

    if (cmd === 'restart') {
      await startBroker()
      console.log('Broker restarted.')
    }
    return
  }

  if (cmd === 'status') {
    try {
      const socket = await tryConnect(socketPath)

      const response = await new Promise((resolve, reject) => {
        const reader = createMessageReader(socket, (msg) => {
          if (msg.type === 'status_response') {
            resolve(msg)
            reader.destroy()
            socket.end()
          }
        })
        sendMessage(socket, { type: 'status' })
        setTimeout(() => reject(new Error('Timeout')), 5000)
      })

      // Remove broker_hello that we got from the shim_hello
      const { type, ...status } = response
      console.log(JSON.stringify(status, null, 2))
    } catch {
      console.log('Broker is not running.')
    }
  }
}

// --- Start MCP server mode ---

main().catch((err) => {
  log.error(`Shim fatal error`, { error: err.message, stack: err.stack })
  process.exit(1)
})
