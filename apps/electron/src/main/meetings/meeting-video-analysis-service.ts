import { execFile } from 'child_process'
import { existsSync, mkdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import type { FileAttachment } from '@craft-agent/shared/utils/files'
import { getLlmConnections, getDefaultLlmConnection, getLlmConnection } from '@craft-agent/shared/config'
import { createBackendFromConnection } from '@craft-agent/shared/agent/backend'
import { loadSkillBySlug } from '@craft-agent/shared/skills'
import type { AgentBackend } from '@craft-agent/shared/agent/backend'
import type { MeetingRecord, MeetingTranscriptSegment } from '../../shared/types'
import { mainLog } from '../logger'

const execFileAsync = promisify(execFile)

const VIDEO_ANALYSIS_SKILL_SLUG = 'video-analysis'
const VIDEO_ANALYSIS_TIMEOUT_MS = 180_000
const VIDEO_AGENT_TIMEOUT_MS = 180_000
const MAX_FRAME_ATTACHMENTS = 8

const FALLBACK_VIDEO_ANALYSIS_SKILL = `# Video Analysis\n\nAnalyze meeting recordings by using extracted visual evidence, key frames, contact sheets, and the transcript together. Cross-check speech against visible screen state. Report concrete findings with timestamps and evidence. Do not infer from one blurry frame when adjacent frames or transcript clarify the moment.`

/** Visible status written into the meeting summary when the host is missing the
 * CLI tools the evidence pipeline needs, so the feature fails loudly instead of
 * silently producing nothing. */
function buildToolsMissingStatus(missing: string[]): string {
  const tools = missing.join(', ')
  return `## Visual analysis\n\n_Visual analysis unavailable: ${tools} not found on this system. Install ${tools} to enable video analysis for recorded meetings._`
}

export interface MeetingVideoAnalysisInput {
  workspaceId: string
  workspaceRootPath: string
  record: MeetingRecord
  recordingPath: string
  outputDir: string
  segments: MeetingTranscriptSegment[]
}

interface VideoEvidenceSummary {
  video: string
  output_dir: string
  duration_seconds: number
  contact_sheet?: string
  frames?: string[]
  audio?: string | null
  transcript?: string | null
}

function resolveCraftConnectionSlug(): string | null {
  const defaultSlug = getDefaultLlmConnection()
  if (defaultSlug) {
    const def = getLlmConnection(defaultSlug)
    if (def && def.providerType !== 'hermes') return def.slug
  }
  const craft = getLlmConnections().find((c) => c.providerType !== 'hermes')
  return craft?.slug ?? null
}

function resolveBundledVideoAnalysisSkillDir(): string | null {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const baseDir = typeof __dirname === 'string' ? __dirname : process.cwd()
  const candidates = [
    join(process.cwd(), 'apps', 'electron', 'resources', 'meeting-agent-skills', VIDEO_ANALYSIS_SKILL_SLUG),
    join(process.cwd(), 'resources', 'meeting-agent-skills', VIDEO_ANALYSIS_SKILL_SLUG),
    join(baseDir, 'resources', 'meeting-agent-skills', VIDEO_ANALYSIS_SKILL_SLUG),
    join(baseDir, '..', 'resources', 'meeting-agent-skills', VIDEO_ANALYSIS_SKILL_SLUG),
    join(baseDir, '..', '..', 'resources', 'meeting-agent-skills', VIDEO_ANALYSIS_SKILL_SLUG),
    resourcesPath ? join(resourcesPath, 'app', 'resources', 'meeting-agent-skills', VIDEO_ANALYSIS_SKILL_SLUG) : '',
  ].filter(Boolean)

  return candidates.find((candidate) => existsSync(join(candidate, 'SKILL.md'))) ?? null
}

function loadVideoAnalysisSkillContent(workspaceRootPath: string): string {
  const configuredSkill = loadSkillBySlug(workspaceRootPath, VIDEO_ANALYSIS_SKILL_SLUG)
  if (configuredSkill?.content?.trim()) return configuredSkill.content.trim()

  const bundledSkillDir = resolveBundledVideoAnalysisSkillDir()
  if (bundledSkillDir) {
    try {
      const content = readFileSync(join(bundledSkillDir, 'SKILL.md'), 'utf8').trim()
      if (content) return content
    } catch {
      // fall through to embedded fallback
    }
  }

  return FALLBACK_VIDEO_ANALYSIS_SKILL
}

function resolveVideoEvidenceScript(): string | null {
  const bundledSkillDir = resolveBundledVideoAnalysisSkillDir()
  if (!bundledSkillDir) return null
  const script = join(bundledSkillDir, 'scripts', 'video_evidence.py')
  return existsSync(script) ? script : null
}

/**
 * Probe for the external CLIs the evidence pipeline shells out to. None of
 * python3/ffmpeg/ffprobe is bundled in the packaged app, so on a clean install
 * they may be absent. Returns the canonical names of whichever are missing.
 */
async function detectMissingVideoTools(): Promise<string[]> {
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const checks: Array<{ tool: string; args: string[] }> = [
    { tool: python, args: ['--version'] },
    { tool: 'ffmpeg', args: ['-version'] },
    { tool: 'ffprobe', args: ['-version'] },
  ]
  const missing: string[] = []
  for (const { tool, args } of checks) {
    try {
      await execFileAsync(tool, args, { timeout: 10_000 })
    } catch {
      missing.push(tool)
    }
  }
  return missing
}

async function extractVideoEvidence(recordingPath: string, outputDir: string): Promise<VideoEvidenceSummary | null> {
  const script = resolveVideoEvidenceScript()
  if (!script) {
    mainLog.warn('[meetings] bundled video-analysis helper not found; skipping visual analysis')
    return null
  }

  mkdirSync(outputDir, { recursive: true })
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const { stdout } = await execFileAsync(
    python,
    [script, recordingPath, '--out', outputDir, '--no-transcript'],
    { timeout: VIDEO_ANALYSIS_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
  )

  const summaryPath = join(outputDir, 'summary.json')
  const raw = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : stdout
  return JSON.parse(raw) as VideoEvidenceSummary
}

function selectRepresentativeFrames(frames: string[] | undefined, maxFrames: number): string[] {
  const existing = (frames ?? []).filter((frame) => existsSync(frame))
  if (existing.length <= maxFrames) return existing

  const selected: string[] = []
  for (let i = 0; i < maxFrames; i += 1) {
    const index = Math.round((i * (existing.length - 1)) / (maxFrames - 1))
    const frame = existing[index]
    if (frame && !selected.includes(frame)) selected.push(frame)
  }
  return selected
}

function imageAttachment(filePath: string, name: string): FileAttachment {
  const stat = statSync(filePath)
  return {
    type: 'image',
    path: filePath,
    storedPath: filePath,
    name,
    mimeType: 'image/jpeg',
    base64: readFileSync(filePath).toString('base64'),
    size: stat.size,
  }
}

function buildImageAttachments(summary: VideoEvidenceSummary): FileAttachment[] {
  const attachments: FileAttachment[] = []
  if (summary.contact_sheet && existsSync(summary.contact_sheet)) {
    attachments.push(imageAttachment(summary.contact_sheet, 'contact-sheet.jpg'))
  }

  for (const frame of selectRepresentativeFrames(summary.frames, MAX_FRAME_ATTACHMENTS)) {
    attachments.push(imageAttachment(frame, frame.split(/[\\/]/).at(-1) || 'frame.jpg'))
  }

  return attachments
}

function buildTranscriptText(segments: MeetingTranscriptSegment[]): string {
  if (segments.length === 0) return 'Transcript unavailable or empty.'
  return segments
    .map((segment) => `${segment.speaker?.trim() || 'Speaker'} [${formatTimestamp(segment.startedAt ?? segment.timestamp)}]: ${segment.text}`)
    .join('\n')
}

function formatTimestamp(value: number | undefined): string {
  const totalSeconds = Math.max(0, Math.floor((value ?? 0) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function buildPrompt(input: MeetingVideoAnalysisInput, summary: VideoEvidenceSummary, skillContent: string): string {
  const { record, recordingPath, segments } = input
  const followUpInstruction = record.followUpOnEnd
    ? '\n- Include follow-up tasks, owners, and due dates when the evidence supports them.'
    : ''

  return [
    '<video-analysis-skill>',
    skillContent,
    '</video-analysis-skill>',
    '',
    'You are Craft\'s automatic post-meeting visual analysis agent. The Deepgram transcription pipeline has already run when available; do not redo transcription. The bundled video-analysis helper has extracted the attached contact sheet and representative frames from the meeting recording.',
    '',
    'Analyze the meeting using BOTH visual evidence and transcript. Treat the transcript as supporting evidence, not the only source.',
    '',
    'Meeting metadata:',
    `- Title: ${record.title || 'Untitled meeting'}`,
    `- URL: ${record.url}`,
    `- Recording path: ${recordingPath}`,
    `- Evidence directory: ${summary.output_dir}`,
    `- Duration: ${Math.round(summary.duration_seconds)} seconds`,
    '',
    'Transcript:',
    buildTranscriptText(segments),
    '',
    'Return ONLY Markdown with:',
    '- Executive summary',
    '- Visual timeline with timestamps and what was visible',
    '- Key discussion points / decisions supported by transcript or frames',
    '- Risks, blockers, bugs, UX issues, or noteworthy screen states if visible',
    followUpInstruction,
    '- Evidence notes that mention which timestamp/frame/contact-sheet observation supports important claims',
  ].filter(Boolean).join('\n')
}

async function collectFinalChatText(backend: AgentBackend, prompt: string, attachments: FileAttachment[]): Promise<string | null> {
  let finalText = ''
  for await (const event of backend.chat(prompt, attachments)) {
    if (event.type === 'text_complete') {
      const text = (event as { text?: string; isIntermediate?: boolean }).text
      const isIntermediate = (event as { isIntermediate?: boolean }).isIntermediate
      if (isIntermediate !== true && text) finalText += text
    }
    if (event.type === 'error') {
      const message = (event as { message?: string }).message ?? 'Meeting video analysis agent failed'
      throw new Error(message)
    }
  }
  return finalText.trim() || null
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle)
  }
}

export async function generateMeetingVideoAnalysisMarkdown(input: MeetingVideoAnalysisInput): Promise<string | null> {
  if (!existsSync(input.recordingPath)) {
    mainLog.warn(`[meetings] recording not found for visual analysis: ${input.recordingPath}`)
    return null
  }

  const connectionSlug = resolveCraftConnectionSlug()
  if (!connectionSlug) {
    mainLog.warn('[meetings] no non-Hermes LLM connection configured; skipping video analysis agent')
    return null
  }

  const missingTools = await detectMissingVideoTools()
  if (missingTools.length > 0) {
    mainLog.warn(`[meetings] video analysis tools missing (${missingTools.join(', ')}) for ${input.record.id}`)
    // With a transcript we fall back to the text-only summary path (the caller
    // runs generateAgentSummary when this returns null). Without one there is no
    // fallback, so surface a visible status instead of silently doing nothing.
    return input.segments.length > 0 ? null : buildToolsMissingStatus(missingTools)
  }

  let backend: AgentBackend | undefined
  try {
    const evidence = await extractVideoEvidence(input.recordingPath, input.outputDir)
    if (!evidence) return null

    const attachments = buildImageAttachments(evidence)
    if (attachments.length === 0) {
      mainLog.warn(`[meetings] no visual evidence generated for ${input.record.id}; skipping video analysis agent`)
      return null
    }

    backend = createBackendFromConnection(connectionSlug, {
      workspace: {
        id: input.workspaceId,
        name: `Workspace ${input.workspaceId}`,
        slug: input.workspaceId,
        rootPath: input.workspaceRootPath,
        createdAt: 0,
      },
      isHeadless: true,
    })

    // Inject the chosen connection's credentials/base-url before the first
    // chat() (the Claude SDK subprocess spawns lazily and reads process.env).
    // Without this, OAuth and custom-base-url providers authenticate against
    // stale ambient env. Mirrors SessionManager's postInit-before-chat contract.
    const init = await backend.postInit()
    if (!init.authInjected) {
      mainLog.warn(
        `[meetings] video analysis backend auth not injected (connection=${connectionSlug})${init.authWarning ? `: ${init.authWarning}` : ''}; skipping`,
      )
      return null
    }

    const skillContent = loadVideoAnalysisSkillContent(input.workspaceRootPath)
    const prompt = buildPrompt(input, evidence, skillContent)
    const markdown = await withTimeout(
      collectFinalChatText(backend, prompt, attachments),
      VIDEO_AGENT_TIMEOUT_MS,
      `video analysis agent timed out after ${VIDEO_AGENT_TIMEOUT_MS}ms`,
    )

    return markdown
  } catch (error) {
    mainLog.error(`[meetings] video analysis failed for ${input.record.id}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  } finally {
    try {
      backend?.destroy()
    } catch {
      // best-effort teardown
    }
  }
}
