import { existsSync, statSync, watch as fsWatch, type FSWatcher } from 'node:fs'
import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { spawn, type ChildProcess } from 'node:child_process'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { execFile as execFileCb } from 'node:child_process'
import net from 'node:net'

import {
  RPC_NAMESPACES,
  type HermesActiveProfileResult,
  type HermesDashboardResult,
  type HermesDetectionResult,
  type HermesHomeFileInfo,
  type HermesListHomeFilesResult,
  type HermesListLogsResult,
  type HermesListProfilesResult,
  type HermesListSkillsResult,
  type HermesLogFileInfo,
  type HermesOpenPathResult,
  type HermesProfileMutationResult,
  type HermesProfileSetupCommandResult,
  type HermesProfileSoulResult,
  type HermesReadLogResult,
  type HermesRuntimeDetailsResult,
  type HermesSkillInfo,
  type HermesUpdateResult,
  type HermesEnvVar,
  type HermesListEnvResult,
  type HermesEnvMutationResult,
} from '@craft-agent/shared/protocol'
import { isValidHermesProfileName, normalizeHermesRuntimeConfig, type NormalizedHermesRuntimeConfig } from '@craft-agent/shared/hermes/acp-config'
import { readHermesCodexTokens, seedHermesAuthFromCraft } from '@craft-agent/shared/hermes/auth-bridge'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { getActiveHermesProfile, setActiveHermesProfile } from '@craft-agent/shared/config'
import { parseHermesConfigSnapshot, updateHermesConfigMainModel } from '@craft-agent/shared/hermes/runtime-config'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import type { Logger } from '../../runtime/platform'

const execFile = promisify(execFileCb)

let dashboardProcess: ChildProcess | null = null
let dashboardUrl: string | null = null
let dashboardPort: number | null = null
let dashboardStartPromise: Promise<HermesDashboardResult> | null = null
let dashboardSessionToken: string | null = null
let dashboardSessionTokenUrl: string | null = null
let updateMarkerMonitor: ReturnType<typeof setInterval> | null = null
let updateMarkerMonitorPath: string | null = null
let updateMarkerLastMtime = 0
let authJsonWatcher: FSWatcher | null = null
let authJsonWatcherPath: string | null = null
let authJsonSyncInFlight = false
let authJsonLastSyncedAccessToken: string | null = null
let authJsonDebounceTimer: ReturnType<typeof setTimeout> | null = null

function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key) env[key] = value
  }
  return env
}

async function listCustomProviderModels(runtime: NormalizedHermesRuntimeConfig, provider: string, logger?: Logger): Promise<Array<{ id: string }>> {
  const rawConfig = existsSync(runtime.configPath) ? await readFile(runtime.configPath, 'utf-8') : ''
  const snapshot = parseHermesConfigSnapshot(rawConfig)
  const customProvider = snapshot.customProviders.find(entry => entry.name === provider)
  if (!customProvider) return []

  const configuredModels = (customProvider.models ?? [])
    .filter(id => typeof id === 'string' && id.length > 0)
    .map(id => ({ id }))

  if (!customProvider.baseUrl) {
    return configuredModels
  }

  const envFile = existsSync(runtime.envPath) ? parseEnvFile(await readFile(runtime.envPath, 'utf-8')) : {}
  const apiKey = customProvider.keyEnv ? (envFile[customProvider.keyEnv] || process.env[customProvider.keyEnv] || '') : ''
  const modelsUrl = `${customProvider.baseUrl.replace(/\/$/, '')}/models`

  try {
    const response = await fetch(modelsUrl, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return configuredModels
    const body = await response.json() as { data?: Array<{ id?: unknown }>; models?: Array<{ id?: unknown }> }
    const remoteModels = (Array.isArray(body.data) ? body.data : body.models ?? [])
      .map(entry => (typeof entry?.id === 'string' ? entry.id : null))
      .filter((id): id is string => Boolean(id))
      .slice(0, 100)
      .map(id => ({ id }))
    return remoteModels.length > 0 ? remoteModels : configuredModels
  } catch (error) {
    logger?.debug('[Hermes] Failed to discover custom provider models', { provider, modelsUrl, error })
    return configuredModels
  }
}

async function preserveDashboardMainModelBaseUrl(
  fetchJson: (path: string, init?: RequestInit) => Promise<unknown>,
  provider: string,
  model: string,
  baseUrl: string,
): Promise<unknown> {
  const rawConfig = await fetchJson('/api/config/raw') as { yaml?: string }
  const yamlText = updateHermesConfigMainModel(rawConfig.yaml ?? '', { provider, model, baseUrl })
  return fetchJson('/api/config/raw', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ yaml_text: yamlText }),
  })
}

