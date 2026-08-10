import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { DatabaseZap, Search } from 'lucide-react'
import { SourceAvatar } from '@/components/ui/source-avatar'
import { deriveConnectionStatus } from '@/components/ui/source-status-indicator'
import { EntityPanel } from '@/components/ui/entity-panel'
import { EntityListBadge } from '@/components/ui/entity-list-badge'
import { EntityListEmptyScreen } from '@/components/ui/entity-list-empty'
import { sourceSelection } from '@/hooks/useEntitySelection'
import { SourceMenu } from './SourceMenu'
import { SendResourceToWorkspaceDialog } from './SendResourceToWorkspaceDialog'
import { useAppShellContext } from '@/context/AppShellContext'
import { EditPopover, getEditConfig, type EditContextKey } from '@/components/ui/EditPopover'
import type { ComposioCatalogItem, PublicSourceDto, SourceConnectionStatus, SourceFilter } from '../../../shared/types'
import {
  discoverComposioCatalog,
  getComposioCatalogCapability,
  materializeComposioCatalogSelection,
} from './composio-catalog-flow'

const SOURCE_TYPE_CONFIG: Record<string, { labelKey: string; colorClass: string }> = {
  mcp: { labelKey: 'sourcesList.typeMcp', colorClass: 'bg-accent/10 text-accent' },
  api: { labelKey: 'sourcesList.typeApi', colorClass: 'bg-success/10 text-success' },
  local: { labelKey: 'sourcesList.typeLocal', colorClass: 'bg-info/10 text-info' },
}

const SOURCE_STATUS_CONFIG: Record<SourceConnectionStatus, { labelKey: string; colorClass: string } | null> = {
  connected: null,
  needs_auth: { labelKey: 'sourcesList.statusAuthRequired', colorClass: 'bg-warning/10 text-warning' },
  failed: { labelKey: 'sourcesList.statusDisconnected', colorClass: 'bg-destructive/10 text-destructive' },
  unhealthy: { labelKey: 'sourcesList.statusReadinessFailed', colorClass: 'bg-destructive/10 text-destructive' },
  disconnected: { labelKey: 'sourcesList.statusDisconnected', colorClass: 'bg-warning/10 text-warning' },
  error: { labelKey: 'sourcesList.statusConnectionError', colorClass: 'bg-destructive/10 text-destructive' },
  unknown: { labelKey: 'sourcesList.statusUnknown', colorClass: 'bg-foreground/10 text-foreground/50' },
  untested: { labelKey: 'sourcesList.statusNotTested', colorClass: 'bg-foreground/10 text-foreground/50' },
  local_disabled: { labelKey: 'sourcesList.statusDisabled', colorClass: 'bg-foreground/10 text-foreground/50' },
}

const SOURCE_TYPE_FILTER_LABEL_KEYS: Record<string, string> = {
  api: 'sourcesList.filterApi',
  mcp: 'sourcesList.filterMcp',
  local: 'sourcesList.filterLocalFolder',
}

export interface SourcesListPanelProps {
  sources: PublicSourceDto[]
  workspaceId?: string
  sourceFilter?: SourceFilter | null
  workspaceRootPath?: string
  onDeleteSource: (sourceSlug: string) => void
  onSourceClick: (source: PublicSourceDto) => void
  selectedSourceSlug?: string | null
  localMcpEnabled?: boolean
  className?: string
}

