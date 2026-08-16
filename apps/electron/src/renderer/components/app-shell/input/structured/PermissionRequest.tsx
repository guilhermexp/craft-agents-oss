import { useTranslation } from 'react-i18next'
import { ShieldAlert, Check, X, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { PermissionRequest as PermissionRequestType } from '../../../../../shared/types'
import type { PermissionResponse } from './types'

interface PermissionRequestProps {
  request: PermissionRequestType
  onResponse: (response: PermissionResponse) => void
  /** When true, removes container styling (shadow, rounded) - used when wrapped by InputContainer */
  unstyled?: boolean
}

type JsonObject = Record<string, unknown>

const MAX_DESCRIPTION_CHARS = 280
const MAX_COMMAND_CHARS = 2_000

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars).trimEnd()}\n... truncated ${value.length - maxChars} chars`
}

function countLines(value: string): number {
  if (value.length === 0) return 0
  return value.split('\n').length
}

function getStringField(source: JsonObject, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function previewJsonValue(value: unknown): string {
  if (typeof value === 'string') return truncateText(value, 160).replace(/\s+/g, ' ')
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value)
  if (Array.isArray(value)) return `[${value.length} items]`
  if (isJsonObject(value)) return `{${Object.keys(value).length} keys}`
  return String(value)
}

function summarizeToolCall(command: string): string {
  try {
    const parsed = JSON.parse(command) as unknown
    if (!isJsonObject(parsed)) return truncateText(command, MAX_COMMAND_CHARS)

    const tool = typeof parsed.tool === 'string' ? parsed.tool : undefined
    const args = isJsonObject(parsed.arguments) ? parsed.arguments : undefined
    if (!tool && !args) return truncateText(command, MAX_COMMAND_CHARS)

    const lines: string[] = []
    if (tool) lines.push(`tool: ${tool}`)

    if (args) {
      const path = getStringField(args, ['path', 'file_path', 'notebook_path'])
      if (path) lines.push(`path: ${path}`)

      const pathKeys = new Set(['path', 'file_path', 'notebook_path'])
      for (const [key, value] of Object.entries(args)) {
        if (pathKeys.has(key)) continue
        if (key === 'content' && typeof value === 'string') {
          lines.push(`content: ${countLines(value)} lines, ${value.length} chars (hidden in approval preview)`)
          continue
        }
        lines.push(`${key}: ${previewJsonValue(value)}`)
        if (lines.length >= 8) {
          lines.push(`... ${Object.keys(args).length - lines.length + 1} more fields`)
          break
        }
      }
    }

    return lines.join('\n') || truncateText(command, MAX_COMMAND_CHARS)
  } catch {
    return truncateText(command, MAX_COMMAND_CHARS)
  }
}

function getDisplayDescription(request: PermissionRequestType): string {
  const description = request.description.trim()
  const command = request.command?.trim()
  const withoutDuplicateCommand = command && description.includes(command)
    ? description.replace(command, '').replace(/[:\s]+$/g, '').trim()
    : description

  if (withoutDuplicateCommand.length > 0 && withoutDuplicateCommand.length <= MAX_DESCRIPTION_CHARS) {
    return withoutDuplicateCommand
  }

  if (/approve edit/i.test(request.toolName)) {
    return 'Hermes wants approval to edit a file.'
  }

  switch (request.type) {
    case 'file_write':
      return 'The agent wants approval to write or edit a file.'
    case 'bash':
      return 'The agent wants approval to run a command.'
    case 'mcp_mutation':
      return 'The agent wants approval to run a mutation tool.'
    case 'api_mutation':
      return 'The agent wants approval to run a protected action.'
    default:
      return truncateText(withoutDuplicateCommand, MAX_DESCRIPTION_CHARS)
  }
}

/**
 * PermissionRequest - Self-contained structured input for permission approval
 *
 * Shows:
 * - Shield icon + "Permission Required" header
 * - Tool name badge
 * - Description of what the tool wants to do
 * - Command preview (scrollable)
 * - Action buttons: Allow, Always Allow, Deny
 */
export function PermissionRequest({ request, onResponse, unstyled = false }: PermissionRequestProps) {
  const { t } = useTranslation()
  const displayDescription = getDisplayDescription(request)
  const commandPreview = request.command ? summarizeToolCall(request.command) : undefined

  const handleAllow = () => {
    onResponse({ type: 'permission', allowed: true, alwaysAllow: false })
  }

  const handleAlwaysAllow = () => {
    onResponse({ type: 'permission', allowed: true, alwaysAllow: true })
  }

  const handleDeny = () => {
    onResponse({ type: 'permission', allowed: false, alwaysAllow: false })
  }

  return (
    <div
      className={cn(
        'overflow-hidden h-full flex flex-col bg-info/5',
        unstyled
          ? 'border-0'
          : 'border border-info/30 rounded-[8px] shadow-middle'
      )}
      data-tutorial="permission-banner"
    >
      {/* Content - grows to fill available space */}
      <div className="p-4 space-y-3 flex-1 min-h-0 flex flex-col overflow-y-auto">
        <div className="space-y-2 pb-1">
          <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <ShieldAlert className="size-3.5 text-info" />
            <span>{t('chat.permissionRequired')}</span>
          </div>
          <div className="max-h-24 overflow-y-auto pr-1 text-xs leading-[18px] text-muted-foreground break-words">
            <span className="font-medium text-foreground">Tool:</span> {truncateText(request.toolName, MAX_DESCRIPTION_CHARS)}
            <br />
            {displayDescription}
          </div>
        </div>

        {/* Command preview */}
        {commandPreview && (
          <>
            <div className="bg-foreground/5 rounded-md p-3 font-mono text-xs text-foreground/90 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
              {commandPreview}
            </div>
            {request.command && request.command.trim() !== commandPreview && (
              <details className="group rounded-md border border-border/50 bg-background/40">
                <summary className="cursor-pointer select-none px-3 py-2 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
                  {t('chat.permissionShowFullCommand')}
                </summary>
                <pre className="max-h-48 overflow-auto border-t border-border/50 p-3 font-mono text-xs text-foreground/90 whitespace-pre-wrap break-words">
                  {request.command}
                </pre>
              </details>
            )}
          </>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2 border-t border-border/50">
        <Button
          size="sm"
          variant="default"
          className="h-7 gap-1.5"
          onClick={handleAllow}
          data-tutorial="permission-allow-button"
        >
          <Check className="size-3.5" />
          Allow
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 border border-foreground/10 hover:bg-foreground/5 active:bg-foreground/10"
          onClick={handleAlwaysAllow}
        >
          <RefreshCw className="size-3.5" />
          Always Allow
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 text-destructive hover:text-destructive border border-dashed border-destructive/50 hover:bg-destructive/10 hover:border-destructive/70 active:bg-destructive/20"
          onClick={handleDeny}
        >
          <X className="size-3.5" />
          Deny
        </Button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Tip text */}
        <span className="text-[10px] text-muted-foreground">
          "Always Allow" remembers this command for the session
        </span>
      </div>
    </div>
  )
}