/**
 * Gracefully shut down the Hermes dashboard child (and its uvicorn worker fork).
 * Spawned with `detached: true` so killing the negative pid signals the whole
 * process group. SIGTERM first, SIGKILL after `timeoutMs`.
 */
export async function shutdownHermesDashboard(timeoutMs = 3000): Promise<void> {
  const child = dashboardProcess
  if (!child || child.pid == null || child.exitCode !== null || child.killed) return

  const exited = new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit())
  })

  if (process.platform === 'win32') {
    try {
      await execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    } catch {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
  } else {
    try { process.kill(-child.pid, 'SIGTERM') }
    catch { try { child.kill('SIGTERM') } catch { /* already gone */ } }
  }

  await Promise.race([
    exited,
    new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
  ])

  if (child.exitCode === null && !child.killed) {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
      else child.kill('SIGKILL')
    } catch { /* already gone */ }
  }
}

/**
 * Defensive cleanup for crash-leaked dashboards. Scans for live processes that
 * (a) run from `vendorPython` and (b) execute `hermes_cli.main dashboard ...`.
 * The launchd-managed gateway uses `gateway run --replace` (no `dashboard`
 * substring) and is therefore not matched. Best-effort; skips silently on
 * unsupported platforms.
 */
export async function cleanupHermesDashboardOrphans(vendorPython: string): Promise<number[]> {
  if (!vendorPython || process.platform === 'win32') return []
  let stdout: string
  try {
    ({ stdout } = await execFile('ps', ['-A', '-o', 'pid=,command=']))
  } catch {
    return []
  }

  const pids: number[] = []
  for (const raw of stdout.split('\n')) {
    if (!raw.includes(vendorPython)) continue
    if (!raw.includes('hermes_cli.main')) continue
    if (!raw.includes(' dashboard')) continue
    const pid = Number.parseInt(raw.trim().split(/\s+/)[0], 10)
    if (!Number.isFinite(pid) || pid === process.pid) continue
    pids.push(pid)
  }

  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
  if (pids.length === 0) return []

  await new Promise((r) => setTimeout(r, 1000))
  for (const pid of pids) {
    try {
      process.kill(pid, 0)
      process.kill(pid, 'SIGKILL')
    } catch { /* already gone */ }
  }
  return pids
}

const HERMES_HOME_HIDDEN_NAMES = new Set(['.env', 'auth.json', 'auth.lock', '.DS_Store'])
const HERMES_HOME_COLLAPSED_DIRS = new Set(['cron', 'logs', 'memories', 'memory', 'sessions', 'skills', 'skins'])
const CRAFT_HERMES_UPDATE_MARKER_NAME = 'craft-hermes-update-result.json'
const HERMES_GATEWAY_ENV_KEYS = new Set([
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_USERS',
  'TELEGRAM_HOME_CHANNEL',
  'TELEGRAM_HOME_CHANNEL_NAME',
  'DISCORD_BOT_TOKEN',
  'DISCORD_ALLOWED_USERS',
  'DISCORD_ALLOWED_CHANNELS',
  'DISCORD_HOME_CHANNEL',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_FREE_RESPONSE_CHANNELS',
  'SLACK_HOME_CHANNEL',
  'SIGNAL_HTTP_URL',
  'SIGNAL_ACCOUNT',
  'SIGNAL_HOME_CHANNEL',
  'WHATSAPP_ENABLED',
  'WHATSAPP_MODE',
  'MATRIX_HOMESERVER',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_PASSWORD',
  'MATRIX_USER_ID',
  'EMAIL_ADDRESS',
  'EMAIL_PASSWORD',
  'EMAIL_IMAP_HOST',
  'EMAIL_SMTP_HOST',
  'EMAIL_IMAP_PORT',
  'EMAIL_SMTP_PORT',
  'HASS_TOKEN',
  'HASS_URL',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'SMS_WEBHOOK_URL',
  'SMS_WEBHOOK_PORT',
  'DINGTALK_CLIENT_ID',
  'DINGTALK_CLIENT_SECRET',
  'FEISHU_APP_ID',
  'FEISHU_APP_SECRET',
  'FEISHU_VERIFICATION_TOKEN',
  'MATTERMOST_TOKEN',
  'MATTERMOST_URL',
  'BLUEBUBBLES_SERVER_URL',
  'BLUEBUBBLES_PASSWORD',
])
const HERMES_SECRET_ENV_RE = /(TOKEN|PASSWORD|SECRET|API_KEY|APP_KEY|AUTH_TOKEN|ACCESS_TOKEN|CLIENT_SECRET|PASSWORD)$/i

interface HermesUpdateMarker {
  name?: string
  exit_code?: number
  success?: boolean
  needs_restart?: boolean
  log_path?: string
  timestamp?: number
}

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

