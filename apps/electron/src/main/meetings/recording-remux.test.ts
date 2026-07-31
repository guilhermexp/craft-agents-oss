import { describe, expect, it, mock } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLoggerModuleStub } from '../__tests__/logger-module-stub'

mock.module('../logger', () => createLoggerModuleStub())

const { remuxWebmForSeek } = await import('./recording-remux')

const tempDirs: string[] = []
const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

function fakeFfmpeg(mutator?: (input: string, output: string) => void) {
  return mock(async (_bin: string, args: string[]) => {
    const input = args[args.length - 2]!
    const output = args[args.length - 1]!
    mutator?.(input, output)
    return { stdout: '', stderr: '' }
  })
}

describe('remuxWebmForSeek', () => {
  it('replaces the original with the remuxed file and reports the new size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-remux-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'rec.webm')
    writeFileSync(filePath, Buffer.concat([EBML, Buffer.from('original-bytes')]))

    const runner = fakeFfmpeg((_input, output) => {
      writeFileSync(output, Buffer.concat([EBML, Buffer.from('remuxed-with-cues')]))
    })
    const result = await remuxWebmForSeek(filePath, runner)

    // O formato de saída não pode depender da extensão do arquivo temporário.
    const args = runner.mock.calls[0]?.[1] ?? []
    expect(args).toContain('-f')
    expect(args[args.indexOf('-f') + 1]).toBe('webm')
    expect(result.outcome).toBe('remuxed')
    expect(result.size).toBe(statSync(filePath).size)
    expect(readFileSync(filePath).includes('remuxed-with-cues')).toBe(true)
    expect(existsSync(`${filePath}.remux-tmp`)).toBe(false)
  })

  it('keeps the original and cleans up when ffmpeg fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-remux-fail-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'rec.webm')
    const original = Buffer.concat([EBML, Buffer.from('original-bytes')])
    writeFileSync(filePath, original)

    const result = await remuxWebmForSeek(filePath, fakeFfmpeg(() => {
      throw new Error('ffmpeg exploded')
    }))

    expect(result.outcome).toBe('skipped')
    expect(result.size).toBe(original.length)
    expect(readFileSync(filePath).equals(original)).toBe(true)
    expect(existsSync(`${filePath}.remux-tmp`)).toBe(false)
  })

  it('rejects a remux whose output is not valid webm', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-remux-invalid-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'rec.webm')
    const original = Buffer.concat([EBML, Buffer.from('original-bytes')])
    writeFileSync(filePath, original)

    const result = await remuxWebmForSeek(filePath, fakeFfmpeg((_input, output) => {
      writeFileSync(output, 'this is not ebml')
    }))

    expect(result.outcome).toBe('skipped')
    expect(readFileSync(filePath).equals(original)).toBe(true)
    expect(existsSync(`${filePath}.remux-tmp`)).toBe(false)
  })

  it('rejects an empty remux output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-remux-empty-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'rec.webm')
    const original = Buffer.concat([EBML, Buffer.from('original-bytes')])
    writeFileSync(filePath, original)

    const result = await remuxWebmForSeek(filePath, fakeFfmpeg((_input, output) => {
      writeFileSync(output, '')
    }))

    expect(result.outcome).toBe('skipped')
    expect(readFileSync(filePath).equals(original)).toBe(true)
  })

  it('skips a non-webm input without spawning ffmpeg at all', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-remux-not-webm-'))
    tempDirs.push(dir)
    const filePath = join(dir, 'rec.webm')
    const original = Buffer.from('plain-junk-not-ebml')
    writeFileSync(filePath, original)

    const runner = fakeFfmpeg()
    const result = await remuxWebmForSeek(filePath, runner)

    expect(runner).not.toHaveBeenCalled()
    expect(result.outcome).toBe('skipped')
    expect(readFileSync(filePath).equals(original)).toBe(true)
  })
})

import { afterEach } from 'bun:test'
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})
