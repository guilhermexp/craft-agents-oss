const PLAIN_TEXT_LANGUAGES = new Set(['txt', 'text', 'plaintext'])

function isPlainTextLanguage(language: string | undefined): boolean {
  return language === undefined || PLAIN_TEXT_LANGUAGES.has(language.toLowerCase())
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value

  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1).trim()
  }

  return value
}

function isAbsolutePdfPath(value: string): boolean {
  if (!/\.pdf$/i.test(value)) return false

  return (
    value.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(value)
  )
}

function getFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.split('/').pop() || filePath
}

export function buildPdfPreviewCodeFromPlainPath(
  code: string,
  language: string | undefined,
): string | null {
  if (!isPlainTextLanguage(language)) return null

  const trimmed = stripWrappingQuotes(code.trim())
  if (!trimmed || trimmed.includes('\n') || !isAbsolutePdfPath(trimmed)) {
    return null
  }

  return JSON.stringify(
    {
      src: trimmed,
      title: getFileName(trimmed),
    },
    null,
    2,
  )
}
