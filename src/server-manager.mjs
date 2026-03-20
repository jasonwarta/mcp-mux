import { spawn } from 'node:child_process'
import { log } from './log.mjs'

/**
 * Manages backend MCP server processes.
 * Handles spawn, initialize handshake, crash recovery, and request routing.
 */
export class ServerManager {
  /** @type {Map<string, ManagedServer>} */
  #servers = new Map()
  /** @type {Map<string, ManagedServer>} per-session instances keyed by `${serverName}:${shimId}` */
  #sessionInstances = new Map()
  /** @type {Map<string, Promise<ManagedServer|null>>} in-flight spawns to prevent duplicates */
  #pendingSpawns = new Map()
  #projectRoot

  /**
   * @param {Record<string, object>} serverConfigs
   * @param {string} projectRoot
   */
  constructor(serverConfigs, projectRoot) {
    this.#projectRoot = projectRoot
    for (const [name, config] of Object.entries(serverConfigs)) {
      this.#servers.set(name, new ManagedServer({ ...config, name }, projectRoot))
    }
  }

  /**
   * Start all non-lazy servers. Probe lazy servers for capabilities.
   */
  async startAll() {
    const startups = []
    for (const server of this.#servers.values()) {
      if (server.config.lazy) {
        startups.push(this.#probeLazy(server))
      } else if (server.config.mode === 'shared') {
        startups.push(this.#startServer(server))
      }
      // per-session non-lazy servers start on first shim request
    }
    await Promise.allSettled(startups)
  }

  /**
   * Get the aggregated tool list from all servers.
   * @returns {{ tools: object[], routingTable: Map<string, { serverName: string, originalName: string }> }}
   */
  getAggregatedTools() {
    const tools = []
    // routingTable maps namespaced name → { serverName, originalToolName }
    const routingTable = new Map()

    for (const server of this.#servers.values()) {
      if (!server.tools) continue
      for (const tool of server.tools) {
        // Namespace: <server>__<tool> to avoid collisions
        const namespacedName = `${server.config.name}__${tool.name}`
        routingTable.set(namespacedName, {
          serverName: server.config.name,
          originalName: tool.name,
        })
        tools.push({ ...tool, name: namespacedName })
      }
    }

    return { tools, routingTable }
  }

  /**
   * Get aggregated server capabilities.
   */
  getCapabilities() {
    return { tools: { listChanged: false } }
  }

  /**
   * Get server info for the mux.
   */
  getServerInfo() {
    return { name: 'mcp-mux', version: '1.0.0' }
  }

  /**
   * Route a tool call to the correct backend server.
   * @param {string} serverName
   * @param {string} shimId
   * @param {object} request - The JSON-RPC tools/call request.
   * @param {number} timeoutMs
   * @returns {Promise<object>} The JSON-RPC response.
   */
  async routeToolCall(serverName, shimId, request, timeoutMs) {
    const serverConfig = this.#servers.get(serverName)
    if (!serverConfig) {
      return this.#makeError(request.id, -32601, `Unknown server: ${serverName}`)
    }

    let instance
    if (serverConfig.config.mode === 'per-session') {
      instance = await this.#getOrCreateSessionInstance(serverName, shimId)
    } else {
      instance = serverConfig
      // If lazy and not yet started, start now
      if (instance.state === 'lazy') {
        await this.#startServer(instance)
      }
    }

    if (!instance || instance.state !== 'ready') {
      return this.#makeError(request.id, -32000, `Server "${serverName}" is not ready (state: ${instance?.state})`)
    }

    return instance.sendRequest(request, timeoutMs)
  }

  /**
   * Clean up per-session server instances when a shim disconnects.
   * @param {string} shimId
   */
  async cleanupShim(shimId) {
    for (const [key, instance] of this.#sessionInstances) {
      if (key.endsWith(`:${shimId}`)) {
        log.info(`Shutting down per-session instance`, { server: instance.config.name, shimId })
        await instance.shutdown()
        this.#sessionInstances.delete(key)
      }
    }
  }

  /**
   * Shut down all servers.
   */
  async shutdownAll() {
    const shutdowns = []
    for (const server of this.#servers.values()) {
      shutdowns.push(server.shutdown())
    }
    for (const instance of this.#sessionInstances.values()) {
      shutdowns.push(instance.shutdown())
    }
    await Promise.allSettled(shutdowns)
    this.#sessionInstances.clear()
  }

  /**
   * Get status info for all servers.
   */
  getStatus() {
    const servers = {}
    for (const [name, server] of this.#servers) {
      servers[name] = {
        state: server.state,
        mode: server.config.mode,
        lazy: server.config.lazy,
        pid: server.process?.pid ?? null,
        requestsServed: server.requestsServed,
        consecutiveFailures: server.consecutiveFailures,
        toolCount: server.tools?.length ?? 0,
      }
    }

    const sessionInstances = {}
    for (const [key, instance] of this.#sessionInstances) {
      sessionInstances[key] = {
        state: instance.state,
        pid: instance.process?.pid ?? null,
      }
    }

    return { servers, sessionInstances }
  }

  async #probeLazy(server) {
    try {
      log.info(`Probing lazy server for capabilities`, { server: server.config.name })
      await server.spawnAndInitialize()
      // Cache tools, then kill the process
      await server.shutdown()
      server.state = 'lazy'
      log.info(`Lazy server probed successfully`, {
        server: server.config.name,
        toolCount: server.tools?.length ?? 0,
      })
    } catch (err) {
      log.error(`Failed to probe lazy server`, {
        server: server.config.name,
        error: err.message,
      })
      server.state = 'failed'
    }
  }

  async #startServer(server) {
    try {
      await server.spawnAndInitialize()
      log.info(`Server started`, {
        server: server.config.name,
        pid: server.process?.pid,
        toolCount: server.tools?.length ?? 0,
      })
    } catch (err) {
      log.error(`Failed to start server`, {
        server: server.config.name,
        error: err.message,
      })
    }
  }

