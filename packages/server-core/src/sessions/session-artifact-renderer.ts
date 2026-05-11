import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import type { SessionFile } from '@craft-agent/shared/protocol'

const MERMAID_FENCE_RE = /```[ \t]*mermaid[^\n]*\n([\s\S]*?)```/gi
const MAX_MERMAID_ARTIFACTS_PER_SESSION = 50
const MERMAID_SVG_COLORS = {
  bg: '#0f1117',
  fg: '#f4f4f5',
  accent: '#22c55e',
  line: '#9ca3af',
  muted: '#a1a1aa',
  surface: '#18181b',
  border: '#3f3f46',
  faint: '#71717a',
} as const

export interface ArtifactRenderResult {
  rendered: number
  skipped: number
}

function extractMermaidBlocksFromMarkdown(content: string): string[] {
  const blocks: string[] = []
  for (const match of content.matchAll(MERMAID_FENCE_RE)) {
    const code = match[1]?.trim()
    if (code) blocks.push(code)
  }
  return blocks
}

function stableDiagramName(sequence: number, messageId: string, code: string): string {
  const messagePart = messageId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 18) || 'message'
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 10)
  return `mermaid-${String(sequence).padStart(2, '0')}-${messagePart}-${hash}`
}

async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    const existing = await readFile(filePath, 'utf-8')
    if (existing === content) return
  } catch {
    // Artefato gerado ausente ou ilegível: reescreve abaixo.
  }
  await writeFile(filePath, content, 'utf-8')
}

async function removeVisibleMermaidSources(diagramsDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(diagramsDir)
  } catch {
    return
  }

  await Promise.all(
    entries
      .filter((name) => name.endsWith('.mmd'))
      .map((name) => unlink(join(diagramsDir, name)).catch(() => {})),
  )
}

function makeMermaidSvgStandalone(svg: string): string {
  const replacements = new Map<string, string>([
    ['var(--bg)', MERMAID_SVG_COLORS.bg],
    ['var(--fg)', MERMAID_SVG_COLORS.fg],
    ['var(--line)', MERMAID_SVG_COLORS.line],
    ['var(--accent)', MERMAID_SVG_COLORS.accent],
    ['var(--muted)', MERMAID_SVG_COLORS.muted],
    ['var(--surface)', MERMAID_SVG_COLORS.surface],
    ['var(--border)', MERMAID_SVG_COLORS.border],
    ['var(--_text)', MERMAID_SVG_COLORS.fg],
    ['var(--_text-sec)', MERMAID_SVG_COLORS.muted],
    ['var(--_text-muted)', MERMAID_SVG_COLORS.muted],
    ['var(--_text-faint)', MERMAID_SVG_COLORS.faint],
    ['var(--_line)', MERMAID_SVG_COLORS.line],
    ['var(--_arrow)', MERMAID_SVG_COLORS.accent],
    ['var(--_node-fill)', MERMAID_SVG_COLORS.surface],
    ['var(--_node-stroke)', MERMAID_SVG_COLORS.border],
    ['var(--_group-fill)', MERMAID_SVG_COLORS.bg],
    ['var(--_group-hdr)', MERMAID_SVG_COLORS.surface],
    ['var(--_inner-stroke)', MERMAID_SVG_COLORS.border],
    ['var(--_key-badge)', MERMAID_SVG_COLORS.surface],
  ])

  let standalone = svg
    .replace(/style="[^"]*background:var\(--bg\)[^"]*"/, `style="background:${MERMAID_SVG_COLORS.bg}"`)
    .replace(/<style>[\s\S]*?<\/style>\n?/, '<style>text { font-family: Inter, system-ui, sans-serif; }</style>\n')

  for (const [token, color] of replacements) {
    standalone = standalone.split(token).join(color)
  }

  return standalone
}

async function renderMermaidSvg(code: string): Promise<string | null> {
  try {
    const { renderMermaidSVG } = await import('beautiful-mermaid')
    const svg = renderMermaidSVG(code, {
      bg: MERMAID_SVG_COLORS.bg,
      fg: MERMAID_SVG_COLORS.fg,
      accent: MERMAID_SVG_COLORS.accent,
      line: MERMAID_SVG_COLORS.line,
      muted: MERMAID_SVG_COLORS.muted,
      surface: MERMAID_SVG_COLORS.surface,
      border: MERMAID_SVG_COLORS.border,
      transparent: false,
      interactive: true,
    })
    return makeMermaidSvgStandalone(svg)
  } catch {
    return null
  }
}

