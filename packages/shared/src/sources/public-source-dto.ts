import type {
  ApiOAuthConfig,
  ApiSourceConfig,
  LoadedSource,
  LocalSourceConfig,
  McpSourceConfig,
  SourceBrand,
  SourceConnectionStatus,
  SourceGuide,
  SourceExpectedTool,
  SourceReadinessEvidence,
  SourceReadinessReason,
  SourceType,
} from './types.ts'
import { isSensitiveCredentialName, sanitizePublicUrl } from './public-url.ts'

export type PublicMcpSourceConfig = Pick<
  McpSourceConfig,
  'transport' | 'url' | 'authType' | 'clientId'
>

export type PublicLocalSourceConfig = Pick<LocalSourceConfig, 'path' | 'format'>

export interface PublicSourceBrand {
  color?: SourceBrand['color']
}

export interface PublicSourceExpectedTool {
  name: string
  apiVersion: string
}

export interface PublicSourceReadinessEvidence {
  status: SourceReadinessEvidence['status']
  reason?: SourceReadinessReason
  observedTools?: PublicSourceExpectedTool[]
  checkedAt: number
}

export type PublicApiOAuthConfig = Pick<
  ApiOAuthConfig,
  'authorizationUrl' | 'tokenUrl' | 'clientId' | 'scopes' | 'audience'
>

export type PublicApiSourceConfig = Pick<
  ApiSourceConfig,
  | 'baseUrl'
  | 'authType'
  | 'headerName'
  | 'headerNames'
  | 'queryParam'
  | 'authScheme'
  | 'googleService'
  | 'googleScopes'
  | 'googleOAuthClientId'
  | 'slackService'
  | 'slackUserScopes'
  | 'microsoftService'
  | 'microsoftScopes'
> & { oauth?: PublicApiOAuthConfig }

export interface PublicFolderSourceConfig {
  id: string
  name: string
  slug: string
  enabled: boolean
  provider: string
  type: SourceType
  mcp?: PublicMcpSourceConfig
  api?: PublicApiSourceConfig
  local?: PublicLocalSourceConfig
  icon?: string
  tagline?: string
  brand?: PublicSourceBrand
  isAuthenticated?: boolean
  connectionStatus?: SourceConnectionStatus
  connectionError?: string
  lastTestedAt?: number
  expectedTools?: PublicSourceExpectedTool[]
  readiness?: PublicSourceReadinessEvidence
  createdAt?: number
  updatedAt?: number
}

export type PublicSourceGuide = Omit<SourceGuide, 'cache'>

export interface PublicSourceDto extends Omit<LoadedSource, 'config' | 'guide'> {
  config: PublicFolderSourceConfig
  guide: PublicSourceGuide | null
}

const SAFE_TOOL_IDENTITY_PART = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/

export function isPortablePublicToolName(value: string): boolean {
  return SAFE_TOOL_IDENTITY_PART.test(value)
}

function toPublicToolIdentities(tools: SourceExpectedTool[] | undefined): PublicSourceExpectedTool[] | undefined {
  if (tools === undefined) return undefined
  const publicTools: PublicSourceExpectedTool[] = []
  for (const tool of tools) {
    if (
      isPortablePublicToolName(tool.name)
      && SAFE_TOOL_IDENTITY_PART.test(tool.apiVersion)
    ) {
      publicTools.push({ name: tool.name, apiVersion: tool.apiVersion })
    }
  }
  return publicTools
}

export const sanitizePublicSourceUrl = sanitizePublicUrl

