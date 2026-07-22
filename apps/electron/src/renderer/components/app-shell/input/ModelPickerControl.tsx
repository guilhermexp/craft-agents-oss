import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertCircle, ChevronDown, Check, Brain } from 'lucide-react'
import { Spinner, Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuSub,
} from '@/components/ui/dropdown-menu'
import {
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
  StyledDropdownMenuSeparator,
  StyledDropdownMenuSubTrigger,
  StyledDropdownMenuSubContent,
} from '@/components/ui/styled-dropdown'
import { cn } from '@/lib/utils'
import * as storage from '@/lib/local-storage'
import { useOptionalAppShellContext } from '@/context/AppShellContext'
import { ANTHROPIC_MODELS, getModelShortName, getModelDisplayName, getModelContextWindow } from '@config/models'
import { resolveEffectiveConnectionSlug, isCompatProvider, isLocalConnection } from '@config/llm-connections'
import { THINKING_LEVELS, getThinkingLevelNameKey, type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import type { HermesProfileInfo } from '@craft-agent/shared/protocol'
import { ConnectionIcon } from '@/components/icons/ConnectionIcon'
import { getHermesProfileModel, getHermesProfileSelectorLabel, mergeHermesProfileModels, resolveHermesProfileSelection } from './hermes-profile-badge'

/** Format token count for display (e.g., 1500 -> "1.5k", 200000 -> "200k") */
function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    const thousands = tokens / 1000
    return `${thousands % 1 === 0 ? thousands.toFixed(0) : thousands.toFixed(1)}k`
  }
  return `${tokens}`
}

/** Format a model context window for display (e.g., 1000000 -> "1M", 200000 -> "200k") */
function formatContextWindow(tokens: number | null | undefined): string | null {
  if (!tokens) return null
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${millions % 1 === 0 ? millions.toFixed(0) : millions.toFixed(1)}M`
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`
  return `${tokens}`
}

function stripPiPrefixForDisplay(value: string): string {
  return value.startsWith('pi/') ? value.slice(3) : value
}

export interface ModelPickerControlProps {
  /** Current model ID */
  currentModel: string
  /** Callback when model changes (includes connection slug for proper persistence) */
  onModelChange: (model: string, connection?: string) => void
  /** Current LLM connection slug (locked after first message) */
  currentConnection?: string
  /** Callback when connection changes (only works when session is empty) */
  onConnectionChange?: (connectionSlug: string) => void
  /** Current thinking level */
  thinkingLevel?: ThinkingLevel
  /** Callback when thinking level changes */
  onThinkingLevelChange?: (level: ThinkingLevel) => void
  /** Hermes profile pinned to this session */
  hermesProfile?: string
  /** Callback when the Hermes profile changes for this session */
  onHermesProfileChange?: (profileName: string) => void | Promise<void>
  /** When true, the session's locked connection has been removed */
  connectionUnavailable?: boolean
  /** Whether the session is empty (no messages yet) */
  isEmptySession?: boolean
  /** Context status for token usage footer */
  contextStatus?: {
    isCompacting?: boolean
    inputTokens?: number
    contextWindow?: number
  }
  /** Extra className for the wrapper */
  className?: string
}

/**
 * ModelPickerControl - connection/model/thinking selector plus context-usage footer.
 *
 * Extracted from FreeFormInput so it can render in the centered controls row below
 * the input pill. Behavior is unchanged: it reads LLM connections from the app-shell
 * context and drives model/connection/thinking/Hermes-profile selection via props.
 */