export class SessionArtifactRenderer {
  private readonly inFlight = new Map<string, Promise<ArtifactRenderResult>>()

  async syncSessionArtifacts(sessionPath: string): Promise<void> {
    await this.renderMermaidFromSession(sessionPath)
  }

  renderMermaidFromSession(sessionPath: string): Promise<ArtifactRenderResult> {
    const existing = this.inFlight.get(sessionPath)
    if (existing) return existing

    const render = this.renderMermaidFromSessionNow(sessionPath).finally(() => {
      this.inFlight.delete(sessionPath)
    })
    this.inFlight.set(sessionPath, render)
    return render
  }

  async scanSessionFiles(sessionPath: string): Promise<SessionFile[]> {
    return scanSessionDirectory(sessionPath)
  }

  private async renderMermaidFromSessionNow(sessionPath: string): Promise<ArtifactRenderResult> {
    const sessionFile = join(sessionPath, 'session.jsonl')
    let content: string
    try {
      content = await readFile(sessionFile, 'utf-8')
    } catch {
      return { rendered: 0, skipped: 0 }
    }

    const diagrams: Array<{ messageId: string; code: string }> = []
    const lines = content.split('\n').filter(Boolean).slice(1)
    for (const line of lines) {
      if (diagrams.length >= MAX_MERMAID_ARTIFACTS_PER_SESSION) break
      let parsed: { id?: unknown; content?: unknown }
      try {
        parsed = JSON.parse(line) as { id?: unknown; content?: unknown }
      } catch {
        continue
      }
      if (typeof parsed.content !== 'string') continue
      const blocks = extractMermaidBlocksFromMarkdown(parsed.content)
      for (const code of blocks) {
        if (diagrams.length >= MAX_MERMAID_ARTIFACTS_PER_SESSION) break
        diagrams.push({
          messageId: typeof parsed.id === 'string' ? parsed.id : `message-${diagrams.length + 1}`,
          code,
        })
      }
    }

    if (diagrams.length === 0) return { rendered: 0, skipped: 0 }

    const diagramsDir = join(sessionPath, 'diagrams')
    const sourceDir = join(sessionPath, '.diagram-sources')
    await Promise.all([
      mkdir(diagramsDir, { recursive: true }),
      mkdir(sourceDir, { recursive: true }),
    ])
    await removeVisibleMermaidSources(diagramsDir)

    const results = await Promise.all(diagrams.map(async ({ messageId, code }, index) => {
      const baseName = stableDiagramName(index + 1, messageId, code)
      const sourcePath = join(sourceDir, `${baseName}.mmd`)
      const svgPath = join(diagramsDir, `${baseName}.svg`)

      const source = `%% Generated from session Mermaid block. Edit the chat message to change the source.\n${code}\n`
      const svg = await renderMermaidSvg(code)
      await Promise.all([
        writeFileIfChanged(sourcePath, source),
        svg ? writeFileIfChanged(svgPath, svg) : Promise.resolve(),
      ])
      return svg ? 'rendered' : 'skipped'
    }))

    return {
      rendered: results.filter(result => result === 'rendered').length,
      skipped: results.filter(result => result === 'skipped').length,
    }
  }
}

async function scanSessionDirectory(dirPath: string): Promise<SessionFile[]> {
  const { readdir, stat } = await import('fs/promises')
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: SessionFile[] = []

  for (const entry of entries) {
    if (entry.name === 'session.jsonl' || entry.name.startsWith('.')) continue
    if (basename(dirPath) === 'diagrams' && entry.name.endsWith('.mmd')) continue

    const fullPath = join(dirPath, entry.name)

    if (entry.isDirectory()) {
      const children = await scanSessionDirectory(fullPath)
      if (children.length > 0) {
        files.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children,
        })
      }
    } else {
      const stats = await stat(fullPath)
      files.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
        size: stats.size,
      })
    }
  }

  return files.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}