const REDACTED_VALUE = '[REDACTED]'
const PUBLIC_URL_IN_TEXT = /https?:(?:\/\/|\\\/\\\/)(?:[^\s<>"'\\,;}\]]|\\\/)+/gi
const CREDENTIAL_ASSIGNMENT = /(?:\\?["']?)([A-Za-z][A-Za-z0-9_-]*)(?:\\?["']?)\s*[:=]\s*/g

function redactCredentialValue(key: string, value: string): string {
  if (key.toLowerCase() !== 'authorization') return REDACTED_VALUE
  const scheme = value.match(/^\s*((?:bearer|basic)\s+)/i)
  return scheme ? `${scheme[1]}${REDACTED_VALUE}` : REDACTED_VALUE
}

function findQuotedValueEnd(value: string, start: number, delimiter: '"' | "'" | '\\"' | "\\'"): number {
  if (delimiter.startsWith('\\')) {
    let candidate = value.indexOf(delimiter, start + delimiter.length)
    let lastCandidate = -1
    while (candidate !== -1) {
      lastCandidate = candidate
      const remainder = value.slice(candidate + delimiter.length)
      const next = remainder.match(/^\s*([,;}\]\r\n]|$)/)?.[1]
      if (next !== undefined) return candidate
      candidate = value.indexOf(delimiter, candidate + delimiter.length)
    }
    return lastCandidate
  }

  for (let index = start + 1; index < value.length; index += 1) {
    if (value[index] === '\\') {
      index += 1
      continue
    }
    if (value[index] === delimiter) return index
  }
  return -1
}

function sanitizeCredentialAssignments(value: string): string {
  let result = ''
  let cursor = 0
  CREDENTIAL_ASSIGNMENT.lastIndex = 0

  for (let match = CREDENTIAL_ASSIGNMENT.exec(value); match; match = CREDENTIAL_ASSIGNMENT.exec(value)) {
    const key = match[1]
    if (!key || !isSensitiveCredentialName(key)) continue

    const valueStart = CREDENTIAL_ASSIGNMENT.lastIndex
    result += value.slice(cursor, valueStart)

    const first = value[valueStart]
    const escapedQuote = first === '\\' && (value[valueStart + 1] === '"' || value[valueStart + 1] === "'")
    const delimiter = escapedQuote
      ? value.slice(valueStart, valueStart + 2) as '\\"' | "\\'"
      : first === '"' || first === "'"
        ? first
        : undefined

    if (delimiter !== undefined) {
      const end = findQuotedValueEnd(value, valueStart, delimiter)
      const contentStart = valueStart + delimiter.length
      const contentEnd = end === -1 ? value.length : end
      result += delimiter
      result += redactCredentialValue(key, value.slice(contentStart, contentEnd))
      if (end !== -1) result += delimiter
      cursor = end === -1 ? value.length : end + delimiter.length
      CREDENTIAL_ASSIGNMENT.lastIndex = cursor
      continue
    }

    let valueEnd = valueStart
    while (valueEnd < value.length && !/[,;}\]\r\n\uE000]/.test(value[valueEnd] ?? '')) {
      valueEnd += 1
    }
    const rawValueWithContext = value.slice(valueStart, valueEnd)
    const contextSuffix = value[valueEnd] === '\uE000'
      ? rawValueWithContext.match(/\s+(?:at|from)\s*$/i)?.[0]
      : undefined
    if (contextSuffix) valueEnd -= contextSuffix.length
    const rawValue = value.slice(valueStart, valueEnd)
    const trailingWhitespace = rawValue.match(/[ \t]*$/)?.[0] ?? ''
    result += redactCredentialValue(key, rawValue.trimEnd())
    result += trailingWhitespace
    cursor = valueEnd
    CREDENTIAL_ASSIGNMENT.lastIndex = valueEnd
  }

  return result + value.slice(cursor)
}