export function SourcesListPanel({
  sources,
  workspaceId,
  sourceFilter,
  workspaceRootPath,
  onDeleteSource,
  onSourceClick,
  selectedSourceSlug,
  localMcpEnabled = true,
  className,
}: SourcesListPanelProps) {
  const { t } = useTranslation()
  const { workspaces, activeWorkspaceId } = useAppShellContext()
  const hasOtherWorkspaces = workspaces.length > 1
  const [catalogOpen, setCatalogOpen] = React.useState(false)
  const [catalogAvailable, setCatalogAvailable] = React.useState(false)
  const [catalogQuery, setCatalogQuery] = React.useState('')
  const [catalogItems, setCatalogItems] = React.useState<ComposioCatalogItem[]>([])
  const [catalogLoading, setCatalogLoading] = React.useState(false)
  const [catalogError, setCatalogError] = React.useState<string | null>(null)
  const [materializingProvider, setMaterializingProvider] = React.useState<string | null>(null)

  React.useEffect(() => {
    let active = true
    setCatalogAvailable(false)
    setCatalogOpen(false)
    if (!workspaceId) return () => { active = false }

    void getComposioCatalogCapability(window.electronAPI)
      .then((capability) => {
        if (active) setCatalogAvailable(capability.available)
      })
      .catch(() => {
        if (active) setCatalogAvailable(false)
      })

    return () => { active = false }
  }, [workspaceId])

  // Send to Workspace dialog state
  const [sendDialogOpen, setSendDialogOpen] = React.useState(false)
  const [sendResourceSlug, setSendResourceSlug] = React.useState<string | null>(null)
  const [sendResourceLabel, setSendResourceLabel] = React.useState('')

  const filteredSources = React.useMemo(() => {
    if (!sourceFilter) return sources
    return sources.filter(s => s.config.type === sourceFilter.sourceType)
  }, [sources, sourceFilter])

  const emptyMessage = React.useMemo(() => {
    if (sourceFilter?.kind === 'type') {
      const filterLabelKey = SOURCE_TYPE_FILTER_LABEL_KEYS[sourceFilter.sourceType]
      const filterLabel = filterLabelKey ? t(filterLabelKey) : sourceFilter.sourceType
      return t('sourcesList.noSourcesOfType', { type: filterLabel })
    }
    return t('sourcesList.noSourcesConfigured')
  }, [sourceFilter, t])

  const handleCatalogSearch = React.useCallback(async (event: React.FormEvent) => {
    event.preventDefault()
    if (!workspaceId) return
    setCatalogLoading(true)
    setCatalogError(null)
    try {
      setCatalogItems(await discoverComposioCatalog(window.electronAPI, workspaceId, catalogQuery))
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : t('sourcesList.catalogFailed'))
    } finally {
      setCatalogLoading(false)
    }
  }, [catalogQuery, t, workspaceId])

  const handleCatalogSelection = React.useCallback(async (item: ComposioCatalogItem) => {
    if (!workspaceId) return
    setMaterializingProvider(item.providerId)
    setCatalogError(null)
    try {
      const source = await materializeComposioCatalogSelection(window.electronAPI, workspaceId, item)
      onSourceClick(source)
    } catch (error) {
      setCatalogError(error instanceof Error ? error.message : t('sourcesList.catalogMaterializeFailed'))
    } finally {
      setMaterializingProvider(null)
    }
  }, [onSourceClick, t, workspaceId])

  return (
    <>
    {workspaceId && !sourceFilter && catalogAvailable ? (
      <div className="border-b border-border/40 p-2">
        <button
          type="button"
          onClick={() => setCatalogOpen((open) => !open)}
          className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-xs font-medium hover:bg-foreground/[0.04]"
        >
          <Search className="size-3.5" />
          {t('sourcesList.discoverIntegrations')}
        </button>
        {catalogOpen ? (
          <div className="mt-2 space-y-2 px-1 pb-1">
            <form className="flex gap-1.5" onSubmit={handleCatalogSearch}>
              <input
                value={catalogQuery}
                onChange={(event) => setCatalogQuery(event.target.value)}
                placeholder={t('sourcesList.catalogSearchPlaceholder')}
                className="h-8 min-w-0 flex-1 rounded-lg border border-border/50 bg-background px-2 text-xs outline-none focus:border-accent"
              />
              <button
                type="submit"
                disabled={catalogLoading}
                className="h-8 rounded-lg bg-foreground px-3 text-xs font-medium text-background disabled:opacity-50"
              >
                {catalogLoading ? t('common.loading') : t('common.search')}
              </button>
            </form>
            {catalogError ? <p className="text-xs text-destructive">{catalogError}</p> : null}
            {catalogItems.length > 0 ? (
              <div className="max-h-52 space-y-1 overflow-y-auto">
                {catalogItems.map((item) => (
                  <button
                    key={item.providerId}
                    type="button"
                    disabled={materializingProvider !== null}
                    onClick={() => void handleCatalogSelection(item)}
                    className="flex w-full items-start justify-between gap-2 rounded-lg px-2 py-2 text-left hover:bg-foreground/[0.04] disabled:opacity-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">{item.name}</span>
                      {item.description ? <span className="block truncate text-[11px] text-foreground/55">{item.description}</span> : null}
                    </span>
                    <span className="shrink-0 text-[11px] text-accent">
                      {materializingProvider === item.providerId
                        ? t('common.loading')
                        : t('sourcesList.addSource')}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    ) : null}
    <EntityPanel<PublicSourceDto>
      items={filteredSources}
      getId={(s) => s.config.slug}
      selection={sourceSelection}
      selectedId={selectedSourceSlug}
      onItemClick={onSourceClick}
      className={className}
      emptyState={
        <EntityListEmptyScreen
          icon={<DatabaseZap />}
          title={emptyMessage}
          description={t('sourcesList.emptyDescription')}
          docKey="sources"
        >
          {workspaceRootPath && (
            <EditPopover
              align="center"
              trigger={
                <button type="button" className="inline-flex items-center h-7 px-3 text-xs font-medium rounded-[8px] bg-background shadow-minimal hover:bg-foreground/[0.03] transition-colors">
                  {t('sourcesList.addSource')}
                </button>
              }
              {...getEditConfig(
                sourceFilter?.kind === 'type' ? `add-source-${sourceFilter.sourceType}` as EditContextKey : 'add-source',
                workspaceRootPath
              )}
            />
          )}
        </EntityListEmptyScreen>
      }
      mapItem={(source) => {
        const connectionStatus = deriveConnectionStatus(source, localMcpEnabled)
        const typeConfig = SOURCE_TYPE_CONFIG[source.config.type]
        const statusConfig = SOURCE_STATUS_CONFIG[connectionStatus]
        const subtitle = source.config.tagline || source.config.provider || ''
        return {
          icon: <SourceAvatar source={source} size="sm" />,
          title: source.config.name,
          badges: (
            <>
              {typeConfig && <EntityListBadge colorClass={typeConfig.colorClass}>{t(typeConfig.labelKey)}</EntityListBadge>}
              {statusConfig && (
                <EntityListBadge colorClass={statusConfig.colorClass} tooltip={source.config.connectionError || undefined} className="cursor-default">
                  {t(statusConfig.labelKey)}
                </EntityListBadge>
              )}
              {subtitle && <span className="truncate">{subtitle}</span>}
            </>
          ),
          menu: (
            <SourceMenu
              sourceSlug={source.config.slug}
              sourceName={source.config.name}
              onOpenInNewWindow={() => window.electronAPI.openUrl(`craftagents://sources/source/${source.config.slug}?window=focused`)}
              onShowInFinder={() => window.electronAPI.showInFolder(source.folderPath)}
              onDelete={() => onDeleteSource(source.config.slug)}
              onSendToWorkspace={hasOtherWorkspaces ? () => {
                setSendResourceSlug(source.config.slug)
                setSendResourceLabel(source.config.name)
                setSendDialogOpen(true)
              } : undefined}
            />
          ),
        }
      }}
    />

    {/* Send to Workspace dialog */}
    {sendResourceSlug && (
      <SendResourceToWorkspaceDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        resourceType="source"
        resourceIds={[sendResourceSlug]}
        resourceLabel={sendResourceLabel}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId}
      />
    )}
    </>
  )
}