function buildHermesUpdateCommand(deps: HandlerDeps): string[] {
  const scriptPath = resolveUpdateScript(deps)
  return process.platform === 'win32'
    ? ['powershell', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
    : ['bash', scriptPath]
}

function getHermesUpdateMarkerPath(runtime: NormalizedHermesRuntimeConfig): string {
  return join(runtime.hermesHome, CRAFT_HERMES_UPDATE_MARKER_NAME)
}

function buildHermesDashboardEnv(deps: HandlerDeps, runtime: NormalizedHermesRuntimeConfig): NodeJS.ProcessEnv {
  const env = buildHermesEnv(runtime)
  if (!isBundledRuntime(runtime)) return env

  env.CRAFT_HERMES_EMBEDDED = '1'
  env.CRAFT_HERMES_UPDATE_MARKER = getHermesUpdateMarkerPath(runtime)
  env.CRAFT_HERMES_UPDATE_CWD = process.cwd()

  if (!deps.platform.isPackaged) {
    env.CRAFT_HERMES_UPDATE_COMMAND_JSON = JSON.stringify(buildHermesUpdateCommand(deps))
  }

  return env
}

function parseHermesUpdateMarker(raw: string): HermesUpdateMarker | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as HermesUpdateMarker
  } catch {
    return null
  }
}

function startHermesUpdateMarkerMonitor(deps: HandlerDeps, runtime: NormalizedHermesRuntimeConfig): void {
  if (!isBundledRuntime(runtime)) return

  const markerPath = getHermesUpdateMarkerPath(runtime)
  if (updateMarkerMonitor && updateMarkerMonitorPath === markerPath) return
  if (updateMarkerMonitor) clearInterval(updateMarkerMonitor)

  updateMarkerMonitorPath = markerPath
  try {
    updateMarkerLastMtime = existsSync(markerPath) ? statSync(markerPath).mtimeMs : 0
  } catch {
    updateMarkerLastMtime = 0
  }

  updateMarkerMonitor = setInterval(async () => {
    try {
      if (!existsSync(markerPath)) return
      const info = await lstat(markerPath)
      if (info.mtimeMs <= updateMarkerLastMtime) return
      updateMarkerLastMtime = info.mtimeMs

      const marker = parseHermesUpdateMarker(await readFile(markerPath, 'utf-8'))
      if (!marker) return

      deps.platform.logger.info('[Hermes] Dashboard update finished', {
        success: marker.success,
        exitCode: marker.exit_code,
        logPath: marker.log_path,
      })

      if (marker.success && marker.needs_restart) {
        await deps.platform.showNotification?.(
          'Hermes atualizado',
          'Reinicie o Craft para usar o runtime Hermes atualizado.',
        )
      }
    } catch (error) {
      deps.platform.logger.warn('[Hermes] Failed to read dashboard update marker', error)
    }
  }, 1_500)
  updateMarkerMonitor.unref?.()
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

function extractDashboardSessionToken(html: string): string | null {
  const match = html.match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*"([^"]+)"/)
  return match?.[1] ?? null
}

function isSecretHermesEnvKey(key: string): boolean {
  return HERMES_SECRET_ENV_RE.test(key)
}

