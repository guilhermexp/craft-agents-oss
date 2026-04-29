import { existsSync } from 'node:fs'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { execFile as execFileCb } from 'node:child_process'
import net from 'node:net'

import {
  RPC_CHANNELS,
  type HermesDashboardResult,
  type HermesDetectionResult,
  type HermesHomeFileInfo,
  type HermesListHomeFilesResult,
  type HermesListLogsResult,
  type HermesListSkillsResult,
  type HermesLogFileInfo,
  type HermesOpenPathResult,
  type HermesReadLogResult,
  type HermesRuntimeDetailsResult,
  type HermesSkillInfo,
  type HermesUpdateResult,
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

async function buildDetectionResult(deps?: HandlerDeps): Promise<HermesDetectionResult> {
  const runtime = normalizeHermesRuntimeConfig()
  const resolvedCommand = await resolveHermesBinary(runtime.command)
  const runtimeSource: HermesDetectionResult['runtimeSource'] = isBundledRuntime(runtime) ? 'bundled' : 'system'

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

  const base = {
    command: runtime.command,
    runtimeSource,
    hermesHome: runtime.hermesHome,
    configPath: runtime.configPath,
    envPath: runtime.envPath,
    providers: configSnapshot.providers,
    models,
    customProviders: configSnapshot.customProviders,
  }

  if (!resolvedCommand) {
    return {
      found: false,
      ...base,
      error: `Hermes runtime not found: ${runtime.command}`,
    }
  }

  deps?.platform.logger?.info?.('[Hermes] Runtime detection complete', {
    found: true,
    runtimeSource,
    resolvedCommand,
    configPath: runtime.configPath,
    providerCount: configSnapshot.providers.length,
    modelCount: models.length,
  })

  return {
    found: true,
    ...base,
    resolvedCommand,
    version: await resolveHermesVersion(runtime),
    defaultModel: configSnapshot.defaultModel,
    fallbackModel: configSnapshot.fallbackModel,
    dashboardUrl: dashboardUrl ?? undefined,
  }
}

function resolveInside(rootPath: string, target = '.'): string {
  const root = resolve(rootPath)
  const resolved = resolve(root, target)
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error('Path escapes Hermes home')
  }
  return resolved
}

async function resolveExistingInside(rootPath: string, target = '.'): Promise<string> {
  const resolved = resolveInside(rootPath, target)
  const [realRoot, realTarget] = await Promise.all([realpath(rootPath), realpath(resolved)])
  if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
    throw new Error('Path escapes Hermes home')
  }
  return resolved
}

async function fileInfo(path: string): Promise<HermesLogFileInfo> {
  const info = await lstat(path)
  return {
    name: basename(path),
    path,
    size: info.size,
    modifiedAt: info.mtimeMs,
  }
}

async function listHermesLogs(runtime: NormalizedHermesRuntimeConfig): Promise<HermesListLogsResult> {
  const logsPath = join(runtime.hermesHome, 'logs')
  if (!existsSync(logsPath)) return { success: true, logsPath, files: [] }

  const entries = await readdir(logsPath, { withFileTypes: true })
  const files = await Promise.all(
    entries
      .filter(entry => entry.isFile())
      .map(entry => fileInfo(join(logsPath, entry.name))),
  )

  files.sort((a, b) => b.modifiedAt - a.modifiedAt)
  return { success: true, logsPath, files }
}

async function listHomeFiles(rootPath: string, target = '.', depth = 2): Promise<HermesHomeFileInfo[]> {
  if (!existsSync(resolveInside(rootPath, target))) return []
  const dirPath = await resolveExistingInside(rootPath, target)

  const entries = await readdir(dirPath, { withFileTypes: true })
  const visible = entries
    .filter(entry => entry.name !== '.env')
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 80)

  const result: HermesHomeFileInfo[] = []
  for (const entry of visible) {
    const path = join(dirPath, entry.name)
    const info = await lstat(path)
    const relativePath = relative(rootPath, path)
    const item: HermesHomeFileInfo = {
      name: entry.name,
      path,
      relativePath,
      type: entry.isDirectory() ? 'directory' : 'file',
      size: entry.isFile() ? info.size : undefined,
      modifiedAt: info.mtimeMs,
    }
    if (entry.isDirectory() && depth > 1) {
      item.children = await listHomeFiles(rootPath, relativePath, depth - 1)
    }
    result.push(item)
  }
  return result
}

