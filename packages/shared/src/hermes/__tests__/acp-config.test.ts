import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { buildHermesAcpMcpServers, normalizeHermesRuntimeConfig, sdkMcpServerToHermesAcp } from '../acp-config.ts'

const HERMES_ENV_KEYS = [
  'CRAFT_HERMES_PYTHON',
  'CRAFT_HERMES_ARGS',
  'CRAFT_HERMES_HOME',
  'CRAFT_HERMES_COMMAND',
  'HERMES_HOME',
] as const

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(HERMES_ENV_KEYS.map((key) => [key, process.env[key]]))
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

describe('Hermes ACP config', () => {
  let envSnapshot: Record<string, string | undefined> = {}

  beforeEach(() => {
    envSnapshot = snapshotEnv()
    for (const key of HERMES_ENV_KEYS) delete process.env[key]
  })

  afterEach(() => {
    restoreEnv(envSnapshot)
  })

  it('uses hermes acp as the default ACP command', () => {
    const runtime = normalizeHermesRuntimeConfig({ hermesHome: '/tmp/hermes-home' })

    expect(runtime.command).toBe('hermes')
    expect(runtime.args).toEqual(['acp'])
    expect(runtime.hermesHome).toBe('/tmp/hermes-home')
  })

  it('uses the bundled Python runtime when CRAFT_HERMES_PYTHON/ARGS are set', () => {
    process.env.CRAFT_HERMES_PYTHON = '/Applications/Craft Agents.app/Contents/Resources/app/vendor/hermes/hermes-venv/bin/python3'
    process.env.CRAFT_HERMES_ARGS = JSON.stringify(['-m', 'acp_adapter'])
    process.env.CRAFT_HERMES_HOME = '/Users/test/Library/Application Support/craft-agent/hermes'

    const runtime = normalizeHermesRuntimeConfig()

    expect(runtime.command).toBe('/Applications/Craft Agents.app/Contents/Resources/app/vendor/hermes/hermes-venv/bin/python3')
    expect(runtime.args).toEqual(['-m', 'acp_adapter'])
    expect(runtime.hermesHome).toBe('/Users/test/Library/Application Support/craft-agent/hermes')
    expect(runtime.configPath).toBe('/Users/test/Library/Application Support/craft-agent/hermes/config.yaml')
    expect(runtime.envPath).toBe('/Users/test/Library/Application Support/craft-agent/hermes/.env')
  })

  it('keeps acp args for an external hermes binary even when CRAFT_HERMES_ARGS is bundled', () => {
    process.env.CRAFT_HERMES_PYTHON = '/bundled/python3'
    process.env.CRAFT_HERMES_ARGS = JSON.stringify(['-m', 'acp_adapter'])

    const runtime = normalizeHermesRuntimeConfig({ command: 'hermes' })

    expect(runtime.command).toBe('hermes')
    expect(runtime.args).toEqual(['acp'])
  })

  it('explicit runtime.args win over CRAFT_HERMES_ARGS', () => {
    process.env.CRAFT_HERMES_PYTHON = '/bundled/python3'
    process.env.CRAFT_HERMES_ARGS = JSON.stringify(['-m', 'acp_adapter'])

    const runtime = normalizeHermesRuntimeConfig({ args: ['acp', '--debug'] })

    expect(runtime.command).toBe('/bundled/python3')
    expect(runtime.args).toEqual(['acp', '--debug'])
  })

  it('CRAFT_HERMES_HOME beats HERMES_HOME', () => {
    process.env.CRAFT_HERMES_HOME = '/app-scoped'
    process.env.HERMES_HOME = '/global'

    const runtime = normalizeHermesRuntimeConfig()
    expect(runtime.hermesHome).toBe('/app-scoped')
  })

  it('maps Craft HTTP MCP configs to ACP mcpServers shape', () => {
    const server = sdkMcpServerToHermesAcp('github', {
      type: 'http',
      url: 'http://127.0.0.1:3210/mcp',
      headers: { Authorization: 'Bearer token' },
    })

    expect(server).toEqual({
      type: 'http',
      name: 'github',
      url: 'http://127.0.0.1:3210/mcp',
      headers: [{ name: 'Authorization', value: 'Bearer token' }],
    })
  })

  it('maps Craft stdio MCP configs to ACP mcpServers shape', () => {
    const server = sdkMcpServerToHermesAcp('local-tool', {
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { FOO: 'bar' },
    })

    expect(server).toEqual({
      type: 'stdio',
      name: 'local-tool',
      command: 'node',
      args: ['server.js'],
      env: [{ name: 'FOO', value: 'bar' }],
    })
  })

  it('prefers the Craft pool HTTP endpoint for external Hermes ACP source tools', () => {
    const servers = buildHermesAcpMcpServers({
      poolServerUrl: 'http://127.0.0.1:45123/mcp',
      mcpServers: {
        direct: { type: 'http', url: 'http://example.test/mcp' },
      },
    })

    expect(servers).toEqual([
      { type: 'http', name: 'craft-sources', url: 'http://127.0.0.1:45123/mcp', headers: [] },
    ])
  })

  it('adds the Craft session tools MCP server alongside pooled source tools', () => {
    const servers = buildHermesAcpMcpServers({
      poolServerUrl: 'http://127.0.0.1:45123/mcp',
      sessionToolsServerUrl: 'http://127.0.0.1:45124/mcp',
      mcpServers: {
        direct: { type: 'http', url: 'http://example.test/mcp' },
      },
    })

    expect(servers).toEqual([
      { type: 'http', name: 'craft-sources', url: 'http://127.0.0.1:45123/mcp', headers: [] },
      { type: 'http', name: 'craft-session', url: 'http://127.0.0.1:45124/mcp', headers: [] },
    ])
  })

  it('adds Craft session tools without dropping direct MCP configs when no pool endpoint exists', () => {
    const servers = buildHermesAcpMcpServers({
      sessionToolsServerUrl: 'http://127.0.0.1:45124/mcp',
      mcpServers: {
        direct: { type: 'http', url: 'http://example.test/mcp' },
      },
    })

    expect(servers).toEqual([
      { type: 'http', name: 'direct', url: 'http://example.test/mcp', headers: [] },
      { type: 'http', name: 'craft-session', url: 'http://127.0.0.1:45124/mcp', headers: [] },
    ])
  })
})
