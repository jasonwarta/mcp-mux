import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { loadConfig, deriveSocketPath } from '../src/config.mjs'

let tempDir

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mcp-mux-config-test-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('loadConfig', () => {
  it('loads a valid config file', () => {
    const configPath = join(tempDir, '.mcp-mux.json')
    writeFileSync(configPath, JSON.stringify({
      servers: {
        'test-server': {
          command: 'node',
          args: ['server.js'],
        },
      },
    }))

    const { config } = loadConfig(configPath)
    assert.equal(typeof config.servers['test-server'], 'object')
    assert.equal(config.servers['test-server'].command, 'node')
    assert.deepEqual(config.servers['test-server'].args, ['server.js'])
    assert.equal(config.servers['test-server'].mode, 'shared')
    assert.equal(config.servers['test-server'].lazy, false)
    assert.equal(config.servers['test-server'].maxRestarts, 5)
    assert.equal(config.servers['test-server'].restartBackoffMs, 1000)
  })

  it('applies server defaults', () => {
    const configPath = join(tempDir, '.mcp-mux.json')
    writeFileSync(configPath, JSON.stringify({
      servers: {
        'my-server': {
          command: 'echo',
          mode: 'per-session',
          lazy: true,
        },
      },
    }))

    const { config } = loadConfig(configPath)
    const s = config.servers['my-server']
    assert.equal(s.mode, 'per-session')
    assert.equal(s.lazy, true)
    assert.equal(s.maxRestarts, 5)
    assert.deepEqual(s.args, [])
  })

  it('throws on missing servers key', () => {
    const configPath = join(tempDir, '.mcp-mux.json')
    writeFileSync(configPath, JSON.stringify({ foo: 'bar' }))

    assert.throws(() => loadConfig(configPath), /servers/)
  })

  it('throws on server missing command', () => {
    const configPath = join(tempDir, '.mcp-mux.json')
    writeFileSync(configPath, JSON.stringify({
      servers: { bad: { args: ['x'] } },
    }))

    assert.throws(() => loadConfig(configPath), /command/)
  })

  it('throws on invalid server name', () => {
    const configPath = join(tempDir, '.mcp-mux.json')
    writeFileSync(configPath, JSON.stringify({
      servers: { 'Bad Name!': { command: 'echo' } },
    }))

    assert.throws(() => loadConfig(configPath), /must match/)
  })

  it('throws on missing config file', () => {
    assert.throws(() => loadConfig(join(tempDir, 'nope.json')), /Cannot read/)
  })

  it('throws on invalid JSON', () => {
    const configPath = join(tempDir, '.mcp-mux.json')
    writeFileSync(configPath, '{bad json')

    assert.throws(() => loadConfig(configPath), /Invalid JSON/)
  })

  it('sets default idleTimeoutMs and requestTimeoutMs', () => {
    const configPath = join(tempDir, '.mcp-mux.json')
    writeFileSync(configPath, JSON.stringify({
      servers: { s: { command: 'echo' } },
    }))

    const { config } = loadConfig(configPath)
    assert.equal(config.idleTimeoutMs, 300_000)
    assert.equal(config.requestTimeoutMs, 60_000)
  })
})

describe('deriveSocketPath', () => {
  it('returns a path containing the config hash', () => {
    const p1 = deriveSocketPath('/a/b/.mcp-mux.json')
    const p2 = deriveSocketPath('/c/d/.mcp-mux.json')

    assert.notEqual(p1, p2)

    if (process.platform === 'win32') {
      assert.match(p1, /\/\/\.\/pipe\/mcp-mux-[a-f0-9]{8}/)
    } else {
      assert.match(p1, /mcp-mux-[a-f0-9]{8}\.sock$/)
    }
  })

  it('returns the same path for the same config', () => {
    const p1 = deriveSocketPath('/same/path/.mcp-mux.json')
    const p2 = deriveSocketPath('/same/path/.mcp-mux.json')
    assert.equal(p1, p2)
  })
})
