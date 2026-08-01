const SENSITIVE_PARAMETER_NAME = /^(?:key|api[-_]?key|(?:access[-_]?|refresh[-_]?|auth[-_]?)?token|credentials?|secret|password|authorization|x-amz-(?:signature|credential|security-token))$/i
const SENSITIVE_PATH_MARKER = /^(?:key|api[-_]?key|(?:access[-_]?|refresh[-_]?|auth[-_]?)?token|credentials?|secret|password|authorization|x-amz-(?:signature|credential|security-token))$/i

function hashContainsCredentialParameter(hash: string): boolean {
  if (!hash) return false
  const fragment = hash.slice(1)
  const query = fragment.includes('?') ? fragment.slice(fragment.indexOf('?') + 1) : fragment
  return [...new URLSearchParams(query).keys()].some((name) => SENSITIVE_PARAMETER_NAME.test(name))
}

export function hasExplicitCredentialMaterial(url: URL): boolean {
  if (url.username || url.password) return true
  if ([...url.searchParams.keys()].some((name) => SENSITIVE_PARAMETER_NAME.test(name))) return true
  if (hashContainsCredentialParameter(url.hash)) return true

  const pathSegments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  return pathSegments.some((segment, index) => (
    SENSITIVE_PATH_MARKER.test(segment) && pathSegments[index + 1] !== undefined
  ))
}

export function sanitizePublicUrl(value: string | undefined): string | undefined {
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
    if (hashContainsCredentialParameter(url.hash)) {
      url.hash = '[REDACTED]'
    }
    const pathSegments = url.pathname.split('/')
    for (let index = 0; index < pathSegments.length - 1; index += 1) {
      const segment = decodeURIComponent(pathSegments[index] ?? '')
      if (SENSITIVE_PATH_MARKER.test(segment) && pathSegments[index + 1]) {
        pathSegments[index + 1] = encodeURIComponent('[REDACTED]')
      }
    }
    url.pathname = pathSegments.join('/')
    return url.toString()
  } catch {
    return undefined
  }
}