  async #getOrCreateSessionInstance(serverName, shimId) {
    const key = `${serverName}:${shimId}`
    let instance = this.#sessionInstances.get(key)
    if (instance && instance.state === 'ready') return instance

    // Guard against concurrent spawns for the same key
    const pending = this.#pendingSpawns.get(key)
    if (pending) return pending

    const spawnPromise = this.#doCreateSessionInstance(serverName, shimId, key)
    this.#pendingSpawns.set(key, spawnPromise)
    try {
      return await spawnPromise
    } finally {
      this.#pendingSpawns.delete(key)
    }
  }

  async #doCreateSessionInstance(serverName, shimId, key) {
    const serverConfig = this.#servers.get(serverName)
    if (!serverConfig) return null

    const instance = new ManagedServer({ ...serverConfig.config }, this.#projectRoot)

    // For lazy per-session, we already have cached tools from the probe
    if (serverConfig.config.lazy && serverConfig.tools) {
      instance.tools = [...serverConfig.tools]
      instance.capabilities = { ...serverConfig.capabilities }
      instance.serverInfo = { ...serverConfig.serverInfo }
      instance.protocolVersion = serverConfig.protocolVersion
    }

    try {
      await instance.spawnAndInitialize()
      this.#sessionInstances.set(key, instance)
      log.info(`Per-session instance started`, { server: serverName, shimId, pid: instance.process?.pid })
      return instance
    } catch (err) {
      log.error(`Failed to start per-session instance`, { server: serverName, shimId, error: err.message })
      return null
    }
  }

  #makeError(id, code, message) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code, message },
    }
  }
}

/**
 * Represents a single backend MCP server process.
 */
class ManagedServer {
  config
  process = null
  state = 'stopped'
  capabilities = null
  serverInfo = null
  protocolVersion = null
  tools = null
  consecutiveFailures = 0
  requestsServed = 0

  /** @type {Map<number, { originalId: string|number, resolve: Function, timer: ReturnType<typeof setTimeout> }>} */
  #pendingRequests = new Map()
  #nextInternalId = 1
  #stdoutBuffer = ''
  #writeQueue = []
  #writing = false
  #projectRoot
  #restartTimer = null
  #crashHandler = null

  constructor(config, projectRoot) {
    this.config = config
    this.#projectRoot = projectRoot
  }

