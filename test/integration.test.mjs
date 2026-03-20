import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

function createMockServer(dir, name, tools) {
  const scriptPath = join(dir, `${name}.mjs`)
  writeFileSync(scriptPath, `
    process.stdin.setEncoding('utf-8')
    let buf = ''
    process.stdin.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\\n')) !== -1) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        handleMessage(msg)
      }
    })

    const tools = ${JSON.stringify(tools)}

    function handleMessage(msg) {
      if (msg.method === 'initialize') {
        respond(msg.id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: '${name}', version: '1.0.0' },
        })
      } else if (msg.method === 'notifications/initialized') {
        // no response
      } else if (msg.method === 'tools/list') {
        respond(msg.id, { tools })
      } else if (msg.method === 'tools/call') {
        const toolName = msg.params?.name
        const args = msg.params?.arguments || {}
        respond(msg.id, {
          content: [{ type: 'text', text: 'Called ' + toolName + ' with ' + JSON.stringify(args) }],
          isError: false,
        })
      } else if (msg.id != null) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Unknown method: ' + msg.method },
        }) + '\\n')
      }
    }

    function respond(id, result) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n')
    }
  `)
  return scriptPath
}

function spawnShim(configPath) {
  const shimPath = resolve(__dirname, '..', 'src', 'shim.mjs')
  const child = spawn(process.execPath, [shimPath, '--config', configPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: dirname(configPath),
  })

  let stdoutBuf = ''
  const messages = []
  const waiters = []

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf-8')
    let idx
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx)
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      messages.push(msg)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].check(msg)) {
          waiters[i].resolve(msg)
          waiters.splice(i, 1)
        }
      }
    }
  })

  let stderrOut = ''
  child.stderr.on('data', (chunk) => {
    stderrOut += chunk.toString('utf-8')
  })

  return {
    child,
    send(msg) {
      child.stdin.write(JSON.stringify(msg) + '\n')
    },
    waitFor(check, timeoutMs = 15_000) {
      for (const msg of messages) {
        if (check(msg)) return Promise.resolve(msg)
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for message. stderr: ${stderrOut}`))
        }, timeoutMs)
        waiters.push({
          check,
          resolve: (msg) => {
            clearTimeout(timer)
            resolve(msg)
          },
        })
      })
    },
    async close() {
      child.stdin.end()
      await new Promise((r) => {
        child.on('exit', r)
        setTimeout(() => { try { child.kill() } catch {} ; r() }, 3000)
      })
    },
    get stderr() { return stderrOut },
  }
}

async function stopBroker(configPath) {
  const shimPath = resolve(__dirname, '..', 'src', 'shim.mjs')
  const child = spawn(process.execPath, [shimPath, 'stop', '--config', configPath], {
    stdio: 'pipe',
    cwd: dirname(configPath),
  })
  await new Promise((r) => child.on('exit', r))
  // Wait for socket to be released
  await new Promise((r) => setTimeout(r, 500))
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

describe('integration: shim + broker + mock server', () => {
  const tempDirs = []

  function makeTempDir() {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-mux-integ-'))
    tempDirs.push(dir)
    return dir
  }

  after(async () => {
    // Stop all brokers
    for (const dir of tempDirs) {
      const configPath = join(dir, '.mcp-mux.json')
      try { await stopBroker(configPath) } catch {}
    }
    await sleep(1000)
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })

  it('full round-trip: initialize → tools/list → tools/call', async () => {
    const tempDir = makeTempDir()

    const server1Path = createMockServer(tempDir, 'mock-alpha', [
      {
        name: 'alpha-greet',
        description: 'Greet someone (alpha)',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
    ])

    const server2Path = createMockServer(tempDir, 'mock-beta', [
      {
        name: 'beta-compute',
        description: 'Compute something (beta)',
        inputSchema: {
          type: 'object',
          properties: { x: { type: 'number' } },
        },
      },
    ])

    const configPath = join(tempDir, '.mcp-mux.json')
    writeFileSync(configPath, JSON.stringify({
      servers: {
        'mock-alpha': {
          command: process.execPath,
          args: [server1Path],
        },
        'mock-beta': {
          command: process.execPath,
          args: [server2Path],
        },
      },
    }))

    const shim = spawnShim(configPath)

    try {
      shim.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      })

      const initResp = await shim.waitFor((m) => m.id === 1)
      assert.equal(initResp.result.protocolVersion, '2025-11-25')
      assert.equal(initResp.result.serverInfo.name, 'mcp-mux')

      shim.send({ jsonrpc: '2.0', method: 'notifications/initialized' })

      shim.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      const toolsResp = await shim.waitFor((m) => m.id === 2)
      assert.ok(Array.isArray(toolsResp.result.tools))
      assert.equal(toolsResp.result.tools.length, 2)

      const toolNames = toolsResp.result.tools.map((t) => t.name).sort()
      assert.deepEqual(toolNames, ['mock-alpha__alpha-greet', 'mock-beta__beta-compute'])

      shim.send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'mock-alpha__alpha-greet', arguments: { name: 'World' } },
      })

      const callResp = await shim.waitFor((m) => m.id === 3)
      assert.ok(callResp.result)
      assert.equal(callResp.result.isError, false)
      assert.ok(callResp.result.content[0].text.includes('alpha-greet'))
      assert.ok(callResp.result.content[0].text.includes('World'))

      shim.send({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'mock-beta__beta-compute', arguments: { x: 42 } },
      })

      const callResp2 = await shim.waitFor((m) => m.id === 4)
      assert.ok(callResp2.result)
      assert.ok(callResp2.result.content[0].text.includes('beta-compute'))
    } finally {
      await shim.close()
    }
  })

  it('two shims share the same broker and backend servers', async () => {
    const tempDir = makeTempDir()

    const serverPath = createMockServer(tempDir, 'mock-shared', [
      {
        name: 'shared-tool',
        description: 'A shared tool',
        inputSchema: { type: 'object', properties: {} },
      },
    ])

    const configPath = join(tempDir, '.mcp-mux.json')
    writeFileSync(configPath, JSON.stringify({
      servers: {
        'mock-shared': {
          command: process.execPath,
          args: [serverPath],
        },
      },
    }))

    const shim1 = spawnShim(configPath)
    const shim2 = spawnShim(configPath)

    try {
      for (const [shim, id] of [[shim1, 10], [shim2, 20]]) {
        shim.send({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        })
        await shim.waitFor((m) => m.id === id)
      }

      // Both call the same tool with the same request id
      shim1.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'mock-shared__shared-tool', arguments: { from: 'shim1' } },
      })

      shim2.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'mock-shared__shared-tool', arguments: { from: 'shim2' } },
      })

      const resp1 = await shim1.waitFor((m) => m.id === 1 && m.result)
      const resp2 = await shim2.waitFor((m) => m.id === 1 && m.result)

      assert.ok(resp1.result.content[0].text.includes('shim1'))
      assert.ok(resp2.result.content[0].text.includes('shim2'))
    } finally {
      await shim1.close()
      await shim2.close()
    }
  })

  it('returns error for unknown tool', async () => {
    const tempDir = makeTempDir()

    const serverPath = createMockServer(tempDir, 'mock-err', [
      {
        name: 'real-tool',
        description: 'A real tool',
        inputSchema: { type: 'object', properties: {} },
      },
    ])

    const configPath = join(tempDir, '.mcp-mux.json')
    writeFileSync(configPath, JSON.stringify({
      servers: {
        'mock-err': {
          command: process.execPath,
          args: [serverPath],
        },
      },
    }))

    const shim = spawnShim(configPath)

    try {
      shim.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      })
      await shim.waitFor((m) => m.id === 1)

      shim.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'nonexistent-tool', arguments: {} },
      })

      const resp = await shim.waitFor((m) => m.id === 2)
      assert.ok(resp.error)
      assert.ok(resp.error.message.includes('nonexistent-tool'))
    } finally {
      await shim.close()
    }
  })
})