async function readSkillDescription(skillPath: string): Promise<string | undefined> {
  const candidates = ['SKILL.md', 'README.md', 'skill.md'].map(file => join(skillPath, file))
  const docPath = candidates.find(candidate => existsSync(candidate))
  if (!docPath) return undefined

  const content = await readFile(docPath, 'utf-8').catch(() => '')
  const frontmatterDescription = content.match(/^---[\s\S]*?^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim()
  if (frontmatterDescription) return frontmatterDescription

  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !line.startsWith('---') && !line.startsWith('#'))
}

async function collectSkillsFromRoot(rootPath: string, source: HermesSkillInfo['source'], installed: boolean): Promise<HermesSkillInfo[]> {
  if (!existsSync(rootPath)) return []
  const skills: HermesSkillInfo[] = []
  const walk = async (dirPath: string, depth: number): Promise<void> => {
    if (depth < 0) return
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
    if (entries.some(entry => entry.isFile() && entry.name.toLowerCase() === 'skill.md')) {
      const relativePath = relative(rootPath, dirPath) || basename(dirPath)
      skills.push({
        name: relativePath,
        path: dirPath,
        relativePath,
        description: await readSkillDescription(dirPath),
        installed,
        source,
      })
      return
    }
    await Promise.all(entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => walk(join(dirPath, entry.name), depth - 1)))
  }
  await walk(rootPath, 4)
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return skills
}

async function listHermesSkills(runtime: NormalizedHermesRuntimeConfig): Promise<HermesListSkillsResult> {
  const homeSkillsPath = join(runtime.hermesHome, 'skills')
  const agentRoot = process.env.CRAFT_HERMES_AGENT_ROOT?.trim()
  const bundledSkillsPath = agentRoot ? join(agentRoot, 'skills') : undefined
  const optionalSkillsPath = agentRoot ? join(agentRoot, 'optional-skills') : undefined

  const [homeSkills, bundledSkills, optionalSkills] = await Promise.all([
    collectSkillsFromRoot(homeSkillsPath, 'home', true),
    bundledSkillsPath ? collectSkillsFromRoot(bundledSkillsPath, 'bundled', false) : Promise.resolve([]),
    optionalSkillsPath ? collectSkillsFromRoot(optionalSkillsPath, 'optional', false) : Promise.resolve([]),
  ])

  return {
    success: true,
    skillsPath: homeSkillsPath,
    skills: [...homeSkills, ...bundledSkills, ...optionalSkills],
  }
}

async function getGitInfo(repoPath: string): Promise<{ remote?: string; commit?: string; dirty?: boolean }> {
  if (!existsSync(join(repoPath, '.git'))) return {}
  const git = async (...args: string[]) => {
    try {
      const { stdout } = await execFile('git', ['-C', repoPath, ...args])
      return stdout.trim()
    } catch {
      return undefined
    }
  }
  const [remote, commit, status] = await Promise.all([
    git('remote', 'get-url', 'origin'),
    git('rev-parse', '--short', 'HEAD'),
    git('status', '--porcelain'),
  ])
  return { remote, commit, dirty: Boolean(status) }
}

