import type {
  ApiOAuthConfig,
  ApiSourceConfig,
  FolderSourceConfig,
  LoadedSource,
  LocalSourceConfig,
  McpSourceConfig,
  SourceGuide,
  SourceExpectedTool,
} from './types.ts'

export type PublicMcpSourceConfig = Pick<
  McpSourceConfig,
  'transport' | 'url' | 'authType' | 'clientId'
>

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

export interface PublicFolderSourceConfig extends Omit<
  FolderSourceConfig,
  'mcp' | 'api' | 'local' | 'connectionError'
> {
  mcp?: PublicMcpSourceConfig
  api?: PublicApiSourceConfig
  local?: LocalSourceConfig
  connectionError?: string
}

export type PublicSourceGuide = Omit<SourceGuide, 'cache'>

export interface PublicSourceDto extends Omit<LoadedSource, 'config' | 'guide'> {
  config: PublicFolderSourceConfig
  guide: PublicSourceGuide | null
}

const SENSITIVE_PARAMETER_NAME = /(?:^|[_-])(?:access|refresh|auth)?token(?:$|[_-])|secret|credential|password|api[_-]?key|authorization/i
const SAFE_TOOL_IDENTITY_PART = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/

function toPublicToolIdentities(tools: SourceExpectedTool[] | undefined): SourceExpectedTool[] | undefined {
  if (tools === undefined) return undefined
  const publicTools: SourceExpectedTool[] = []
  for (const tool of tools) {
    if (
      SAFE_TOOL_IDENTITY_PART.test(tool.name)
      && SAFE_TOOL_IDENTITY_PART.test(tool.apiVersion)
    ) {
      publicTools.push({ ...tool })
    }
  }
  return publicTools
}

function sanitizePublicUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    for (const parameterName of [...url.searchParams.keys()]) {
      if (SENSITIVE_PARAMETER_NAME.test(parameterName)) {
        url.searchParams.set(parameterName, '[REDACTED]')
      }
    }
    return url.toString()
  } catch {
    return undefined
  }
}

export function sanitizeSourceConnectionError(value: string): string {
  return value
    .replace(
      /(\bauthorization\s*:\s*(?:bearer|basic)\s+)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
    .replace(
      /(\b(?:access[_-]?token|refresh[_-]?token|token|api[_-]?key|provider[_-]?secret|secret|credentials?|password)\s*[:=]\s*)[^\s,;]+/gi,
      '$1[REDACTED]',
    )
}

function sanitizePublicIcon(value: string | undefined): string | undefined {
  if (value === undefined || !/^https?:\/\//i.test(value)) return value
  return sanitizePublicUrl(value)
}

function toPublicGuide(guide: SourceGuide | null): PublicSourceGuide | null {
  if (guide === null) return null
  return {
    raw: sanitizeSourceConnectionError(guide.raw),
    ...(guide.scope === undefined ? {} : { scope: sanitizeSourceConnectionError(guide.scope) }),
    ...(guide.guidelines === undefined ? {} : { guidelines: sanitizeSourceConnectionError(guide.guidelines) }),
    ...(guide.context === undefined ? {} : { context: sanitizeSourceConnectionError(guide.context) }),
    ...(guide.apiNotes === undefined ? {} : { apiNotes: sanitizeSourceConnectionError(guide.apiNotes) }),
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
      name: config.name,
      slug: config.slug,
      enabled: config.enabled,
      provider: config.provider,
      type: config.type,
      ...(mcp === undefined ? {} : { mcp }),
      ...(api === undefined ? {} : { api }),
      ...(config.local === undefined ? {} : { local: { ...config.local } }),
      ...(icon === undefined ? {} : { icon }),
      ...(config.tagline === undefined ? {} : { tagline: sanitizeSourceConnectionError(config.tagline) }),
      ...(config.brand === undefined ? {} : { brand: config.brand }),
      ...(config.isAuthenticated === undefined ? {} : { isAuthenticated: config.isAuthenticated }),
      ...(config.connectionStatus === undefined ? {} : { connectionStatus: config.connectionStatus }),
      ...(config.connectionError === undefined
        ? {}
        : { connectionError: sanitizeSourceConnectionError(config.connectionError) }),
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
