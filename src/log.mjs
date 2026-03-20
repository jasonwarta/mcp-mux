/**
 * Structured JSON logger for mcp-mux.
 * Writes to stderr (shim) or a log file (broker).
 */

let _output = process.stderr

/**
 * Set the output stream for logging.
 * @param {import('node:stream').Writable} stream
 */
export function setLogOutput(stream) {
  _output = stream
}

/**
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {string} msg
 * @param {Record<string, unknown>} [fields]
 */
function write(level, msg, fields = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  }
  _output.write(JSON.stringify(entry) + '\n')
}

export const log = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields),
}
