import { unzipSync } from 'fflate'

export interface TabularColumn {
  key: string
  label: string
  type?: 'text' | 'number'
}

export interface TabularData {
  title?: string
  filename?: string
  sheetName?: string
  columns: TabularColumn[]
  rows: Record<string, unknown>[]
}

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

function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

function getFileName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.split('/').pop() || filePath
}

function getExtension(filePath: string): string {
  const fileName = getFileName(filePath)
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : ''
}

export function buildTabularPreviewCodeFromPlainPath(
  code: string,
  language: string | undefined,
): { blockType: 'datatable' | 'spreadsheet'; previewCode: string } | null {
  if (!isPlainTextLanguage(language)) return null

  const trimmed = stripWrappingQuotes(code.trim())
  if (!trimmed || trimmed.includes('\n') || !isAbsolutePath(trimmed)) return null

  const ext = getExtension(trimmed)
  if (ext === 'csv' || ext === 'tsv') {
    return {
      blockType: 'datatable',
      previewCode: JSON.stringify({ src: trimmed, title: getFileName(trimmed) }, null, 2),
    }
  }

  if (ext === 'xlsx') {
    return {
      blockType: 'spreadsheet',
      previewCode: JSON.stringify({ src: trimmed, filename: getFileName(trimmed) }, null, 2),
    }
  }

  return null
}

function countDelimiter(line: string, delimiter: string): number {
  let count = 0
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        i += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (!inQuotes && char === delimiter) {
      count += 1
    }
  }

  return count
}

function detectDelimiter(content: string, sourcePath?: string): ',' | '\t' {
  if (sourcePath?.toLowerCase().endsWith('.tsv')) return '\t'
  const firstLine = content.split(/\r?\n/, 1)[0] || ''
  return countDelimiter(firstLine, '\t') > countDelimiter(firstLine, ',') ? '\t' : ','
}

function parseDelimitedRows(content: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i]

    if (char === '"') {
      if (inQuotes && content[i + 1] === '"') {
        cell += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (!inQuotes && char === delimiter) {
      row.push(cell)
      cell = ''
      continue
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && content[i + 1] === '\n') i += 1
      row.push(cell)
      if (row.some((value) => value.trim() !== '')) rows.push(row)
      row = []
      cell = ''
      continue
    }

    cell += char
  }

  row.push(cell)
  if (row.some((value) => value.trim() !== '')) rows.push(row)
  return rows
}

function normalizeHeader(value: string, index: number, used: Set<string>): TabularColumn {
  const label = value.trim() || `Column ${index + 1}`
  const baseKey = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || `column_${index + 1}`

  let key = baseKey
  let suffix = 2
  while (used.has(key)) {
    key = `${baseKey}_${suffix}`
    suffix += 1
  }
  used.add(key)

  return { key, label }
}

function coerceCellValue(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''

  const normalized = trimmed.replace(/,/g, '')
  if (/^-?\d+(\.\d+)?$/.test(normalized)) {
    return Number(normalized)
  }

  return trimmed
}

function inferColumnTypes(columns: TabularColumn[], rows: Record<string, unknown>[]): TabularColumn[] {
  return columns.map((column) => {
    const values = rows
      .map((row) => row[column.key])
      .filter((value) => value !== '' && value !== null && value !== undefined)
    const numericCount = values.filter((value) => typeof value === 'number').length
    return values.length > 0 && numericCount === values.length
      ? { ...column, type: 'number' }
      : { ...column, type: 'text' }
  })
}

