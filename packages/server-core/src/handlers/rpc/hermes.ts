import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { execFile as execFileCb } from 'node:child_process'
import net from 'node:net'

import {
  RPC_CHANNELS,
  type HermesDashboardResult,
  type HermesDetectionResult,
} from '@craft-agent/shared/protocol'
import { normalizeHermesRuntimeConfig, type NormalizedHermesRuntimeConfig } from '@craft-agent/shared/hermes/acp-config'
import { parseHermesConfigSnapshot } from '@craft-agent/shared/hermes/runtime-config'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

const execFile = promisify(execFileCb)

let dashboardProcess: ChildProcess | null = null
let dashboardUrl: string | null = null
let dashboardPort: number | null = null

function isBundledRuntime(runtime: NormalizedHermesRuntimeConfig): boolean {
  const bundledPython = process.env.CRAFT_HERMES_PYTHON?.trim()
  return Boolean(bundledPython && runtime.command === bundledPython)
}

async function resolveHermesBinary(command: string): Promise<string | undefined> {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined

  try {
    const lookup = process.platform === 'win32'
      ? await execFile('where', [command])
      : await execFile('sh', ['-lc', `command -v ${command}`])

    return lookup.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean)
  } catch {
    return undefined
  }
}

function buildHermesEnv(runtime: NormalizedHermesRuntimeConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HERMES_HOME: runtime.hermesHome,
  }

  const agentRoot = process.env.CRAFT_HERMES_AGENT_ROOT?.trim()
  if (agentRoot) {
    env.PYTHONPATH = env.PYTHONPATH ? `${agentRoot}${process.platform === 'win32' ? ';' : ':'}${env.PYTHONPATH}` : agentRoot
  }

  const pathEntries: string[] = []
  const virtualEnv = process.env.CRAFT_HERMES_VIRTUAL_ENV?.trim()
  if (virtualEnv) {
    env.VIRTUAL_ENV = virtualEnv
    pathEntries.push(join(virtualEnv, process.platform === 'win32' ? 'Scripts' : 'bin'))
  }
  const vendorBin = process.env.CRAFT_HERMES_VENDOR_BIN?.trim()
  if (vendorBin) pathEntries.push(vendorBin)

  if (pathEntries.length > 0) {
    const sep = process.platform === 'win32' ? ';' : ':'
    env.PATH = `${pathEntries.join(sep)}${sep}${env.PATH ?? ''}`
  }

  return env
}

async function resolveHermesVersion(runtime: NormalizedHermesRuntimeConfig): Promise<string | undefined> {
  try {
    if (isBundledRuntime(runtime)) {
      const { stdout, stderr } = await execFile(runtime.command, ['-c', 'from hermes_cli import __version__; print(__version__)'], {
        env: buildHermesEnv(runtime),
      })
      return [stdout, stderr]
        .join('\n')
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(Boolean)
    }

    const { stdout, stderr } = await execFile(runtime.command, ['--version'], {
      env: buildHermesEnv(runtime),
    })
    return [stdout, stderr]
      .join('\n')
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(Boolean)
  } catch {
    return undefined
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('Unable to allocate a localhost port'))
      })
    })
  })
}

function waitForPort(port: number, timeoutMs = 12_000): Promise<void> {
  const started = Date.now()

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - started >= timeoutMs) {
          reject(new Error(`Hermes dashboard did not start on port ${port}`))
          return
        }
        setTimeout(attempt, 200)
      })
    }
    attempt()
  })
}

function buildDashboardCommand(runtime: NormalizedHermesRuntimeConfig, port: number): { command: string; args: string[] } {
  const commonArgs = ['dashboard', '--host', '127.0.0.1', '--port', String(port), '--no-open']

  if (isBundledRuntime(runtime)) {
    return {
      command: runtime.command,
      args: ['-m', 'hermes_cli.main', ...commonArgs],
    }
  }

  return {
    command: runtime.command,
    args: commonArgs,
  }
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.hermes.DETECT_INSTALLATION,
  RPC_CHANNELS.hermes.START_DASHBOARD,
] as const

