import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'

const CONFIG_FILENAME = '.mcp-mux.json'

const SERVER_DEFAULTS = {
  mode: 'shared',
  lazy: false,
  maxRestarts: 5,
  restartBackoffMs: 1000,
}

/**
 * Find the project root by walking up from cwd looking for .mcp-mux.json.
 * @param {string} [startDir] - Directory to start searching from. Defaults to cwd.
 */
function findProjectRoot(startDir = process.cwd()) {
  let dir = resolve(startDir)
  let prev = null

  while (dir !== prev) {
    try {
      readFileSync(resolve(dir, CONFIG_FILENAME))
      return dir
    } catch {
      // try parent
    }
    prev = dir
    dir = dirname(dir)
  }
  throw new Error(
    `Could not find ${CONFIG_FILENAME} in ${startDir} or any parent directory. ` +
    `Create one or pass --config <path>.`
  )
}

/**
 * Load and validate config from .mcp-mux.json.
 * @param {string} [configPath] - Explicit path to config file, or auto-detect.
 * @returns {{ configPath: string, config: object, projectRoot: string }}
 */
export function loadConfig(configPath) {
  let projectRoot
  if (configPath) {
    configPath = resolve(configPath)
    projectRoot = dirname(configPath)
  } else {
    projectRoot = findProjectRoot()
    configPath = resolve(projectRoot, CONFIG_FILENAME)
  }

  let raw
  try {
    raw = readFileSync(configPath, 'utf-8')
  } catch (err) {
    throw new Error(`Cannot read config file ${configPath}: ${err.message}`)
  }

  let config
  try {
    config = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid JSON in ${configPath}: ${err.message}`)
  }

  if (!config.servers || typeof config.servers !== 'object') {
    throw new Error(`Config must have a "servers" object`)
  }

  // Apply defaults to each server
  for (const [name, server] of Object.entries(config.servers)) {
    if (!server.command) {
      throw new Error(`Server "${name}" must have a "command" field`)
    }
    if (!Array.isArray(server.args)) {
      server.args = []
    }
    config.servers[name] = { ...SERVER_DEFAULTS, name, ...server }
  }

  // Validate server names
  const namePattern = /^[a-z0-9][a-z0-9-]*$/
  for (const name of Object.keys(config.servers)) {
    if (!namePattern.test(name)) {
      throw new Error(
        `Server name "${name}" must match /^[a-z0-9][a-z0-9-]*$/`
      )
    }
  }

  config.idleTimeoutMs = config.idleTimeoutMs ?? 300_000
  config.requestTimeoutMs = config.requestTimeoutMs ?? 60_000

  return { configPath, config, projectRoot }
}

/**
 * Compute the hash used for socket/file naming.
 * @param {string} configPath - Absolute path to the config file.
 * @returns {string} 8-char hex hash.
 */
function configHash(configPath) {
  return createHash('sha256')
    .update(resolve(configPath))
    .digest('hex')
    .slice(0, 8)
}

/**
 * Derive the socket path from the config file path.
 * @param {string} configPath - Absolute path to the config file.
 * @returns {string}
 */
export function deriveSocketPath(configPath) {
  const hash = configHash(configPath)

  if (process.platform === 'win32') {
    return `//./pipe/mcp-mux-${hash}`
  }

  const runtimeDir = process.env.XDG_RUNTIME_DIR || '/tmp'
  return resolve(runtimeDir, `mcp-mux-${hash}.sock`)
}

/**
 * Derive the PID file path from the config file path.
 * On Windows, named pipes can't have sibling files, so we use a temp directory.
 * @param {string} configPath
 * @returns {string}
 */
export function derivePidPath(configPath) {
  const hash = configHash(configPath)
  if (process.platform === 'win32') {
    return resolve(process.env.TEMP || tmpdir(), `mcp-mux-${hash}.pid`)
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR || '/tmp'
  return resolve(runtimeDir, `mcp-mux-${hash}.pid`)
}

/**
 * Derive the log file path from the config file path.
 * @param {string} configPath
 * @returns {string}
 */
export function deriveLogPath(configPath) {
  const hash = configHash(configPath)
  if (process.platform === 'win32') {
    return resolve(process.env.TEMP || tmpdir(), `mcp-mux-${hash}.log`)
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR || '/tmp'
  return resolve(runtimeDir, `mcp-mux-${hash}.log`)
}