  /**
   * Spawn the child process and perform the MCP initialize handshake.
   */
  async spawnAndInitialize() {
    this.state = 'starting'

    // Remove stale crash handler from any previous process
    const prevProcess = this.process
    if (prevProcess && this.#crashHandler) {
      prevProcess.removeListener('exit', this.#crashHandler)
    }

    const child = spawn(this.config.command, this.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
      cwd: this.config.cwd || this.#projectRoot,
      shell: false,
      windowsHide: true,
    })

    this.process = child

    child.stderr.on('data', (data) => {
      log.debug(`stderr`, { server: this.config.name, data: data.toString().trimEnd() })
    })

    child.stdout.on('data', (chunk) => {
      this.#stdoutBuffer += chunk.toString('utf-8')
      this.#processStdoutBuffer()
    })

    this.#crashHandler = (code) => {
      if (this.state === 'stopped') return // expected shutdown
      log.warn(`Server process exited unexpectedly`, { server: this.config.name, code })
      this.#handleCrash()
    }
    child.on('exit', this.#crashHandler)

    // Initialize handshake
    const initResponse = await this.sendRequest({
      jsonrpc: '2.0',
      id: '__init__',
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'mcp-mux', version: '1.0.0' },
      },
    }, 30_000)

    if (initResponse.error) {
      throw new Error(`Initialize failed: ${JSON.stringify(initResponse.error)}`)
    }

    this.capabilities = initResponse.result?.capabilities ?? {}
    this.serverInfo = initResponse.result?.serverInfo ?? {}
    this.protocolVersion = initResponse.result?.protocolVersion ?? '2025-11-25'

    // Send initialized notification
    this.#writeToStdin({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })

    // Fetch tool list
    const toolsResponse = await this.sendRequest({
      jsonrpc: '2.0',
      id: '__tools__',
      method: 'tools/list',
    }, 30_000)

    if (toolsResponse.result?.tools) {
      this.tools = toolsResponse.result.tools
    } else {
      this.tools = []
    }

    this.state = 'ready'
    this.consecutiveFailures = 0
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   * @param {object} request
   * @param {number} timeoutMs
   * @returns {Promise<object>}
   */
  sendRequest(request, timeoutMs = 60_000) {
    return new Promise((resolve) => {
      const internalId = this.#nextInternalId++
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(internalId)
        resolve({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32000, message: 'Request timed out waiting for server response' },
        })
      }, timeoutMs)

      this.#pendingRequests.set(internalId, {
        originalId: request.id,
        resolve,
        timer,
      })

      this.#writeToStdin({ ...request, id: internalId })
    })
  }

  /**
   * Gracefully shut down the server process.
   */
  async shutdown() {
    const prevState = this.state
    this.state = 'stopped'

    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = null
    }

    // Reject pending requests
    for (const [id, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer)
      pending.resolve({
        jsonrpc: '2.0',
        id: pending.originalId,
        error: { code: -32000, message: 'Server shutting down' },
      })
    }
    this.#pendingRequests.clear()

    if (!this.process) return

    const child = this.process
    if (this.#crashHandler) {
      child.removeListener('exit', this.#crashHandler)
    }

    // Close stdin to signal EOF
    try { child.stdin.end() } catch {}

    // Wait for process to exit, escalate if needed
    await new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try { child.kill('SIGTERM') } catch {}
        setTimeout(() => {
          try { child.kill('SIGKILL') } catch {}
          resolve()
        }, 3000)
      }, 5000)

      child.once('exit', () => {
        clearTimeout(killTimer)
        resolve()
      })
    })

    this.process = null
    this.#stdoutBuffer = ''
  }

  #processStdoutBuffer() {
    let newlineIdx
    while ((newlineIdx = this.#stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.#stdoutBuffer.slice(0, newlineIdx)
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIdx + 1)
      if (!line.trim()) continue

      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        log.warn(`Unparseable stdout line`, { server: this.config.name, line })
        continue
      }

      // Response (has id + result/error)
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
        const pending = this.#pendingRequests.get(msg.id)
        if (pending) {
          this.#pendingRequests.delete(msg.id)
          clearTimeout(pending.timer)
          this.requestsServed++
          // Restore original ID
          pending.resolve({ ...msg, id: pending.originalId })
        } else {
          log.warn(`Response for unknown request id`, { server: this.config.name, id: msg.id })
        }
      }
      // Notifications (method, no id) — currently ignored at broker level
      // Server-to-client requests (id + method) — currently ignored
    }
  }

  #writeToStdin(msg) {
    this.#writeQueue.push(JSON.stringify(msg) + '\n')
    this.#drainWriteQueue()
  }

  #drainWriteQueue() {
    if (this.#writing || this.#writeQueue.length === 0) return
    if (!this.process?.stdin?.writable) return

    this.#writing = true
    const data = this.#writeQueue.shift()
    this.process.stdin.write(data, (err) => {
      this.#writing = false
      if (err) {
        log.error(`Stdin write error`, { server: this.config.name, error: err.message })
      }
      this.#drainWriteQueue()
    })
  }

  #handleCrash() {
    this.process = null
    this.state = 'failed'
    this.consecutiveFailures++

    // Reject pending requests
    for (const [, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer)
      pending.resolve({
        jsonrpc: '2.0',
        id: pending.originalId,
        error: { code: -32000, message: 'Server crashed, request lost' },
      })
    }
    this.#pendingRequests.clear()

    if (this.consecutiveFailures >= this.config.maxRestarts) {
      log.error(`Server exceeded max restarts, stopping`, {
        server: this.config.name,
        consecutiveFailures: this.consecutiveFailures,
      })
      this.state = 'stopped'
      return
    }

    const backoff = Math.min(
      this.config.restartBackoffMs * 2 ** (this.consecutiveFailures - 1),
      30_000
    )
    log.info(`Restarting server after ${backoff}ms`, {
      server: this.config.name,
      attempt: this.consecutiveFailures,
    })

    if (this.#restartTimer) clearTimeout(this.#restartTimer)
    this.#restartTimer = setTimeout(async () => {
      try {
        await this.spawnAndInitialize()
        log.info(`Server restarted successfully`, { server: this.config.name })
      } catch (err) {
        log.error(`Server restart failed`, { server: this.config.name, error: err.message })
        this.#handleCrash()
      }
    }, backoff)
  }
}
