import type { AgentEvent } from '@craft-agent/core/types'

import { BaseEventAdapter } from '../base-event-adapter.ts'
import { isToolResultError } from '../../tool-matching.ts'

type HermesToolCall = {
  toolCallId: string
  toolName: string
  args?: unknown
}

type HermesToolResult = HermesToolCall & {
  output?: unknown
}

type NormalizedTool = {
  toolName: string
  input: Record<string, unknown>
  displayName?: string
  intent?: string
}

const HERMES_TOOL_DISPLAY: Record<string, { toolName: string; displayName: string }> = {
  read_file: { toolName: 'Read', displayName: 'Read File' },
  read: { toolName: 'Read', displayName: 'Read File' },
  write_file: { toolName: 'Write', displayName: 'Write File' },
  write: { toolName: 'Write', displayName: 'Write File' },
  patch: { toolName: 'Edit', displayName: 'Edit File' },
  edit: { toolName: 'Edit', displayName: 'Edit File' },
  terminal: { toolName: 'Bash', displayName: 'Terminal' },
  shell: { toolName: 'Bash', displayName: 'Terminal' },
  execute_code: { toolName: 'Python', displayName: 'Python' },
  python: { toolName: 'Python', displayName: 'Python' },
  search_files: { toolName: 'Search', displayName: 'Search Files' },
  search: { toolName: 'Search', displayName: 'Search' },
  web_search: { toolName: 'Search', displayName: 'Web Search' },
  web_extract: { toolName: 'Web', displayName: 'Web Extract' },
  skill_view: { toolName: 'Skill', displayName: 'Skill View' },
  skills_list: { toolName: 'Skill', displayName: 'Skills List' },
  skill_manage: { toolName: 'Skill', displayName: 'Skill Manage' },
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {}
}

function serializeHermesToolResult(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  if (value === undefined || value === null) return ''
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const key of ['content', 'output', 'result', 'error', 'message']) {
      const field = record[key]
      if (typeof field === 'string') return field
    }
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return '[Result contains non-serializable data]'
  }
}

function titleCaseToolName(toolName: string): string {
  return toolName
    .replace(/^mcp__/, '')
    .split(/[_\s-]+/g)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || toolName
}

function normalizeInput(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (toolName) {
    case 'read_file':
    case 'read': {
      const { path, file_path, offset, limit, ...rest } = args
      return {
        ...rest,
        file_path: file_path ?? path,
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }
    }
    case 'write_file':
    case 'write': {
      const { path, file_path, content, ...rest } = args
      return { ...rest, file_path: file_path ?? path, content }
    }
    case 'patch':
    case 'edit': {
      const { path, file_path, old_string, new_string, ...rest } = args
      return {
        ...rest,
        file_path: file_path ?? path,
        ...(old_string !== undefined ? { old_string } : {}),
        ...(new_string !== undefined ? { new_string } : {}),
      }
    }
    default:
      return args
  }
}

export class HermesEventAdapter extends BaseEventAdapter {
  private toolNames = new Map<string, string>()
  private textBuffer = ''
  private hasEmittedFinalText = false

  constructor() {
    super('hermes-event')
  }

  protected onTurnStart(): void {
    this.toolNames.clear()
    this.textBuffer = ''
    this.hasEmittedFinalText = false
    if (!this.currentTurnId) {
      this.currentTurnId = `hermes-turn-${this.turnIndex}`
    }
  }

  adaptTextDelta(delta: string): AgentEvent[] {
    if (!delta) return []
    this.textBuffer += delta
    return [{ type: 'text_delta', text: delta, turnId: this.currentTurnId || undefined }]
  }

