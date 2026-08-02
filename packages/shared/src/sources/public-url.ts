const SENSITIVE_CREDENTIAL_NAMES = new Set([
  'accessKeyId',
  'accessToken',
  'apiKey',
  'authorization',
  'authToken',
  'awsAccessKeyId',
  'awsSecretAccessKey',
  'awsSessionToken',
  'clientSecret',
  'consumerSecret',
  'credential',
  'credentials',
  'idToken',
  'key',
  'oauthConsumerSecret',
  'oauthToken',
  'oauthTokenSecret',
  'password',
  'privateKey',
  'providerSecret',
  'refreshToken',
  'secret',
  'secretAccessKey',
  'securityToken',
  'sessionToken',
  'signature',
  'signedUrl',
  'token',
  'xAmzCredential',
  'xAmzSecurityToken',
  'xAmzSignature',
].map((name) => name.toLowerCase()))

/**
 * A name is sensitive when any TRAILING run of its words spells one of the
 * names above. Words split on separators and camelCase boundaries, so
 * `x-api-key`, `X_API_KEY` and `xApiKey` all reduce to `['x','api','key']`.
 *
 * Vendor-prefixed headers are the reason this is not an exact-match lookup:
 * `x-api-key`, `X-Auth-Token`, `Private-Token` and `x-goog-api-key` are all
 * credentials, and matching the whole normalized name let every one of them
 * through into public DTOs.
 *
 * Suffix-anchored on purpose. That restores the boundary semantics of the
 * regex this allowlist replaced — it only matched a sensitive word sitting
 * immediately before the `:`/`=`, i.e. at the end of the key. Plain
 * containment would additionally redact `monkey`, `keyword` and `tokenCount`.
 */
export function isSensitiveCredentialName(value: string): boolean {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())

  for (let start = 0; start < words.length; start += 1) {
    if (SENSITIVE_CREDENTIAL_NAMES.has(words.slice(start).join(''))) return true
  }
  return false
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