export function sanitizeSourceConnectionError(value: string): string {
  const sanitizedUrls: string[] = []
  const withoutUrls = value.replace(PUBLIC_URL_IN_TEXT, (url) => {
    const normalizedUrl = url.replace(/\\\//g, '/')
    const index = sanitizedUrls.push(sanitizePublicUrl(normalizedUrl) ?? REDACTED_VALUE) - 1
    return `\uE000${index}\uE001`
  })
  const sanitized = sanitizeCredentialAssignments(withoutUrls)
  return sanitized.replace(/\uE000(\d+)\uE001/g, (_placeholder, index: string) => (
    sanitizedUrls[Number(index)] ?? REDACTED_VALUE
  ))
}

export function sanitizePublicSourceError(value: string): string {
  return sanitizeSourceConnectionError(value)
}

function sanitizePublicIcon(value: string | undefined): string | undefined {
  if (value === undefined || !/^https?:\/\//i.test(value)) return value
  return sanitizePublicUrl(value)
}

function toPublicGuide(guide: SourceGuide | null): PublicSourceGuide | null {
  if (guide === null) return null
  return {
    raw: sanitizePublicSourceError(guide.raw),
    ...(guide.scope === undefined ? {} : { scope: sanitizePublicSourceError(guide.scope) }),
    ...(guide.guidelines === undefined ? {} : { guidelines: sanitizePublicSourceError(guide.guidelines) }),
    ...(guide.context === undefined ? {} : { context: sanitizePublicSourceError(guide.context) }),
    ...(guide.apiNotes === undefined ? {} : { apiNotes: sanitizePublicSourceError(guide.apiNotes) }),
  }
}

function toPublicMcpConfig(config: McpSourceConfig | undefined): PublicMcpSourceConfig | undefined {
  if (config === undefined) return undefined
  const url = sanitizePublicUrl(config.url)
  return {
    ...(config.transport === undefined ? {} : { transport: config.transport }),
    ...(url === undefined ? {} : { url }),
    ...(config.authType === undefined ? {} : { authType: config.authType }),
    ...(config.clientId === undefined ? {} : { clientId: config.clientId }),
  }
}

function toPublicOAuthConfig(config: ApiOAuthConfig | undefined): PublicApiOAuthConfig | undefined {
  if (config === undefined) return undefined
  const authorizationUrl = sanitizePublicUrl(config.authorizationUrl)
  const tokenUrl = sanitizePublicUrl(config.tokenUrl)
  if (authorizationUrl === undefined || tokenUrl === undefined) return undefined
  return {
    authorizationUrl,
    tokenUrl,
    clientId: config.clientId,
    ...(config.scopes === undefined ? {} : { scopes: [...config.scopes] }),
    ...(config.audience === undefined ? {} : { audience: config.audience }),
  }
}

function toPublicApiConfig(config: ApiSourceConfig | undefined): PublicApiSourceConfig | undefined {
  if (config === undefined) return undefined
  const baseUrl = sanitizePublicUrl(config.baseUrl)
  if (baseUrl === undefined) return undefined
  const oauth = toPublicOAuthConfig(config.oauth)
  return {
    baseUrl,
    authType: config.authType,
    ...(config.headerName === undefined ? {} : { headerName: config.headerName }),
    ...(config.headerNames === undefined ? {} : { headerNames: [...config.headerNames] }),
    ...(config.queryParam === undefined ? {} : { queryParam: config.queryParam }),
    ...(config.authScheme === undefined ? {} : { authScheme: config.authScheme }),
    ...(config.googleService === undefined ? {} : { googleService: config.googleService }),
    ...(config.googleScopes === undefined ? {} : { googleScopes: [...config.googleScopes] }),
    ...(config.googleOAuthClientId === undefined ? {} : { googleOAuthClientId: config.googleOAuthClientId }),
    ...(config.slackService === undefined ? {} : { slackService: config.slackService }),
    ...(config.slackUserScopes === undefined ? {} : { slackUserScopes: [...config.slackUserScopes] }),
    ...(config.microsoftService === undefined ? {} : { microsoftService: config.microsoftService }),
    ...(config.microsoftScopes === undefined ? {} : { microsoftScopes: [...config.microsoftScopes] }),
    ...(oauth === undefined ? {} : { oauth }),
  }
}

export function toPublicSourceDto(source: LoadedSource): PublicSourceDto {
  const { config } = source
  const mcp = toPublicMcpConfig(config.mcp)
  const api = toPublicApiConfig(config.api)
  const icon = sanitizePublicIcon(config.icon)
  const expectedTools = toPublicToolIdentities(config.expectedTools)
  const observedTools = toPublicToolIdentities(config.readiness?.observedTools)
  return {
    config: {
      id: config.id,
      name: sanitizePublicSourceError(config.name),
      slug: config.slug,
      enabled: config.enabled,
      provider: sanitizePublicSourceError(config.provider),
      type: config.type,
      ...(mcp === undefined ? {} : { mcp }),
      ...(api === undefined ? {} : { api }),
      ...(config.local === undefined
        ? {}
        : {
            local: {
              path: config.local.path,
              ...(config.local.format === undefined ? {} : { format: config.local.format }),
            },
          }),
      ...(icon === undefined ? {} : { icon }),
      ...(config.tagline === undefined ? {} : { tagline: sanitizePublicSourceError(config.tagline) }),
      ...(config.brand === undefined
        ? {}
        : {
            brand: {
              ...(config.brand.color === undefined ? {} : { color: config.brand.color }),
            },
          }),
      ...(config.isAuthenticated === undefined ? {} : { isAuthenticated: config.isAuthenticated }),
      ...(config.connectionStatus === undefined ? {} : { connectionStatus: config.connectionStatus }),
      ...(config.connectionError === undefined
        ? {}
        : { connectionError: sanitizePublicSourceError(config.connectionError) }),
      ...(config.lastTestedAt === undefined ? {} : { lastTestedAt: config.lastTestedAt }),
      ...(expectedTools === undefined
        ? {}
        : { expectedTools }),
      ...(config.readiness === undefined
        ? {}
        : {
            readiness: {
              status: config.readiness.status,
              checkedAt: config.readiness.checkedAt,
              ...(config.readiness.reason === undefined ? {} : { reason: config.readiness.reason }),
              ...(observedTools === undefined
                ? {}
                : { observedTools }),
            },
          }),
      ...(config.createdAt === undefined ? {} : { createdAt: config.createdAt }),
      ...(config.updatedAt === undefined ? {} : { updatedAt: config.updatedAt }),
    },
    guide: toPublicGuide(source.guide),
    folderPath: source.folderPath,
    workspaceRootPath: source.workspaceRootPath,
    workspaceId: source.workspaceId,
    ...(source.isBuiltin === undefined ? {} : { isBuiltin: source.isBuiltin }),
    ...(source.iconPath === undefined ? {} : { iconPath: source.iconPath }),
  }
}

export function toPublicSourceDtos(sources: readonly LoadedSource[]): PublicSourceDto[] {
  return sources.map(toPublicSourceDto)
}
