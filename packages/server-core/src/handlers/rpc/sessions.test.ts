import { describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { syncMermaidDiagramArtifacts } from './sessions'

describe('syncMermaidDiagramArtifacts', () => {
  it('persists Mermaid code fences as session diagram files', async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), 'craft-session-diagrams-'))
    const sessionFile = join(sessionDir, 'session.jsonl')
    await mkdir(join(sessionDir, 'diagrams'))
    await writeFile(join(sessionDir, 'diagrams', 'legacy-visible-source.mmd'), 'old source', 'utf-8')
    await writeFile(
      sessionFile,
      [
        JSON.stringify({ id: 'session-1', workspaceRootPath: sessionDir, createdAt: 1, lastUsedAt: 1 }),
        JSON.stringify({
          id: 'msg-1',
          type: 'assistant',
          content: 'Here is a diagram:\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```',
        }),
      ].join('\n') + '\n',
      'utf-8'
    )

    await syncMermaidDiagramArtifacts(sessionDir)

    const diagramFiles = await readdir(join(sessionDir, 'diagrams'))
    const svgFile = diagramFiles.find((name) => name.endsWith('.svg'))
    const sourceFiles = await readdir(join(sessionDir, '.diagram-sources'))
    const sourceFile = sourceFiles.find((name) => name.endsWith('.mmd'))

    expect(diagramFiles.some((name) => name.endsWith('.mmd'))).toBe(false)
    expect(svgFile).toBeDefined()
    expect(sourceFile).toBeDefined()

    const source = await readFile(join(sessionDir, '.diagram-sources', sourceFile!), 'utf-8')
    const svg = await readFile(join(sessionDir, 'diagrams', svgFile!), 'utf-8')

    expect(source).toContain('graph TD')
    expect(source).toContain('A[Start] --> B[End]')
    expect(svg.trim().startsWith('<svg')).toBe(true)
    expect(svg).not.toContain('var(--')
  })
})
