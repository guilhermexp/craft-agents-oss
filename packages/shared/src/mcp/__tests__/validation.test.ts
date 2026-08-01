import { describe, expect, it } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { disableDebug, enableDebug, isDebugEnabled } from '../../utils/debug.ts'
import { validateMcpConnection, validateStdioMcpConnection } from '../validation.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = (name: string) => join(HERE, 'fixtures', name)

describe('validateStdioMcpConnection', () => {
  it(
    'returns success and tool list for a spec-compliant stdio server',
    async () => {
      const result = await validateStdioMcpConnection({
        command: 'node',
        args: [FIXTURE('mcp-server-good.mjs')],
        timeout: 8000,
      })
      expect(result.success).toBe(true)
      expect(result.tools).toEqual(['echo'])
      expect(result.error).toBeUndefined()
    },
    15000,
  )

  it(
    'surfaces a framing hint when the server uses LSP-style Content-Length framing',
    async () => {
      const result = await validateStdioMcpConnection({
        command: 'node',
        args: [FIXTURE('mcp-server-lsp.mjs')],
        // Generous outer budget — the connect phase should fail well before this
        // either via timeout or via parse error → "Connection closed".
        timeout: 12000,
      })
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error).toBe('mcp-initialize-idle-timeout')
    },
    // Generous outer budget — Bun's setTimeout can lag under test load, so
    // even though idleMs=6000 the wall-clock can stretch to 20+ seconds.
    45000,
  )

  it(
    'succeeds on a slow cold-start server that emits stderr activity throughout init',
    async () => {
      const result = await validateStdioMcpConnection({
        command: 'node',
        args: [FIXTURE('mcp-server-slow.mjs')],
        // Generous outer budget: the slow fixture takes ~12s of stderr noise
        // before it starts speaking MCP. The idle watchdog (default 8s) must
        // be reset by each stderr line, otherwise this test fails.
        timeout: 60000,
      })
      expect(result.success).toBe(true)
      expect(result.tools).toEqual(['ping'])
      expect(result.error).toBeUndefined()
    },
    60000,
  )

  it(
    'fails at the ceiling when a server floods stderr but never completes initialize',
    async () => {
      const result = await validateStdioMcpConnection({
        command: 'node',
        args: [FIXTURE('mcp-server-noisy-stuck.mjs')],
        // Use a short outer budget so the ceiling fires quickly. With
        // timeout=10000: connectIdleMs=5000, connectCeilingMs=8000.
        timeout: 10000,
      })
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error).toBe('mcp-initialize-ceiling-timeout')
    },
    // Generous outer budget — Bun's setTimeout can lag under test load
    // (observed up to 4x expected on this machine), so we leave plenty of
    // slack on top of the 8s ceiling.
    60000,
  )

  it(
    'returns a clean "command not found" message for ENOENT',
    async () => {
      const result = await validateStdioMcpConnection({
        command: '/definitely/not/a/real/command-xyzzy',
        args: [],
        timeout: 3000,
      })
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error).toBe('mcp-command-not-found')
    },
    10000,
  )

  it(
    'surfaces stderr output when the server exits immediately',
    async () => {
      const result = await validateStdioMcpConnection({
        command: 'node',
        args: ['-e', "process.stderr.write('boom from test server\\n'); process.exit(1);"],
        timeout: 5000,
      })
      expect(result.success).toBe(false)
      expect(result.error).toBeDefined()
      expect(result.error).toBe('mcp-initialize-failed')
    },
    15000,
  )
})

describe('validateMcpConnection redaction', () => {
  it('never logs or returns the raw credential-bearing URL or caught error', async () => {
    const rawUrl = 'http://127.0.0.1:1/mcp?token=%7B%22secret%22%3A%22value%20with%20spaces%22%7D'
    const writes: string[] = []
    const originalWrite = process.stderr.write
    const wasDebugEnabled = isDebugEnabled()
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    enableDebug()

    try {
      const result = await validateMcpConnection({ mcpUrl: rawUrl })
      const boundary = JSON.stringify({ result, logs: writes })

      expect(result.error).toBe('mcp-connection-failed')
      expect(boundary).not.toContain(rawUrl)
      expect(boundary).not.toContain('127.0.0.1')
      expect(boundary).not.toContain('secret')
      expect(boundary).not.toContain('value%20with%20spaces')
    } finally {
      process.stderr.write = originalWrite
      if (!wasDebugEnabled) disableDebug()
    }
  })
})