  adaptToolCall(call: HermesToolCall): AgentEvent[] {
    const events: AgentEvent[] = []
    const intermediate = this.flushText(true)
    if (intermediate) events.push(intermediate)

    const normalized = this.normalizeTool(call.toolName, asRecord(call.args), call.toolCallId)
    this.toolNames.set(call.toolCallId, normalized.toolName)

    if (normalized.toolName === 'Read' && typeof normalized.input._command === 'string') {
      events.push(this.createReadToolStart(
        call.toolCallId,
        {
          filePath: String(normalized.input.file_path ?? ''),
          startLine: typeof normalized.input.offset === 'number' ? normalized.input.offset : undefined,
          endLine: typeof normalized.input.offset === 'number' && typeof normalized.input.limit === 'number'
            ? normalized.input.offset + normalized.input.limit - 1
            : undefined,
          originalCommand: normalized.input._command,
        },
        normalized.intent,
        normalized.displayName,
      ))
      return events
    }

    events.push(this.createToolStart(
      call.toolCallId,
      normalized.toolName,
      normalized.input,
      normalized.intent,
      normalized.displayName,
    ))
    return events
  }

  adaptToolResult(result: HermesToolResult): AgentEvent[] {
    const normalized = this.normalizeTool(result.toolName, asRecord(result.args), result.toolCallId)
    const toolName = this.toolNames.get(result.toolCallId) ?? normalized.toolName
    this.toolNames.delete(result.toolCallId)

    const resultText = serializeHermesToolResult(result.output)
    const isError = result.output instanceof Error || isToolResultError(result.output)

    this.hasEmittedFinalText = false

    return [this.createToolResult(result.toolCallId, toolName, resultText, isError)]
  }

  flushFinalText(): AgentEvent | null {
    return this.flushText(false)
  }

  adaptFinish(part: unknown): AgentEvent[] {
    const usage = this.extractUsage(part)
    return usage ? [{ type: 'complete', usage }] : []
  }

  private flushText(isIntermediate: boolean): AgentEvent | null {
    if (!this.textBuffer) return null
    if (!isIntermediate && this.hasEmittedFinalText) return null
    const text = this.textBuffer
    this.textBuffer = ''
    if (!isIntermediate) this.hasEmittedFinalText = true
    return {
      type: 'text_complete',
      text,
      isIntermediate,
      turnId: this.currentTurnId || undefined,
    }
  }

  private normalizeTool(toolName: string, rawArgs: Record<string, unknown>, toolCallId: string): NormalizedTool {
    const display = HERMES_TOOL_DISPLAY[toolName]
    const input = normalizeInput(toolName, rawArgs)
    const command = typeof rawArgs.command === 'string' ? rawArgs.command : undefined

    if ((toolName === 'terminal' || toolName === 'shell') && command) {
      const readInfo = this.classifyReadCommand(toolCallId, command)
      if (readInfo) {
        return {
          toolName: 'Read',
          displayName: 'Read File',
          intent: typeof rawArgs.description === 'string' ? rawArgs.description : undefined,
          input: {
            file_path: readInfo.filePath,
            ...(readInfo.startLine !== undefined ? { offset: readInfo.startLine } : {}),
            ...(readInfo.startLine !== undefined && readInfo.endLine !== undefined
              ? { limit: readInfo.endLine - readInfo.startLine + 1 }
              : {}),
            _command: readInfo.originalCommand,
          },
        }
      }
    }

    if (display) {
      return {
        toolName: display.toolName,
        displayName: display.displayName,
        intent: typeof rawArgs.description === 'string' ? rawArgs.description : undefined,
        input,
      }
    }

    return {
      toolName,
      displayName: titleCaseToolName(toolName),
      intent: typeof rawArgs.description === 'string' ? rawArgs.description : undefined,
      input,
    }
  }

  private extractUsage(part: unknown): AgentEvent extends { usage: infer U } ? U : never | undefined {
    const data = asRecord(part)
    const usage = asRecord(data.usage)
    const inputTokens = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens
    const outputTokens = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens
    if (typeof inputTokens !== 'number' && typeof outputTokens !== 'number') return undefined
    return {
      inputTokens: typeof inputTokens === 'number' ? inputTokens : 0,
      outputTokens: typeof outputTokens === 'number' ? outputTokens : 0,
      cacheReadTokens: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : undefined,
      cacheCreationTokens: typeof usage.cacheCreationTokens === 'number' ? usage.cacheCreationTokens : undefined,
      costUsd: typeof usage.costUsd === 'number' ? usage.costUsd : 0,
      contextWindow: typeof usage.contextWindow === 'number' ? usage.contextWindow : undefined,
    } as never
  }
}