export function ModelPickerControl({
  currentModel,
  onModelChange,
  currentConnection,
  onConnectionChange,
  thinkingLevel = 'medium',
  onThinkingLevelChange,
  hermesProfile,
  onHermesProfileChange,
  connectionUnavailable = false,
  isEmptySession = false,
  contextStatus,
  className,
}: ModelPickerControlProps) {
  const { t } = useTranslation()

  const appShellCtx = useOptionalAppShellContext()
  const llmConnections = appShellCtx?.llmConnections ?? []
  const workspaceDefaultConnection = appShellCtx?.workspaceDefaultLlmConnection

  const [modelDropdownOpen, setModelDropdownOpen] = React.useState(false)

  // Derive connectionDefaultModel per-session from the effective connection.
  const connectionDefaultModel = React.useMemo(() => {
    const effectiveSlug = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)
    const conn = llmConnections.find(c => c.slug === effectiveSlug)
    if (!conn) return null
    if (!isCompatProvider(conn.providerType)) return null
    if (conn.models && conn.models.length > 1) return null
    return conn.defaultModel ?? null
  }, [currentConnection, workspaceDefaultConnection, llmConnections])

  const availableModels = React.useMemo(() => {
    if (connectionUnavailable) return []
    const effectiveSlug = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)
    const connection = llmConnections.find(c => c.slug === effectiveSlug)
    if (!connection) {
      return ANTHROPIC_MODELS
    }
    return connection.models || ANTHROPIC_MODELS
  }, [llmConnections, currentConnection, workspaceDefaultConnection, connectionUnavailable])

  const availableThinkingLevels = THINKING_LEVELS

  const connectionsByProvider = React.useMemo(() => {
    const groups: Record<string, typeof llmConnections> = {
      'Anthropic': [],
      'Local': [],
      'Craft Agents Backend': [],
      'Hermes': [],
    }
    for (const conn of llmConnections) {
      const provider = conn.providerType || 'anthropic'
      if (provider === 'anthropic') {
        groups['Anthropic'].push(conn)
      } else if (provider === 'pi_compat' && isLocalConnection(conn)) {
        groups['Local'].push(conn)
      } else if (provider === 'pi' || provider === 'pi_compat') {
        groups['Craft Agents Backend'].push(conn)
      } else if (provider === 'hermes') {
        groups['Hermes'].push(conn)
      }
    }
    return Object.entries(groups).filter(([, conns]) => conns.length > 0)
  }, [llmConnections])

  const currentConnectionDetails = React.useMemo(() => {
    if (!currentConnection) return null
    return llmConnections.find(c => c.slug === currentConnection) ?? null
  }, [llmConnections, currentConnection])

  const effectiveConnection = resolveEffectiveConnectionSlug(currentConnection, workspaceDefaultConnection, llmConnections)

  const effectiveConnectionDetails = React.useMemo(() => {
    if (!effectiveConnection) return null
    return llmConnections.find(c => c.slug === effectiveConnection) ?? null
  }, [llmConnections, effectiveConnection])

  const isHermesConnection = effectiveConnectionDetails?.providerType === 'hermes'
  const [hermesProfiles, setHermesProfiles] = React.useState<HermesProfileInfo[]>([])
  const [hermesProfilesLoading, setHermesProfilesLoading] = React.useState(false)
  const [hermesProfilesLoaded, setHermesProfilesLoaded] = React.useState(false)
  const [hermesProfileDropdownOpen, setHermesProfileDropdownOpen] = React.useState(false)
  const [changingHermesProfile, setChangingHermesProfile] = React.useState<string | null>(null)

  const activeHermesProfile = React.useMemo(
    () => hermesProfiles.find(profile => profile.isActive)?.name ?? null,
    [hermesProfiles]
  )
  const selectedHermesProfile = resolveHermesProfileSelection(hermesProfile, activeHermesProfile) ?? 'default'
  const hermesProfileSelectorLabel = getHermesProfileSelectorLabel(
    effectiveConnectionDetails?.providerType,
    hermesProfile,
    activeHermesProfile,
    hermesProfilesLoading || (!hermesProfilesLoaded && !hermesProfile),
  )
  const effectiveAvailableModels = React.useMemo(() => {
    if (!isHermesConnection) return availableModels
    return mergeHermesProfileModels(availableModels, hermesProfiles)
  }, [availableModels, hermesProfiles, isHermesConnection])
  const selectedHermesProfileModel = React.useMemo(
    () => getHermesProfileModel(hermesProfiles, selectedHermesProfile),
    [hermesProfiles, selectedHermesProfile],
  )

  const thinkingDisabled = React.useMemo(() => {
    const model = effectiveAvailableModels.find(m => typeof m !== 'string' && m.id === currentModel)
    return typeof model !== 'string' && model?.supportsThinking === false
  }, [effectiveAvailableModels, currentModel])

  const currentModelDisplayName = React.useMemo(() => {
    const modelToDisplay = connectionDefaultModel ?? selectedHermesProfileModel ?? currentModel
    const model = effectiveAvailableModels.find(m =>
      typeof m === 'string' ? m === modelToDisplay : m.id === modelToDisplay
    )
    if (!model) {
      return stripPiPrefixForDisplay(getModelDisplayName(modelToDisplay))
    }
    return typeof model === 'string' ? stripPiPrefixForDisplay(getModelDisplayName(model)) : model.name
  }, [effectiveAvailableModels, currentModel, connectionDefaultModel, selectedHermesProfileModel])

  const loadHermesProfiles = React.useCallback(async () => {
    if (!isHermesConnection) return
    setHermesProfilesLoading(true)
    try {
      const result = await window.electronAPI.listHermesProfiles()
      if (!result.success) {
        toast.error('Failed to list Hermes profiles', { description: result.error })
        return
      }
      setHermesProfiles(result.profiles)
    } catch (error) {
      toast.error('Failed to list Hermes profiles', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setHermesProfilesLoading(false)
      setHermesProfilesLoaded(true)
    }
  }, [isHermesConnection])

  React.useEffect(() => {
    if (!isHermesConnection) {
      setHermesProfilesLoaded(false)
      setHermesProfiles([])
      return
    }
    void loadHermesProfiles()
  }, [isHermesConnection, loadHermesProfiles])

  const handleHermesProfileDropdownOpenChange = React.useCallback((open: boolean) => {
    setHermesProfileDropdownOpen(open)
    if (open) void loadHermesProfiles()
  }, [loadHermesProfiles])

  const handleHermesProfileSelect = React.useCallback(async (profileName: string) => {
    if (profileName === selectedHermesProfile || changingHermesProfile) return
    if (!onHermesProfileChange) return

    setChangingHermesProfile(profileName)
    try {
      await onHermesProfileChange(profileName)
      const profileModel = getHermesProfileModel(hermesProfiles, profileName)
      if (profileModel && profileModel !== currentModel) {
        onModelChange(profileModel, effectiveConnection)
      }
      toast.success(`Hermes profile: ${profileName}`)
    } catch (error) {
      toast.error('Failed to change Hermes profile', { description: error instanceof Error ? error.message : String(error) })
    } finally {
      setChangingHermesProfile(null)
    }
  }, [changingHermesProfile, currentModel, effectiveConnection, hermesProfiles, onHermesProfileChange, onModelChange, selectedHermesProfile])

  const contextWindowLabel = formatContextWindow(getModelContextWindow(currentModel))

  return (
    <div className={cn("flex items-center", className)}>
      {hermesProfileSelectorLabel && (
        <DropdownMenu open={hermesProfileDropdownOpen} onOpenChange={handleHermesProfileDropdownOpenChange}>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className={cn(
                    "input-toolbar-btn inline-flex items-center h-7 px-2 mr-1 gap-1 text-[12px] font-medium text-muted-foreground rounded-[6px] border border-foreground/10 bg-foreground/[0.03] hover:bg-foreground/5 transition-colors select-none",
                    hermesProfileDropdownOpen && "bg-foreground/5",
                  )}
                  disabled={!onHermesProfileChange}
                >
                  {isHermesConnection && effectiveConnectionDetails && llmConnections.length > 1 && storage.get(storage.KEYS.showConnectionIcons, true) && (
                    <ConnectionIcon connection={effectiveConnectionDetails} size={14} showTooltip />
                  )}
                  <span className="max-w-[160px] truncate">{hermesProfileSelectorLabel}</span>
                  {changingHermesProfile ? <Spinner className="size-3" /> : <ChevronDown className="size-3 opacity-60" />}
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">
              Hermes profile for this session
            </TooltipContent>
          </Tooltip>
          <StyledDropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-[240px] max-h-[300px] overflow-y-auto">
            {hermesProfilesLoading ? (
              <StyledDropdownMenuItem disabled>
                <Spinner className="size-3.5" />
                Loading profiles…
              </StyledDropdownMenuItem>
            ) : hermesProfiles.length === 0 ? (
              <StyledDropdownMenuItem disabled>
                No Hermes profiles found
              </StyledDropdownMenuItem>
            ) : (
              hermesProfiles.map((profile) => {
                const isSelected = profile.name === selectedHermesProfile
                const isChanging = changingHermesProfile === profile.name
                const modelText = profile.model
                  ? profile.provider ? `${profile.model} (${profile.provider})` : profile.model
                  : 'No model configured'
                return (
                  <StyledDropdownMenuItem
                    key={profile.name}
                    disabled={!!changingHermesProfile}
                    onSelect={() => void handleHermesProfileSelect(profile.name)}
                    className="min-w-0 items-start py-2"
                  >
                    {isChanging ? <Spinner className="mt-0.5 size-3.5" /> : <Check className={cn("mt-0.5 size-3.5", isSelected ? "opacity-100" : "opacity-0")} />}
                    <span className="min-w-0 flex-1">
                      <span className={cn("block truncate text-[13px]", isSelected && "font-medium text-accent")}>{profile.name}</span>
                      <span className="block max-w-[190px] truncate text-[11px] text-muted-foreground">{modelText}</span>
                    </span>
                  </StyledDropdownMenuItem>
                )
              })
            )}
          </StyledDropdownMenuContent>
        </DropdownMenu>
      )}
      <DropdownMenu open={modelDropdownOpen} onOpenChange={setModelDropdownOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "input-toolbar-btn inline-flex items-center h-7 px-1.5 gap-0.5 text-[13px] shrink-0 rounded-[6px] hover:bg-foreground/5 transition-colors select-none",
                  modelDropdownOpen && "bg-foreground/5",
                  connectionUnavailable && "text-destructive",
                )}
              >
                {connectionUnavailable ? (
                  <>
                    <AlertCircle className="size-3.5 shrink-0" />
                    {t('common.unavailable')}
                  </>
                ) : (
                  <>
                    {!isHermesConnection && effectiveConnectionDetails && llmConnections.length > 1 && storage.get(storage.KEYS.showConnectionIcons, true) && <ConnectionIcon connection={effectiveConnectionDetails} size={14} showTooltip />}
                    {currentModelDisplayName}
                    {contextWindowLabel && <span className="text-muted-foreground shrink-0">{contextWindowLabel}</span>}
                    {!connectionDefaultModel && <ChevronDown className="size-3 opacity-50 shrink-0" />}
                  </>
                )}
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            {t('common.model')}
          </TooltipContent>
        </Tooltip>
        <StyledDropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-[260px]">
          {connectionUnavailable ? (
            <div className="flex flex-col items-center justify-center py-6 px-4 text-center">
              <AlertCircle className="size-8 text-destructive mb-2" />
              <div className="font-medium text-sm mb-1">{t('chat.connectionUnavailable')}</div>
              <div className="text-xs text-muted-foreground">
                {t('chat.connectionUnavailableDescription')}
              </div>
            </div>
          ) : connectionDefaultModel ? (
            <StyledDropdownMenuItem
              disabled
              className="flex items-center justify-between px-2 py-2 rounded-lg"
            >
              <div className="text-left">
                <div className="font-medium text-sm">{stripPiPrefixForDisplay(connectionDefaultModel)}</div>
                <div className="text-xs text-muted-foreground">{t('chat.connectionDefault')}</div>
              </div>
              <Check className="size-3 text-foreground shrink-0 ml-3" />
            </StyledDropdownMenuItem>
          ) : isEmptySession && llmConnections.length > 1 ? (
            connectionsByProvider.map(([providerName, connections], index) => (
              <React.Fragment key={providerName}>
                <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide select-none">
                  {providerName}
                </div>
                {connections.map((conn) => {
                  const isCurrentConnection = effectiveConnection === conn.slug
                  const isAuthenticated = conn.isAuthenticated
                  return (
                    <DropdownMenuSub key={conn.slug}>
                      <StyledDropdownMenuSubTrigger
                        disabled={!isAuthenticated}
                        className={cn(
                          "flex items-center justify-between px-2 py-2 rounded-lg",
                          isCurrentConnection && "bg-foreground/5"
                        )}
                      >
                        <div className="text-left flex-1">
                          <div className="font-medium text-sm flex items-center gap-1.5">
                            <ConnectionIcon connection={conn} size={14} />
                            {conn.name}
                            {isCurrentConnection && <Check className="size-3 text-foreground" />}
                          </div>
                          {!isAuthenticated && (
                            <div className="text-xs text-muted-foreground">{t('settings.ai.notAuthenticated')}</div>
                          )}
                        </div>
                      </StyledDropdownMenuSubTrigger>
                      {isAuthenticated && (
                        <StyledDropdownMenuSubContent className="min-w-[220px]">
                          {(conn.providerType === 'hermes'
                            ? mergeHermesProfileModels(conn.models || ANTHROPIC_MODELS, hermesProfiles)
                            : (conn.models || ANTHROPIC_MODELS)
                          ).map((model) => {
                            const modelId = typeof model === 'string' ? model : model.id
                            const modelName = typeof model === 'string' ? stripPiPrefixForDisplay(getModelShortName(model)) : model.name
                            const isSelectedModel = isCurrentConnection && (selectedHermesProfileModel ?? currentModel) === modelId
                            return (
                              <StyledDropdownMenuItem
                                key={modelId}
                                onSelect={() => {
                                  if (!isCurrentConnection && onConnectionChange) {
                                    onConnectionChange(conn.slug)
                                  }
                                  onModelChange(modelId, conn.slug)
                                }}
                                className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                              >
                                <div className="font-medium text-sm">{modelName}</div>
                                {isSelectedModel && (
                                  <Check className="size-3 text-foreground shrink-0 ml-3" />
                                )}
                              </StyledDropdownMenuItem>
                            )
                          })}
                        </StyledDropdownMenuSubContent>
                      )}
                    </DropdownMenuSub>
                  )
                })}
                {index < connectionsByProvider.length - 1 && (
                  <StyledDropdownMenuSeparator className="my-1" />
                )}
              </React.Fragment>
            ))
          ) : (
            <>
              {!isEmptySession && currentConnectionDetails && llmConnections.length > 1 && (
                <>
                  <div className="flex items-center gap-2 px-2 py-1.5 text-xs select-none text-muted-foreground">
                    <span>{t('chat.usingConnection', { name: currentConnectionDetails.name })}</span>
                  </div>
                  <StyledDropdownMenuSeparator className="my-1" />
                </>
              )}
              {effectiveAvailableModels.map((model) => {
                const modelId = typeof model === 'string' ? model : model.id
                const modelName = typeof model === 'string' ? stripPiPrefixForDisplay(getModelShortName(model)) : model.name
                const isSelected = (selectedHermesProfileModel ?? currentModel) === modelId
                const descriptionKey = typeof model !== 'string' && 'descriptionKey' in model ? (model.descriptionKey as string) : undefined
                const description = descriptionKey ? t(descriptionKey) : (typeof model !== 'string' && 'description' in model ? (model.description as string) : '')
                return (
                  <StyledDropdownMenuItem
                    key={modelId}
                    onSelect={() => onModelChange(modelId, effectiveConnection)}
                    className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                  >
                    <div className="text-left">
                      <div className="font-medium text-sm">{modelName}</div>
                      {description && (
                        <div className="text-xs text-muted-foreground">{description}</div>
                      )}
                    </div>
                    {isSelected && (
                      <Check className="size-3 text-foreground shrink-0 ml-3" />
                    )}
                  </StyledDropdownMenuItem>
                )
              })}
            </>
          )}


          {contextStatus?.inputTokens != null && contextStatus.inputTokens > 0 && (
            <>
              <StyledDropdownMenuSeparator className="my-1" />
              <div className="px-2 py-1.5 select-none">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{t('chat.context')}</span>
                  <span className="flex items-center gap-1.5">
                    {contextStatus.isCompacting && (
                      <Spinner className="size-3" />
                    )}
                    {t('chat.tokensUsed', { displayCount: formatTokenCount(contextStatus.inputTokens) })}
                  </span>
                </div>
              </div>
            </>
          )}
        </StyledDropdownMenuContent>
      </DropdownMenu>
      {availableThinkingLevels.length > 0 && (
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  disabled={thinkingDisabled}
                  className={cn(
                    "input-toolbar-btn inline-flex items-center h-7 px-1.5 ml-1 gap-1 text-[13px] shrink-0 rounded-[6px] hover:bg-foreground/5 transition-colors select-none",
                    thinkingDisabled && "opacity-50 cursor-not-allowed",
                  )}
                >
                  <Brain className="size-3.5 shrink-0 opacity-70" />
                  <span className="whitespace-nowrap">{t(getThinkingLevelNameKey(thinkingLevel))}</span>
                  <ChevronDown className="size-3 opacity-50 shrink-0" />
                </button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">{thinkingDisabled ? t('thinking.notSupported') : t('thinking.extendedDesc')}</TooltipContent>
          </Tooltip>
          <StyledDropdownMenuContent side="top" align="end" sideOffset={8} className="min-w-[220px]">
            {availableThinkingLevels.map(({ id, nameKey, descriptionKey }) => {
              const isSelected = thinkingLevel === id
              return (
                <StyledDropdownMenuItem
                  key={id}
                  onSelect={() => onThinkingLevelChange?.(id)}
                  className="flex items-center justify-between px-2 py-2 rounded-lg cursor-pointer"
                >
                  <div className="text-left">
                    <div className="font-medium text-sm">{t(nameKey)}</div>
                    <div className="text-xs text-muted-foreground">{t(descriptionKey)}</div>
                  </div>
                  {isSelected && (
                    <Check className="size-3 text-foreground shrink-0 ml-3" />
                  )}
                </StyledDropdownMenuItem>
              )
            })}
          </StyledDropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
