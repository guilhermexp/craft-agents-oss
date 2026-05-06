import { describe, expect, it } from 'bun:test'
import { resolveOpenFilePath } from '../resolve-open-file-path'

interface VirtualFile {
  path: string
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function relativePath(basePath: string, fullPath: string): string {
  const normalizedBase = basePath.replace(/\/+$/, '')
  return fullPath.slice(normalizedBase.length + 1)
}

function createSearchFiles(files: VirtualFile[]) {
  return async (basePath: string, query: string) => {
    const normalizedBase = basePath.replace(/\/+$/, '')
    return files
      .filter((file) => file.path.startsWith(`${normalizedBase}/`) && basename(file.path) === query)
      .map((file) => ({
        name: basename(file.path),
        path: file.path,
        type: 'file' as const,
        relativePath: relativePath(normalizedBase, file.path),
      }))
  }
}

describe('resolveOpenFilePath', () => {
  it('resolves relative image paths against the active working directory', async () => {
    const searchFiles = createSearchFiles([
      { path: '/workspace/project/assets/recreated_old_way_new_way_wide.png' },
    ])

    const result = await resolveOpenFilePath({
      path: 'assets/recreated_old_way_new_way_wide.png',
      baseDirs: ['/workspace/project'],
      searchFiles,
    })

    expect(result.path).toBe('/workspace/project/assets/recreated_old_way_new_way_wide.png')
    expect(result.fallbackPath).toBeUndefined()
  })

  it('strips the current session id when resolving files inside the session folder', async () => {
    const searchFiles = createSearchFiles([
      { path: '/workspace/sessions/260506-lively-spray/Autoclaude_Visual_Guide_recreated_page4.pdf' },
    ])

    const result = await resolveOpenFilePath({
      path: '260506-lively-spray/Autoclaude_Visual_Guide_recreated_page4.pdf',
      sessionId: '260506-lively-spray',
      baseDirs: ['/workspace/sessions/260506-lively-spray'],
      searchFiles,
    })

    expect(result.path).toBe('/workspace/sessions/260506-lively-spray/Autoclaude_Visual_Guide_recreated_page4.pdf')
    expect(result.fallbackPath).toBe('/workspace/sessions/260506-lively-spray/Autoclaude_Visual_Guide_recreated_page4.pdf')
  })

  it('falls back to a unique basename match across global preview base dirs', async () => {
    const searchFiles = createSearchFiles([
      { path: '/workspace/sessions/260506-lively-spray/assets/recreated_old_way_new_way_wide.png' },
    ])

    const result = await resolveOpenFilePath({
      path: 'assets/recreated_old_way_new_way_wide.png',
      sessionId: '260506-lively-spray',
      baseDirs: ['/workspace/project', '/workspace/sessions/260506-lively-spray'],
      searchFiles,
    })

    expect(result.path).toBe('/workspace/sessions/260506-lively-spray/assets/recreated_old_way_new_way_wide.png')
    expect(result.fallbackPath).toBe('/workspace/sessions/260506-lively-spray/assets/recreated_old_way_new_way_wide.png')
  })

  it('uses the immutable sdk cwd before the mutable session working directory', async () => {
    const searchFiles = createSearchFiles([
      { path: '/workspace/autocode-os/Autoclaude_Visual_Guide_recreated_page4.pdf' },
    ])

    const result = await resolveOpenFilePath({
      path: '260506-lively-spray/Autoclaude_Visual_Guide_recreated_page4.pdf',
      sessionId: '260506-lively-spray',
      baseDirs: [
        '/workspace/autocode-os',
        '/workspace/sessions/260506-lively-spray',
      ],
      searchFiles,
    })

    expect(result.path).toBe('/workspace/autocode-os/Autoclaude_Visual_Guide_recreated_page4.pdf')
    expect(result.fallbackPath).toBe('/workspace/autocode-os/Autoclaude_Visual_Guide_recreated_page4.pdf')
  })
})
