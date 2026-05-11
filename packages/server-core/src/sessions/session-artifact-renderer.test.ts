import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionArtifactRenderer } from './session-artifact-renderer'

const tempDirs: string[] = []

async function makeSessionDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'craft-session-artifacts-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('SessionArtifactRenderer', () => {
  it('does not expose hidden diagram source files when scanning session files', async () => {
    const sessionPath = await makeSessionDir()
    await writeFile(join(sessionPath, 'session.jsonl'), '{}\n', 'utf-8')
    await writeFile(join(sessionPath, 'notes.md'), 'note', 'utf-8')
    await Bun.$`mkdir -p ${join(sessionPath, '.diagram-sources')} ${join(sessionPath, 'diagrams')}`.quiet()
    await writeFile(join(sessionPath, '.diagram-sources', 'hidden.mmd'), 'graph TD\nA-->B', 'utf-8')
    await writeFile(join(sessionPath, 'diagrams', 'visible.svg'), '<svg />', 'utf-8')
    await writeFile(join(sessionPath, 'diagrams', 'legacy.mmd'), 'graph TD\nA-->B', 'utf-8')

    const renderer = new SessionArtifactRenderer()
    const files = await renderer.scanSessionFiles(sessionPath)

    expect(files.map(file => file.name)).toEqual(['diagrams', 'notes.md'])
    const diagrams = files.find(file => file.name === 'diagrams')
    expect(diagrams?.children?.map(file => file.name)).toEqual(['visible.svg'])
  })

  it('degrades invalid Mermaid rendering without throwing or corrupting the file tree', async () => {
    const sessionPath = await makeSessionDir()
    await writeFile(
      join(sessionPath, 'session.jsonl'),
      [
        '{}',
        JSON.stringify({ id: 'msg-1', content: '```mermaid\nthis is not valid mermaid\n```' }),
        '',
      ].join('\n'),
      'utf-8',
    )

    const renderer = new SessionArtifactRenderer()
    await expect(renderer.syncSessionArtifacts(sessionPath)).resolves.toBeUndefined()
    await expect(renderer.scanSessionFiles(sessionPath)).resolves.toBeArray()
  })
})