export function registerHermesHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.hermes.DETECT_INSTALLATION, async (): Promise<HermesDetectionResult> => {
    const runtime = normalizeHermesRuntimeConfig()
    const resolvedCommand = await resolveHermesBinary(runtime.command)
    const runtimeSource = isBundledRuntime(runtime) ? 'bundled' : 'system'

    const rawConfig = existsSync(runtime.configPath)
      ? await readFile(runtime.configPath, 'utf-8')
      : ''
    const configSnapshot = parseHermesConfigSnapshot(rawConfig)
    const models = Array.from(
      new Set(
        [configSnapshot.defaultModel, configSnapshot.fallbackModel, ...configSnapshot.customProviders.map(provider => provider.model)]
          .filter((model): model is string => Boolean(model)),
      ),
    )

    if (!resolvedCommand) {
      return {
        found: false,
        command: runtime.command,
        runtimeSource,
        hermesHome: runtime.hermesHome,
        configPath: runtime.configPath,
        envPath: runtime.envPath,
        providers: configSnapshot.providers,
        models,
        customProviders: configSnapshot.customProviders,
        error: `Hermes runtime not found: ${runtime.command}`,
      }
    }

    deps.platform.logger?.info?.('[Hermes] Runtime detection complete', {
      found: true,
      runtimeSource,
      resolvedCommand,
      configPath: runtime.configPath,
      providerCount: configSnapshot.providers.length,
      modelCount: models.length,
    })

    return {
      found: true,
      command: runtime.command,
      resolvedCommand,
      runtimeSource,
      version: await resolveHermesVersion(runtime),
      hermesHome: runtime.hermesHome,
      configPath: runtime.configPath,
      envPath: runtime.envPath,
      defaultModel: configSnapshot.defaultModel,
      fallbackModel: configSnapshot.fallbackModel,
      providers: configSnapshot.providers,
      models,
      customProviders: configSnapshot.customProviders,
      dashboardUrl: dashboardUrl ?? undefined,
    }
  })

  server.handle(RPC_CHANNELS.hermes.START_DASHBOARD, async (): Promise<HermesDashboardResult> => {
    const runtime = normalizeHermesRuntimeConfig()
    const resolvedCommand = await resolveHermesBinary(runtime.command)
    if (!resolvedCommand) {
      return { success: false, error: `Hermes runtime not found: ${runtime.command}` }
    }

    if (dashboardProcess && dashboardProcess.exitCode === null && !dashboardProcess.killed && dashboardUrl && dashboardPort) {
      return {
        success: true,
        url: dashboardUrl,
        port: dashboardPort,
        pid: dashboardProcess.pid,
      }
    }

    const port = await findFreePort()
    const { command, args } = buildDashboardCommand(runtime, port)
    const child = spawn(command, args, {
      env: buildHermesEnv(runtime),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr?.on('data', chunk => {
      stderr += String(chunk)
      deps.platform.logger.debug(`[Hermes dashboard] ${String(chunk).trim()}`)
    })
    child.stdout?.on('data', chunk => {
      deps.platform.logger.debug(`[Hermes dashboard] ${String(chunk).trim()}`)
    })
    child.once('exit', (code, signal) => {
      deps.platform.logger?.info?.('[Hermes] Dashboard exited', { code, signal })
      if (dashboardProcess === child) {
        dashboardProcess = null
        dashboardUrl = null
        dashboardPort = null
      }
    })

    try {
      await Promise.race([
        waitForPort(port),
        new Promise<never>((_resolve, reject) => {
          child.once('error', reject)
          child.once('exit', (code) => reject(new Error(stderr.trim() || `Hermes dashboard exited with code ${code}`)))
        }),
      ])
    } catch (err) {
      if (!child.killed) child.kill()
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    if (child.exitCode !== null) {
      return {
        success: false,
        error: stderr.trim() || `Hermes dashboard exited with code ${child.exitCode}`,
      }
    }

    dashboardProcess = child
    dashboardPort = port
    dashboardUrl = `http://127.0.0.1:${port}`

    return {
      success: true,
      url: dashboardUrl,
      port,
      pid: child.pid,
    }
  })
}
