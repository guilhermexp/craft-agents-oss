const SENSITIVE_CREDENTIAL_NAMES = new Set([
  'accessToken',
  'apiKey',
  'authorization',
  'authToken',
  'clientSecret',
  'consumerSecret',
  'credential',
  'credentials',
  'key',
  'password',
  'privateKey',
  'providerSecret',
  'refreshToken',
  'secret',
  'securityToken',
  'signature',
  'signedUrl',
  'token',
  'xAmzCredential',
  'xAmzSecurityToken',
  'xAmzSignature',
].map((name) => name.toLowerCase()))

export function normalizeCredentialName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function isSensitiveCredentialName(value: string): boolean {
  return SENSITIVE_CREDENTIAL_NAMES.has(normalizeCredentialName(value))
}

function hashContainsCredentialParameter(hash: string): boolean {
  if (!hash) return false
  const fragment = hash.slice(1)
  const query = fragment.includes('?') ? fragment.slice(fragment.indexOf('?') + 1) : fragment
  return [...new URLSearchParams(query).keys()].some(isSensitiveCredentialName)
}

export function hasExplicitCredentialMaterial(url: URL): boolean {
  if (url.username || url.password) return true
  if ([...url.searchParams.keys()].some(isSensitiveCredentialName)) return true
  if (hashContainsCredentialParameter(url.hash)) return true

  const pathSegments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  return pathSegments.some((segment, index) => (
    isSensitiveCredentialName(segment) && pathSegments[index + 1] !== undefined
  ))
}

export function sanitizePublicUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    for (const parameterName of [...url.searchParams.keys()]) {
      if (isSensitiveCredentialName(parameterName)) {
        url.searchParams.set(parameterName, '[REDACTED]')
      }
    }
    if (hashContainsCredentialParameter(url.hash)) {
      url.hash = '[REDACTED]'
    }
    const pathSegments = url.pathname.split('/')
    for (let index = 0; index < pathSegments.length - 1; index += 1) {
      const segment = decodeURIComponent(pathSegments[index] ?? '')
      if (isSensitiveCredentialName(segment) && pathSegments[index + 1]) {
        pathSegments[index + 1] = encodeURIComponent('[REDACTED]')
      }
    }
    url.pathname = pathSegments.join('/')
    return url.toString().replace(/%5Bredacted%5D/gi, '[REDACTED]')
  } catch {
    return undefined
  }
}
