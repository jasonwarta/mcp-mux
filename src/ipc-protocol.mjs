/**
 * IPC protocol for shim ↔ broker communication.
 * Messages are newline-delimited JSON over a local socket.
 */

/**
 * Create a line-buffered message reader from a socket.
 * Calls `onMessage` for each complete JSON line received.
 * @param {import('node:net').Socket} socket
 * @param {(msg: object) => void} onMessage
 * @returns {{ destroy: () => void }}
 */
export function createMessageReader(socket, onMessage) {
  let buffer = ''

  function onData(chunk) {
    buffer += chunk.toString('utf-8')
    let newlineIdx
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx)
      buffer = buffer.slice(newlineIdx + 1)
      if (line.trim()) {
        try {
          const result = onMessage(JSON.parse(line))
          if (result && typeof result.then === 'function') {
            result.catch((err) => {
              process.stderr.write(JSON.stringify({ level: 'error', msg: 'onMessage error', err: String(err) }) + '\n')
            })
          }
        } catch {
          // skip malformed lines
        }
      }
    }
  }

  socket.on('data', onData)

  return {
    destroy() {
      socket.removeListener('data', onData)
      buffer = ''
    },
  }
}

/**
 * Send a message over a socket.
 * @param {import('node:net').Socket} socket
 * @param {object} msg
 */
export function sendMessage(socket, msg) {
  socket.write(JSON.stringify(msg) + '\n')
}