function resolveHermesSourceRepo(deps: HandlerDeps, agentRoot?: string): string | undefined {
  const envSource = process.env.HERMES_SRC?.trim() || process.env.HERMES_SOURCE_DIR?.trim()
  const candidates = [
    envSource,
    join(deps.platform.appRootPath, '..', 'hermes-agent'),
    join(deps.platform.appRootPath, '..', '..', 'hermes-agent'),
    join(deps.platform.appRootPath, '..', '..', '..', 'hermes-agent'),
    join(process.cwd(), '..', 'hermes-agent'),
    join(process.cwd(), '..', '..', 'hermes-agent'),
    join(process.cwd(), '..', '..', '..', 'hermes-agent'),
    agentRoot,
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find(candidate => existsSync(join(candidate, 'pyproject.toml')))
}

async function listAvailableProviders(agentRoot?: string): Promise<string[]> {
  if (!agentRoot) return []
  const examplePath = join(agentRoot, 'cli-config.yaml.example')
  if (!existsSync(examplePath)) return []
  const content = await readFile(examplePath, 'utf-8').catch(() => '')
  return Array.from(new Set(
    [...content.matchAll(/^#\s+"([^"]+)"\s+-/gm)].map(match => match[1]!).filter(Boolean),
  )).sort()
}

async function listPluginNames(agentRoot?: string): Promise<string[]> {
  if (!agentRoot) return []
  const pluginsPath = join(agentRoot, 'plugins')
  if (!existsSync(pluginsPath)) return []
  const entries = await readdir(pluginsPath, { withFileTypes: true }).catch(() => [])
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort()
}

function resolveUpdateScript(deps: HandlerDeps): string {
  const ext = process.platform === 'win32' ? '.ps1' : '.sh'
  const scriptName = `update-hermes-runtime${ext}`
  const candidates = [
    join(deps.platform.appRootPath, 'scripts', scriptName),
    join(deps.platform.appRootPath, 'apps', 'electron', 'scripts', scriptName),
    join(process.cwd(), 'apps', 'electron', 'scripts', scriptName),
    join(process.cwd(), 'scripts', scriptName),
  ]
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0]!
}

function runUpdateScript(scriptPath: string): Promise<HermesUpdateResult> {
  return new Promise((resolveResult) => {
    const command = process.platform === 'win32' ? 'powershell' : 'bash'
    const args = process.platform === 'win32'
      ? ['-ExecutionPolicy', 'Bypass', '-File', scriptPath]
      : [scriptPath]
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    const append = (chunk: unknown) => {
      output += String(chunk)
      if (output.length > 80_000) output = output.slice(-80_000)
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    const timeout = setTimeout(() => {
      child.kill()
      resolveResult({ success: false, status: 'failed', command: `${command} ${args.join(' ')}`, output, error: 'Hermes update timed out' })
    }, 10 * 60_000)

    child.once('error', (error) => {
      clearTimeout(timeout)
      resolveResult({ success: false, status: 'failed', command: `${command} ${args.join(' ')}`, output, error: error.message })
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolveResult({
        success: code === 0,
        status: code === 0 ? 'updated' : 'failed',
        command: `${command} ${args.join(' ')}`,
        output,
        error: code === 0 ? undefined : `Hermes update exited with code ${code}`,
        needsRestart: code === 0,
      })
    })
  })
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.hermes.DETECT_INSTALLATION,
  RPC_CHANNELS.hermes.GET_RUNTIME_DETAILS,
  RPC_CHANNELS.hermes.START_DASHBOARD,
  RPC_CHANNELS.hermes.UPDATE_RUNTIME,
  RPC_CHANNELS.hermes.LIST_LOGS,
  RPC_CHANNELS.hermes.READ_LOG,
  RPC_CHANNELS.hermes.LIST_HOME_FILES,
  RPC_CHANNELS.hermes.LIST_SKILLS,
  RPC_CHANNELS.hermes.OPEN_PATH,
] as const

export function registerHermesHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.hermes.DETECT_INSTALLATION, async (): Promise<HermesDetectionResult> => {
    return buildDetectionResult(deps)
  })

  server.handle(RPC_CHANNELS.hermes.GET_RUNTIME_DETAILS, async (): Promise<HermesRuntimeDetailsResult> => {
    const runtime = normalizeHermesRuntimeConfig()
    const detection = await buildDetectionResult(deps)
    const agentRoot = process.env.CRAFT_HERMES_AGENT_ROOT?.trim() || undefined
    const sourceRepoPath = resolveHermesSourceRepo(deps, agentRoot)
    const sourceInfo = sourceRepoPath ? await getGitInfo(sourceRepoPath) : {}
    return {
      ...detection,
      envExists: existsSync(runtime.envPath),
      configExists: existsSync(runtime.configPath),
      logsPath: join(runtime.hermesHome, 'logs'),
      skillsPath: join(runtime.hermesHome, 'skills'),
      sessionsPath: join(runtime.hermesHome, 'sessions'),
      agentRoot,
      virtualEnv: process.env.CRAFT_HERMES_VIRTUAL_ENV?.trim() || undefined,
      vendorBinPath: process.env.CRAFT_HERMES_VENDOR_BIN?.trim() || undefined,
      sourceRepoPath,
      sourceRepoRemote: sourceInfo.remote,
      sourceRepoCommit: sourceInfo.commit,
      sourceRepoDirty: sourceInfo.dirty,
      availableProviders: await listAvailableProviders(agentRoot),
      pluginNames: await listPluginNames(agentRoot),
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

  server.handle(RPC_CHANNELS.hermes.UPDATE_RUNTIME, async (): Promise<HermesUpdateResult> => {
    if (deps.platform.isPackaged) {
      return {
        success: false,
        status: 'unsupported',
        error: 'Hermes runtime updates are bundled with Craft app releases. Update Craft to update Hermes.',
      }
    }

    const scriptPath = resolveUpdateScript(deps)
    if (!existsSync(scriptPath)) {
      return {
        success: false,
        status: 'unsupported',
        command: scriptPath,
        error: 'Hermes update script is not available in this build.',
      }
    }

    return runUpdateScript(scriptPath)
  })

  server.handle(RPC_CHANNELS.hermes.LIST_LOGS, async (): Promise<HermesListLogsResult> => {
    try {
      return await listHermesLogs(normalizeHermesRuntimeConfig())
    } catch (error) {
      return { success: false, logsPath: join(normalizeHermesRuntimeConfig().hermesHome, 'logs'), files: [], error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_CHANNELS.hermes.READ_LOG, async (_ctx, name: string): Promise<HermesReadLogResult> => {
    const runtime = normalizeHermesRuntimeConfig()
    const logsPath = join(runtime.hermesHome, 'logs')
    try {
      const logPath = await resolveExistingInside(logsPath, name)
      const info = await fileInfo(logPath)
      const content = await readFile(logPath, 'utf-8')
      const maxLength = 60_000
      return {
        success: true,
        file: info,
        content: content.length > maxLength ? content.slice(-maxLength) : content,
        truncated: content.length > maxLength,
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_CHANNELS.hermes.LIST_HOME_FILES, async (_ctx, target?: string): Promise<HermesListHomeFilesResult> => {
    const runtime = normalizeHermesRuntimeConfig()
    try {
      return {
        success: true,
        rootPath: runtime.hermesHome,
        files: await listHomeFiles(runtime.hermesHome, target || '.', 2),
      }
    } catch (error) {
      return { success: false, rootPath: runtime.hermesHome, files: [], error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_CHANNELS.hermes.LIST_SKILLS, async (): Promise<HermesListSkillsResult> => {
    try {
      return await listHermesSkills(normalizeHermesRuntimeConfig())
    } catch (error) {
      return { success: false, skillsPath: join(normalizeHermesRuntimeConfig().hermesHome, 'skills'), skills: [], error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_CHANNELS.hermes.OPEN_PATH, async (_ctx, target?: string): Promise<HermesOpenPathResult> => {
    const runtime = normalizeHermesRuntimeConfig()
    try {
      const candidatePath = resolveInside(runtime.hermesHome, target || '.')
      if (!existsSync(candidatePath)) return { success: false, path: candidatePath, error: 'Path does not exist' }
      const path = await resolveExistingInside(runtime.hermesHome, target || '.')
      if (!deps.platform.openPath) return { success: false, path, error: 'Opening paths is not supported on this platform' }
      await deps.platform.openPath(path)
      return { success: true, path }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
