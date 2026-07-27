import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { MeetingRecord } from '../../shared/types'
import { createLoggerModuleStub } from '../__tests__/logger-module-stub'

// Spy state: assert no backend (and therefore no LLM call) is created on the
// early-return paths — most importantly the "only Hermes configured" case, which
// is the load-bearing guarantee that meeting video analysis never routes into the
// Hermes backend.
let createBackendCalls = 0
let llmConnections: Array<{ slug: string; providerType: string }> = []
let defaultConnection: string | null = null

mock.module('../logger', () => createLoggerModuleStub())

mock.module('@craft-agent/shared/config', () => ({
  getDefaultLlmConnection: () => defaultConnection,
  getLlmConnection: (slug: string) => llmConnections.find((c) => c.slug === slug) ?? null,
  getLlmConnections: () => llmConnections,
}))

mock.module('@craft-agent/shared/agent/backend', () => ({
  createBackendFromConnection: () => {
    createBackendCalls += 1
    return {
      postInit: async () => ({ authInjected: true }),
      async *chat() {
        yield { type: 'error', message: 'chat should not be reached in early-return tests' }
      },
      destroy: () => {},
    }
  },
}))

mock.module('@craft-agent/shared/skills', () => ({
  loadSkillBySlug: () => null,
}))

const { generateMeetingVideoAnalysisMarkdown } = await import('./meeting-video-analysis-service')

const tempDirs: string[] = []

function makeRecord(): MeetingRecord {
  return {
    id: 'meeting-1',
    title: 'Test meeting',
    url: 'https://meet.google.com/abc-defg-hij',
    status: 'stopped',
    startedAt: 0,
  } as MeetingRecord
}

function makeRecordingFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'craft-va-'))
  tempDirs.push(dir)
  const path = join(dir, 'recording.webm')
  writeFileSync(path, 'video-bytes')
  return path
}

beforeEach(() => {
  createBackendCalls = 0
  llmConnections = []
  defaultConnection = null
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('generateMeetingVideoAnalysisMarkdown', () => {
  it('returns null when the recording file is missing, without creating a backend', async () => {
    llmConnections = [{ slug: 'claude', providerType: 'anthropic' }]
    defaultConnection = 'claude'

    const result = await generateMeetingVideoAnalysisMarkdown({
      workspaceId: 'ws',
      workspaceRootPath: join(tmpdir(), 'ws'),
      record: makeRecord(),
      recordingPath: join(tmpdir(), 'does-not-exist', 'recording.webm'),
      outputDir: join(tmpdir(), 'va-out'),
      segments: [],
    })

    expect(result).toBeNull()
    expect(createBackendCalls).toBe(0)
  })

  it('never routes to Hermes: returns null and creates no backend when only Hermes is configured', async () => {
    llmConnections = [{ slug: 'hermes-local', providerType: 'hermes' }]
    defaultConnection = 'hermes-local'
    const recordingPath = makeRecordingFile()

    const result = await generateMeetingVideoAnalysisMarkdown({
      workspaceId: 'ws',
      workspaceRootPath: join(tmpdir(), 'ws'),
      record: makeRecord(),
      recordingPath,
      outputDir: join(tmpdir(), 'va-out'),
      segments: [],
    })

    expect(result).toBeNull()
    expect(createBackendCalls).toBe(0)
  })

  it('returns null and creates no backend when no LLM connection is configured', async () => {
    llmConnections = []
    defaultConnection = null
    const recordingPath = makeRecordingFile()

    const result = await generateMeetingVideoAnalysisMarkdown({
      workspaceId: 'ws',
      workspaceRootPath: join(tmpdir(), 'ws'),
      record: makeRecord(),
      recordingPath,
      outputDir: join(tmpdir(), 'va-out'),
      segments: [],
    })

    expect(result).toBeNull()
    expect(createBackendCalls).toBe(0)
  })
})