export function parseDelimitedTabularData(
  content: string,
  sourcePath?: string,
): TabularData {
  const delimiter = detectDelimiter(content, sourcePath)
  const rawRows = parseDelimitedRows(content, delimiter)
  if (rawRows.length === 0) {
    return { title: sourcePath ? getFileName(sourcePath) : undefined, columns: [], rows: [] }
  }

  const used = new Set<string>()
  const columns = rawRows[0].map((header, index) => normalizeHeader(header, index, used))
  const rows = rawRows.slice(1).map((rawRow) => {
    const row: Record<string, unknown> = {}
    columns.forEach((column, index) => {
      row[column.key] = coerceCellValue(rawRow[index] ?? '')
    })
    return row
  })

  return {
    title: sourcePath ? getFileName(sourcePath) : undefined,
    filename: sourcePath ? getFileName(sourcePath) : undefined,
    columns: inferColumnTypes(columns, rows),
    rows,
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function getAttr(attrs: string, name: string): string | undefined {
  const escaped = name.replace(':', ':')
  const pattern = new RegExp(`\\s${escaped}="([^"]*)"`)
  return pattern.exec(attrs)?.[1]
}

function columnIndexFromRef(ref: string): number {
  const letters = ref.match(/^[A-Z]+/i)?.[0].toUpperCase() ?? ''
  let index = 0
  for (const letter of letters) {
    index = index * 26 + (letter.charCodeAt(0) - 64)
  }
  return Math.max(0, index - 1)
}

function readZipText(files: Record<string, Uint8Array>, path: string): string | null {
  const bytes = files[path]
  return bytes ? new TextDecoder().decode(bytes) : null
}

function parseSharedStrings(xml: string | null): string[] {
  if (!xml) return []

  const strings: string[] = []
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    const text = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((part) => decodeXml(part[1]))
      .join('')
    strings.push(text)
  }
  return strings
}

function getFirstWorksheetPath(files: Record<string, Uint8Array>): { sheetName?: string; path: string } {
  const workbook = readZipText(files, 'xl/workbook.xml')
  const rels = readZipText(files, 'xl/_rels/workbook.xml.rels')
  if (!workbook || !rels) return { path: 'xl/worksheets/sheet1.xml' }

  const sheetMatch = /<sheet\b([^>]*)\/?>/.exec(workbook)
  const sheetAttrs = sheetMatch?.[1] ?? ''
  const sheetName = sheetAttrs ? decodeXml(getAttr(sheetAttrs, 'name') ?? '') : undefined
  const relId = sheetAttrs ? getAttr(sheetAttrs, 'r:id') : undefined
  if (!relId) return { sheetName, path: 'xl/worksheets/sheet1.xml' }

  const relPattern = new RegExp(`<Relationship\\b(?=[^>]*\\sId="${relId}")[^>]*\\sTarget="([^"]*)"[^>]*/?>`)
  const target = relPattern.exec(rels)?.[1] ?? 'worksheets/sheet1.xml'
  return {
    sheetName,
    path: target.startsWith('xl/') ? target : `xl/${target.replace(/^\//, '')}`,
  }
}

function parseWorksheetRows(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = []

  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = []
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1]
      const body = cellMatch[2]
      const ref = getAttr(attrs, 'r') ?? ''
      const index = ref ? columnIndexFromRef(ref) : row.length
      const type = getAttr(attrs, 't')
      const rawValue = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1]
        ?? /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1]
        ?? ''

      const decoded = decodeXml(rawValue)
      row[index] = type === 's' ? (sharedStrings[Number(decoded)] ?? '') : decoded
    }
    if (row.some((value) => value !== undefined && value !== '')) rows.push(row)
  }

  return rows
}

export function parseXlsxTabularData(data: Uint8Array, sourcePath?: string): TabularData {
  const files = unzipSync(data)
  const { sheetName, path } = getFirstWorksheetPath(files)
  const worksheet = readZipText(files, path)
  if (!worksheet) {
    throw new Error('Workbook does not contain a readable worksheet')
  }

  const sharedStrings = parseSharedStrings(readZipText(files, 'xl/sharedStrings.xml'))
  const rows = parseWorksheetRows(worksheet, sharedStrings)
  const delimited = rows.map((row) => row.map((cell) => {
    const escaped = String(cell ?? '').replace(/"/g, '""')
    return /[",\n\r]/.test(escaped) ? `"${escaped}"` : escaped
  }).join(',')).join('\n')
  const parsed = parseDelimitedTabularData(delimited, sourcePath)

  return {
    ...parsed,
    filename: sourcePath ? getFileName(sourcePath) : parsed.filename,
    sheetName,
  }
}