function redactHermesEnvValue(key: string, value: string): string {
  if (!isSecretHermesEnvKey(key)) return value
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

async function getDashboardSessionToken(baseUrl: string): Promise<string> {
  if (dashboardSessionToken && dashboardSessionTokenUrl === baseUrl) {
    return dashboardSessionToken
  }

  const response = await fetch(baseUrl)
  const html = await response.text()
  if (!response.ok) {
    throw new Error(`Hermes dashboard token unavailable: HTTP ${response.status}`)
  }

  const token = extractDashboardSessionToken(html)
  if (!token) {
    throw new Error('Hermes dashboard session token not found')
  }

  dashboardSessionToken = token
  dashboardSessionTokenUrl = baseUrl
  return token
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
    defaultProvider: configSnapshot.defaultProvider,
    fallbackModel: configSnapshot.fallbackModel,
    fallbackProviders: configSnapshot.fallbackProviders,
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

async function listHomeFiles(rootPath: string, target = '.', depth = 1): Promise<HermesHomeFileInfo[]> {
  if (!existsSync(resolveInside(rootPath, target))) return []
  const dirPath = await resolveExistingInside(rootPath, target)

  const entries = await readdir(dirPath, { withFileTypes: true })
  const visible = entries
    .filter(entry => !HERMES_HOME_HIDDEN_NAMES.has(entry.name))
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
    const shouldExpand = entry.isDirectory() && depth > 1 && !HERMES_HOME_COLLAPSED_DIRS.has(entry.name)
    if (shouldExpand) {
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

interface HermesGitInfo {
  remote?: string
  upstreamRemote?: string
  branch?: string
  commit?: string
  commitDate?: string
  releaseTag?: string
  dirty?: boolean
}

async function getGitInfo(repoPath: string): Promise<HermesGitInfo> {
  if (!existsSync(join(repoPath, '.git'))) return {}
  const git = async (...args: string[]) => {
    try {
      const { stdout } = await execFile('git', ['-C', repoPath, ...args])
      return stdout.trim()
    } catch {
      return undefined
    }
  }
  const [remote, upstreamRemote, branch, commit, commitDate, releaseTag, status] = await Promise.all([
    git('remote', 'get-url', 'origin'),
    git('remote', 'get-url', 'upstream'),
    git('branch', '--show-current'),
    git('rev-parse', '--short', 'HEAD'),
    git('log', '-1', '--format=%cs'),
    git('describe', '--tags', '--exact-match', 'HEAD'),
    git('status', '--porcelain'),
  ])
  return {
    remote,
    upstreamRemote,
    branch,
    commit,
    commitDate,
    releaseTag,
    dirty: Boolean(status),
  }
}

function resolveHermesSourceRepo(deps: HandlerDeps, agentRoot?: string): string | undefined {
  const envSource = process.env.HERMES_SRC?.trim() || process.env.HERMES_SOURCE_DIR?.trim()
  const candidates = [
    // Explicit dev override only. Do not auto-bind to a sibling fork just
    // because ../hermes-agent exists; the bundled update path uses the pinned
    // cache clone below as its source of truth.
    envSource,
    join(deps.platform.appRootPath, 'scripts', '.hermes-cache', 'source'),
    join(deps.platform.appRootPath, 'apps', 'electron', 'scripts', '.hermes-cache', 'source'),
    join(process.cwd(), 'apps', 'electron', 'scripts', '.hermes-cache', 'source'),
    join(process.cwd(), 'scripts', '.hermes-cache', 'source'),
    agentRoot,
  ].filter((candidate): candidate is string => Boolean(candidate))
  return candidates.find(candidate => existsSync(join(candidate, 'pyproject.toml')))
}

function resolveHermesPinPath(deps: HandlerDeps): string | undefined {
  const candidates = [
    join(deps.platform.appRootPath, 'scripts', 'hermes-version.txt'),
    join(deps.platform.appRootPath, 'apps', 'electron', 'scripts', 'hermes-version.txt'),
    join(process.cwd(), 'apps', 'electron', 'scripts', 'hermes-version.txt'),
    join(process.cwd(), 'scripts', 'hermes-version.txt'),
  ]
  return candidates.find(candidate => existsSync(candidate))
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function booleanValue(value: unknown): boolean {
  return typeof value === 'boolean' ? value : false
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeHermesProfile(value: unknown) {
  const record = asRecord(value)
  if (!record) return null
  const name = optionalString(record.name)
  const path = optionalString(record.path)
  if (!name || !path) return null
  return {
    name,
    path,
    isDefault: booleanValue(record.is_default ?? record.isDefault),
    model: optionalString(record.model),
    provider: optionalString(record.provider),
    hasEnv: booleanValue(record.has_env ?? record.hasEnv),
    skillCount: numberValue(record.skill_count ?? record.skillCount),
  }
}

function normalizeHermesProfilesPayload(payload: unknown): HermesListProfilesResult {
  const record = asRecord(payload)
  const activeProfile = getActiveHermesProfile()
  const rawProfiles = Array.isArray(record?.profiles) ? record.profiles : []
  const profiles = rawProfiles
    .map(normalizeHermesProfile)
    .filter((profile): profile is NonNullable<ReturnType<typeof normalizeHermesProfile>> => profile !== null)
  const effectiveActiveProfile = profiles.some(profile => profile.name === activeProfile) ? activeProfile : 'default'
  return {
    success: true,
    profiles: profiles.map(profile => ({ ...profile, isActive: profile.name === effectiveActiveProfile })),
  }
}

async function readHermesPin(pinPath?: string): Promise<string | undefined> {
  const override = process.env.HERMES_VERSION?.trim()
  if (override) return override
  if (!pinPath) return undefined
  const content = await readFile(pinPath, 'utf-8').catch(() => '')
  return content
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line && !line.startsWith('#'))
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
  RPC_NAMESPACES.hermes.DETECT_INSTALLATION,
  RPC_NAMESPACES.hermes.GET_RUNTIME_DETAILS,
  RPC_NAMESPACES.hermes.START_DASHBOARD,
  RPC_NAMESPACES.hermes.UPDATE_RUNTIME,
  RPC_NAMESPACES.hermes.LIST_LOGS,
  RPC_NAMESPACES.hermes.READ_LOG,
  RPC_NAMESPACES.hermes.LIST_HOME_FILES,
  RPC_NAMESPACES.hermes.LIST_SKILLS,
  RPC_NAMESPACES.hermes.OPEN_PATH,
  RPC_NAMESPACES.hermes.GET_API_CONFIG,
  RPC_NAMESPACES.hermes.PATCH_API_CONFIG,
  RPC_NAMESPACES.hermes.GET_PROVIDER_MODELS,
  RPC_NAMESPACES.hermes.LIST_PROFILES,
  RPC_NAMESPACES.hermes.GET_ACTIVE_PROFILE,
  RPC_NAMESPACES.hermes.SET_ACTIVE_PROFILE,
  RPC_NAMESPACES.hermes.CREATE_PROFILE,
  RPC_NAMESPACES.hermes.RENAME_PROFILE,
  RPC_NAMESPACES.hermes.DELETE_PROFILE,
  RPC_NAMESPACES.hermes.GET_PROFILE_SETUP_COMMAND,
  RPC_NAMESPACES.hermes.GET_PROFILE_SOUL,
  RPC_NAMESPACES.hermes.UPDATE_PROFILE_SOUL,
] as const

/**
 * Sync Codex tokens from <HERMES_HOME>/auth.json back into Craft's credential
 * store. Called when the watcher fires after a Hermes-side refresh, so the
 * next Craft session uses the rotated tokens instead of stale ones.
 */
async function syncCodexTokensFromHermes(deps: HandlerDeps, hermesHome: string): Promise<void> {
  if (authJsonSyncInFlight) return
  authJsonSyncInFlight = true
  try {
    const tokens = readHermesCodexTokens(hermesHome)
    if (!tokens) return
    if (tokens.accessToken === authJsonLastSyncedAccessToken) return

    const manager = getCredentialManager()
    await manager.setLlmOAuth('chatgpt-plus', {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
    })
    authJsonLastSyncedAccessToken = tokens.accessToken
    deps.platform.logger?.info?.('[Hermes] Synced refreshed Codex tokens back to Craft credential store')
  } catch (error) {
    deps.platform.logger?.warn?.(
      `[Hermes] auth.json sync failed: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    authJsonSyncInFlight = false
  }
}

function startHermesAuthJsonWatcher(deps: HandlerDeps): void {
  const runtime = normalizeHermesRuntimeConfig()
  const authPath = join(runtime.hermesHome, 'auth.json')

  if (authJsonWatcher && authJsonWatcherPath === authPath) return

  authJsonWatcher?.close()
  authJsonWatcher = null

  if (!existsSync(runtime.hermesHome)) return

  try {
    // Watch the directory (file may not exist yet) and filter on the basename.
    authJsonWatcher = fsWatch(runtime.hermesHome, (_event, filename) => {
      if (!filename || basename(String(filename)) !== 'auth.json') return
      if (authJsonDebounceTimer) clearTimeout(authJsonDebounceTimer)
      authJsonDebounceTimer = setTimeout(() => {
        void syncCodexTokensFromHermes(deps, runtime.hermesHome)
      }, 250)
    })
    authJsonWatcherPath = authPath

    // Prime the cache so the first watcher hit only fires when tokens actually
    // change (avoids a redundant write right after seeding).
    const initial = readHermesCodexTokens(runtime.hermesHome)
    if (initial) authJsonLastSyncedAccessToken = initial.accessToken
  } catch (error) {
    deps.platform.logger?.warn?.(
      `[Hermes] Failed to watch auth.json: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function registerHermesHandlers(server: RpcServer, deps: HandlerDeps): void {
  startHermesAuthJsonWatcher(deps)
  let gatewayRestartTimer: ReturnType<typeof setTimeout> | null = null

  server.handle(RPC_NAMESPACES.hermes.DETECT_INSTALLATION, async (): Promise<HermesDetectionResult> => {
    return buildDetectionResult(deps)
  })

  server.handle(RPC_NAMESPACES.hermes.GET_RUNTIME_DETAILS, async (): Promise<HermesRuntimeDetailsResult> => {
    const runtime = normalizeHermesRuntimeConfig()
    const detection = await buildDetectionResult(deps)
    const agentRoot = process.env.CRAFT_HERMES_AGENT_ROOT?.trim() || undefined
    const sourceRepoPath = resolveHermesSourceRepo(deps, agentRoot)
    const hermesPinPath = resolveHermesPinPath(deps)
    const hermesPin = await readHermesPin(hermesPinPath)
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
      hermesPin,
      hermesPinPath,
      sourceRepoPath,
      sourceRepoRemote: sourceInfo.remote,
      sourceRepoUpstreamRemote: sourceInfo.upstreamRemote,
      sourceRepoBranch: sourceInfo.branch,
      sourceRepoCommit: sourceInfo.commit,
      sourceRepoCommitDate: sourceInfo.commitDate,
      sourceRepoReleaseTag: sourceInfo.releaseTag,
      sourceRepoDirty: sourceInfo.dirty,
      availableProviders: await listAvailableProviders(agentRoot),
      pluginNames: await listPluginNames(agentRoot),
    }
  })
  async function ensureDashboardRunning(): Promise<HermesDashboardResult> {
    if (dashboardProcess && dashboardProcess.exitCode === null && !dashboardProcess.killed && dashboardUrl && dashboardPort) {
      startHermesUpdateMarkerMonitor(deps, normalizeHermesRuntimeConfig())
      return {
        success: true,
        url: dashboardUrl,
        port: dashboardPort,
        pid: dashboardProcess.pid,
      }
    }

    if (dashboardStartPromise) {
      return dashboardStartPromise
    }

    dashboardStartPromise = (async () => {
      const runtime = normalizeHermesRuntimeConfig()
      const resolvedCommand = await resolveHermesBinary(runtime.command)
      if (!resolvedCommand) {
        return { success: false, error: `Hermes runtime not found: ${runtime.command}` }
      }

      const port = await findFreePort()
      const { command, args } = buildDashboardCommand(runtime, port)
      startHermesUpdateMarkerMonitor(deps, runtime)
      const env = buildHermesDashboardEnv(deps, runtime)
      try {
        const seed = await seedHermesAuthFromCraft({
          hermesHome: runtime.hermesHome,
          connectionSlug: undefined,
        })
        Object.assign(env, seed.env)
        if (seed.seededProviders.length > 0) {
          deps.platform.logger.info('[Hermes] Seeded dashboard provider auth from Craft credentials', {
            providers: seed.seededProviders,
          })
        }
      } catch (error) {
        deps.platform.logger.warn('[Hermes] Failed to seed dashboard provider auth from Craft credentials', error)
      }
      const child = spawn(command, args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX only: give the dashboard its own process group so we can signal
        // the entire tree (the dashboard forks a uvicorn worker) on shutdown.
        detached: process.platform !== 'win32',
      })

      let output = ''
      const appendOutput = (chunk: unknown) => {
        output += String(chunk)
        if (output.length > 20_000) output = output.slice(-20_000)
        deps.platform.logger.debug(`[Hermes dashboard] ${String(chunk).trim()}`)
      }
      child.stderr?.on('data', appendOutput)
      child.stdout?.on('data', appendOutput)
      child.once('exit', (code, signal) => {
        deps.platform.logger?.info?.('[Hermes] Dashboard exited', { code, signal })
        if (dashboardProcess === child) {
          dashboardProcess = null
          dashboardUrl = null
          dashboardPort = null
          dashboardStartPromise = null
          dashboardSessionToken = null
          dashboardSessionTokenUrl = null
        }
      })

      try {
        await Promise.race([
          waitForPort(port),
          new Promise<never>((_resolve, reject) => {
            child.once('error', reject)
            child.once('exit', (code) => reject(new Error(output.trim() || `Hermes dashboard exited with code ${code}`)))
          }),
        ])
      } catch (err) {
        if (!child.killed) child.kill()
        dashboardStartPromise = null
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }

      if (child.exitCode !== null) {
        dashboardStartPromise = null
        return {
          success: false,
          error: output.trim() || `Hermes dashboard exited with code ${child.exitCode}`,
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
    })()

    return dashboardStartPromise
  }

  async function fetchDashboardJson(path: string, init?: RequestInit): Promise<unknown> {
    const ready = await ensureDashboardRunning()
    if (!ready.success || !ready.url) {
      throw new Error(ready.error || 'Hermes dashboard unavailable')
    }
    const headers = new Headers(init?.headers)
    if (path.startsWith('/api/')) {
      headers.set('X-Hermes-Session-Token', await getDashboardSessionToken(ready.url))
    }
    const response = await fetch(`${ready.url}${path}`, { ...init, headers })
    const text = await response.text()
    if (!response.ok) {
      if (response.status === 401 && dashboardSessionTokenUrl === ready.url) {
        dashboardSessionToken = null
        dashboardSessionTokenUrl = null
      }
      throw new Error(`HTTP ${response.status}: ${text || response.statusText}`)
    }
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }

  function scheduleGatewayRestartForEnv(key: string): void {
    if (!HERMES_GATEWAY_ENV_KEYS.has(key)) return
    if (gatewayRestartTimer) clearTimeout(gatewayRestartTimer)
    gatewayRestartTimer = setTimeout(() => {
      gatewayRestartTimer = null
      void fetchDashboardJson('/api/gateway/restart', { method: 'POST' })
        .catch((error) => {
          deps.platform.logger?.warn?.('[Hermes] Failed to restart gateway after env change', {
            key,
            error: error instanceof Error ? error.message : String(error),
          })
        })
    }, 1000)
  }

  server.handle(RPC_NAMESPACES.hermes.START_DASHBOARD, async (): Promise<HermesDashboardResult> => {
    return ensureDashboardRunning()
  })

  server.handle(RPC_NAMESPACES.hermes.GET_API_CONFIG, async () => {
    try {
      const [config, modelInfo, modelOptions] = await Promise.all([
        fetchDashboardJson('/api/config'),
        fetchDashboardJson('/api/model/info'),
        fetchDashboardJson('/api/model/options'),
      ]) as [
        Record<string, unknown>,
        { provider?: string; model?: string },
        { providers?: Array<{ slug?: string; models?: string[] }> },
      ]
      return {
        success: true as const,
        data: {
          activeProvider: modelInfo.provider
            || (typeof config.provider === 'string' ? config.provider : undefined)
            || (typeof config.active_provider === 'string' ? config.active_provider : undefined)
            || modelOptions.providers?.find(provider => typeof provider.slug === 'string')?.slug
            || undefined,
          activeModel: modelInfo.model || (typeof config.model === 'string' ? config.model : undefined),
          providers: (modelOptions.providers ?? []).map(provider => ({
            id: provider.slug,
            configured: true,
          })),
          config,
        },
      }
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.PATCH_API_CONFIG, async (
    _ctx,
    body: { config?: Record<string, unknown>; env?: Record<string, string> },
  ) => {
    try {
      const provider = typeof body.config?.provider === 'string' ? body.config.provider : ''
      let model = typeof body.config?.model === 'string' ? body.config.model : ''
      if (provider && !model) {
        const modelInfo = await fetchDashboardJson('/api/model/info') as { model?: string }
        model = modelInfo.model || ''
      }
      if (provider && model) {
        const baseUrl = typeof body.config?.base_url === 'string' ? body.config.base_url.trim() : ''
        const data = await fetchDashboardJson('/api/model/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: 'main', provider, model }),
        })
        if (baseUrl) {
          const configData = await preserveDashboardMainModelBaseUrl(fetchDashboardJson, provider, model, baseUrl)
          return { success: true as const, data: { model: data, config: configData } }
        }
        return { success: true as const, data }
      }
      const currentConfig = await fetchDashboardJson('/api/config') as Record<string, unknown>
      const data = await fetchDashboardJson('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { ...currentConfig, ...(body.config ?? {}) } }),
      })
      return { success: true as const, data }
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.GET_PROVIDER_MODELS, async (_ctx, provider: string) => {
    try {
      const data = await fetchDashboardJson('/api/model/options') as {
        providers?: Array<{ slug?: string; models?: string[] }>
      } | null
      const matchingProvider = data?.providers?.find(entry => entry.slug === provider)
      let models = (matchingProvider?.models ?? [])
        .filter((id): id is string => typeof id === 'string' && id.length > 0)
        .map(id => ({ id }))

      if (models.length === 0 && provider) {
        models = await listCustomProviderModels(normalizeHermesRuntimeConfig(), provider, deps.platform.logger)
      }

      return { success: true as const, data: { models } }
    } catch (error) {
      return { success: false as const, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.LIST_PROFILES, async (): Promise<HermesListProfilesResult> => {
    try {
      return normalizeHermesProfilesPayload(await fetchDashboardJson('/api/profiles'))
    } catch (error) {
      return { success: false, profiles: [], error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.GET_ACTIVE_PROFILE, async (): Promise<HermesActiveProfileResult> => {
    return { success: true, name: getActiveHermesProfile() }
  })

  server.handle(RPC_NAMESPACES.hermes.SET_ACTIVE_PROFILE, async (
    _ctx,
    name: string,
  ): Promise<HermesActiveProfileResult> => {
    try {
      const target = name.trim() || 'default'
      if (!isValidHermesProfileName(target)) {
        return { success: false, error: 'Nome de profile Hermes inválido.' }
      }

      const profiles = normalizeHermesProfilesPayload(await fetchDashboardJson('/api/profiles')).profiles
      if (target !== 'default' && !profiles.some(profile => profile.name === target)) {
        return { success: false, error: `Profile Hermes não encontrado: ${target}` }
      }

      if (!setActiveHermesProfile(target)) {
        return { success: false, error: 'Config local do Craft não encontrada.' }
      }

      return { success: true, name: target }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.CREATE_PROFILE, async (
    _ctx,
    body: { name: string; cloneFromDefault: boolean },
  ): Promise<HermesProfileMutationResult> => {
    try {
      const data = asRecord(await fetchDashboardJson('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: body.name,
          clone_from_default: body.cloneFromDefault,
        }),
      }))
      return {
        success: true,
        name: optionalString(data?.name) ?? body.name,
        path: optionalString(data?.path),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.RENAME_PROFILE, async (
    _ctx,
    name: string,
    newName: string,
  ): Promise<HermesProfileMutationResult> => {
    try {
      const data = asRecord(await fetchDashboardJson(`/api/profiles/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_name: newName }),
      }))
      const savedName = optionalString(data?.name) ?? newName
      if (getActiveHermesProfile() === name) setActiveHermesProfile(savedName)
      return {
        success: true,
        name: savedName,
        path: optionalString(data?.path),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.DELETE_PROFILE, async (
    _ctx,
    name: string,
  ): Promise<HermesProfileMutationResult> => {
    try {
      const data = asRecord(await fetchDashboardJson(`/api/profiles/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }))
      if (getActiveHermesProfile() === name) setActiveHermesProfile('default')
      return {
        success: true,
        name,
        path: optionalString(data?.path),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.GET_PROFILE_SETUP_COMMAND, async (
    _ctx,
    name: string,
  ): Promise<HermesProfileSetupCommandResult> => {
    try {
      const data = asRecord(await fetchDashboardJson(`/api/profiles/${encodeURIComponent(name)}/setup-command`))
      return { success: true, command: optionalString(data?.command) }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.GET_PROFILE_SOUL, async (
    _ctx,
    name: string,
  ): Promise<HermesProfileSoulResult> => {
    try {
      const data = asRecord(await fetchDashboardJson(`/api/profiles/${encodeURIComponent(name)}/soul`))
      return {
        success: true,
        content: optionalString(data?.content) ?? '',
        exists: booleanValue(data?.exists),
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.UPDATE_PROFILE_SOUL, async (
    _ctx,
    name: string,
    content: string,
  ): Promise<HermesProfileMutationResult> => {
    try {
      await fetchDashboardJson(`/api/profiles/${encodeURIComponent(name)}/soul`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })
      return { success: true, name }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.LIST_ENV, async (): Promise<HermesListEnvResult> => {
    try {
      const runtime = normalizeHermesRuntimeConfig()
      const raw = await fetchDashboardJson('/api/env') as Record<string, {
        is_set?: boolean
        redacted_value?: string | null
        description?: string
        category?: string
        is_password?: boolean
      }>
      const vars: HermesEnvVar[] = Object.entries(raw ?? {}).map(([key, info]) => ({
        key,
        isSet: Boolean(info?.is_set),
        redactedValue: info?.redacted_value ?? undefined,
        description: info?.description,
        category: info?.category,
        isPassword: info?.is_password,
      }))
      const knownKeys = new Set(vars.map(v => v.key))
      if (existsSync(runtime.envPath)) {
        const diskEnv = parseEnvFile(await readFile(runtime.envPath, 'utf-8').catch(() => ''))
        for (const [key, value] of Object.entries(diskEnv)) {
          if (knownKeys.has(key) || !HERMES_GATEWAY_ENV_KEYS.has(key)) continue
          vars.push({
            key,
            isSet: value.length > 0,
            redactedValue: value ? redactHermesEnvValue(key, value) : undefined,
            category: 'messaging',
            isPassword: isSecretHermesEnvKey(key),
          })
        }
      }
      vars.sort((a, b) => a.key.localeCompare(b.key))
      return { success: true, vars }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.SET_ENV, async (
    _ctx,
    body: { key: string; value: string },
  ): Promise<HermesEnvMutationResult> => {
    try {
      await fetchDashboardJson('/api/env', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: body.key, value: body.value }),
      })
      scheduleGatewayRestartForEnv(body.key)
      return { success: true, key: body.key }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.DELETE_ENV, async (
    _ctx,
    key: string,
  ): Promise<HermesEnvMutationResult> => {
    try {
      await fetchDashboardJson('/api/env', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      })
      scheduleGatewayRestartForEnv(key)
      return { success: true, key }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.UPDATE_RUNTIME, async (): Promise<HermesUpdateResult> => {
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

  server.handle(RPC_NAMESPACES.hermes.LIST_LOGS, async (): Promise<HermesListLogsResult> => {
    try {
      return await listHermesLogs(normalizeHermesRuntimeConfig())
    } catch (error) {
      return { success: false, logsPath: join(normalizeHermesRuntimeConfig().hermesHome, 'logs'), files: [], error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.READ_LOG, async (_ctx, name: string): Promise<HermesReadLogResult> => {
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

  server.handle(RPC_NAMESPACES.hermes.LIST_HOME_FILES, async (_ctx, target?: string): Promise<HermesListHomeFilesResult> => {
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

  server.handle(RPC_NAMESPACES.hermes.LIST_SKILLS, async (): Promise<HermesListSkillsResult> => {
    try {
      return await listHermesSkills(normalizeHermesRuntimeConfig())
    } catch (error) {
      return { success: false, skillsPath: join(normalizeHermesRuntimeConfig().hermesHome, 'skills'), skills: [], error: error instanceof Error ? error.message : String(error) }
    }
  })

  server.handle(RPC_NAMESPACES.hermes.OPEN_PATH, async (_ctx, target?: string): Promise<HermesOpenPathResult> => {
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
