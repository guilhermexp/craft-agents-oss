/**
 * BatchSessionMenu - Context menu content for batch operations on multi-selected sessions.
 *
 * Self-contained component that uses hooks to access selection state, session metadata,
 * and mutation callbacks. Renders polymorphic menu items via useMenuComponents() so it
 * works in both DropdownMenu and ContextMenu scenarios.
 *
 * Mirrors the actions from MultiSelectPanel (Status, Labels, Archive) with additions
 * for Flag and Delete that make sense in a context menu.
 */

import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useCallback, useMemo } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { Archive, Flag, FlagOff, Trash2, Tag, Send } from 'lucide-react'
import { toast } from 'sonner'
import { useMenuComponents } from '@/components/ui/menu-context'
import { useSelectedIds } from '@/hooks/useSession'
import { useSessionSelection } from '@/hooks/useSession'
import { sessionMetaMapAtom, sendToWorkspaceAtom, type SessionMeta } from '@/atoms/sessions'
import { useSessionActions, useWorkspaceData } from '@/context/AppShellContext'
import { getStateColor, getStateIcon, type SessionStatusId } from '@/config/session-status-config'
import { computeSharedSessionStatus, computeAppliedLabelIds, areAllSessionsFlagged, applyBatchStatus, applyBatchFlag, applyBatchUnflag, applyBatchArchive, applyLabelToggle, applyBatchDelete } from './session-batch-actions'
import { LabelMenuItems, StatusMenuItems } from './SessionMenuParts'

export interface BatchSessionMenuProps {
  /** Callback to open Send to Workspace dialog for the selected sessions */
  onSendToWorkspace?: () => void
}

export function BatchSessionMenu({ onSendToWorkspace }: BatchSessionMenuProps = {}) {
  const { t } = useTranslation()
  const { MenuItem, Separator, Sub, SubTrigger, SubContent } = useMenuComponents()

  const selectedIds = useSelectedIds()
  const setSendToWorkspace = useSetAtom(sendToWorkspaceAtom)
  const { clearMultiSelect } = useSessionSelection()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  const { onSessionStatusChange, onFlagSession, onUnflagSession, onArchiveSession, onDeleteSession } = useSessionActions()
  const { onSessionLabelsChange, workspaces, sessionStatuses = [], labels = [] } = useWorkspaceData()

  const hasRemoteWorkspaces = workspaces?.some(w => w.remoteServer) ?? false

  // Hydrate selected session metadata
  const selectedMetas = useMemo(() => {
    const metas: SessionMeta[] = []
    selectedIds.forEach((id) => {
      const meta = sessionMetaMap.get(id)
      if (meta) metas.push(meta)
    })
    return metas
  }, [selectedIds, sessionMetaMap])

  // Compute shared status (if all selected have the same status)
  const activeStatusId = useMemo(() => computeSharedSessionStatus(selectedMetas), [selectedMetas])

  // Compute intersection of applied labels (only labels ALL selected sessions have)
  const appliedLabelIds = useMemo(() => computeAppliedLabelIds(selectedMetas), [selectedMetas])

  // Check flag state: all flagged, or some/none flagged
  const allFlagged = useMemo(() => areAllSessionsFlagged(selectedMetas), [selectedMetas])

  // Batch status change
  const handleBatchSetStatus = useCallback((status: SessionStatusId) => {
    applyBatchStatus(onSessionStatusChange, selectedIds, status)
  }, [onSessionStatusChange, selectedIds])

  // Batch label toggle (all-or-nothing semantics, same as MainContentPanel)
  const handleBatchToggleLabel = useCallback((labelId: string) => {
    if (!onSessionLabelsChange) return
    applyLabelToggle(onSessionLabelsChange, selectedMetas, labelId)
  }, [onSessionLabelsChange, selectedMetas])

  // Batch flag/unflag
  const handleBatchFlag = useCallback(() => {
    applyBatchFlag(onFlagSession, selectedIds)
    toast(`${selectedIds.size} ${selectedIds.size === 1 ? 'session' : 'sessions'} flagged`)
  }, [onFlagSession, selectedIds])

  const handleBatchUnflag = useCallback(() => {
    applyBatchUnflag(onUnflagSession, selectedIds)
    toast(`${selectedIds.size} ${selectedIds.size === 1 ? 'session' : 'sessions'} unflagged`)
  }, [onUnflagSession, selectedIds])

  // Batch archive
  const handleBatchArchive = useCallback(() => {
    applyBatchArchive(onArchiveSession, selectedIds)
    clearMultiSelect()
    toast(`${selectedIds.size} ${selectedIds.size === 1 ? 'session' : 'sessions'} archived`)
  }, [onArchiveSession, selectedIds, clearMultiSelect])

  // Batch send to workspace
  const handleSendToWorkspace = useCallback(() => {
    if (onSendToWorkspace) {
      onSendToWorkspace()
    } else {
      setSendToWorkspace([...selectedIds])
    }
  }, [onSendToWorkspace, selectedIds, setSendToWorkspace])

  // Batch delete
  const handleBatchDelete = useCallback(async () => {
    const count = selectedIds.size
    const deleted = await applyBatchDelete(onDeleteSession, [...selectedIds])
    if (!deleted) return // User cancelled
    clearMultiSelect()
    toast(`${count} ${count === 1 ? 'session' : 'sessions'} deleted`)
  }, [onDeleteSession, selectedIds, clearMultiSelect])

  // Resolve current status icon for the submenu trigger
  const statusIcon = activeStatusId
    ? (() => {
        const icon = getStateIcon(activeStatusId, sessionStatuses)
        return React.isValidElement(icon)
          ? React.cloneElement(icon as React.ReactElement<{ bare?: boolean }>, { bare: true })
          : icon
      })()
    : null

  const count = selectedIds.size

  return (
    <>
      {/* Header showing selection count */}
      <div className="px-2 py-1.5 text-xs text-muted-foreground font-medium">
        {t('multiSelect.selected.session', { count })}
      </div>
      <Separator />

      {/* Status submenu */}
      <Sub>
        <SubTrigger className="pr-2">
          {statusIcon ? (
            <span style={{ color: getStateColor(activeStatusId!, sessionStatuses) ?? 'var(--foreground)' }}>
              {statusIcon}
            </span>
          ) : (
            <span className="size-3.5" />
          )}
          <span className="flex-1">{t("sessionMenu.status")}</span>
        </SubTrigger>
        <SubContent>
          <StatusMenuItems
            sessionStatuses={sessionStatuses}
            activeStateId={activeStatusId ?? undefined}
            onSelect={handleBatchSetStatus}
            menu={{ MenuItem }}
          />
        </SubContent>
      </Sub>

      {/* Labels submenu */}
      {labels.length > 0 && (
        <Sub>
          <SubTrigger className="pr-2">
            <Tag className="size-3.5" />
            <span className="flex-1">{t("sidebar.labels")}</span>
          </SubTrigger>
          <SubContent>
            <LabelMenuItems
              labels={labels}
              appliedLabelIds={appliedLabelIds}
              onToggle={handleBatchToggleLabel}
              menu={{ MenuItem, Separator, Sub, SubTrigger, SubContent }}
            />
          </SubContent>
        </Sub>
      )}

      {/* Flag/Unflag */}
      {allFlagged ? (
        <MenuItem onClick={handleBatchUnflag}>
          <FlagOff className="size-3.5" />
          <span className="flex-1">{t("sessionMenu.unflagAll")}</span>
        </MenuItem>
      ) : (
        <MenuItem onClick={handleBatchFlag}>
          <Flag className="size-3.5 text-info" />
          <span className="flex-1">{t("sessionMenu.flagAll")}</span>
        </MenuItem>
      )}

      {/* Archive */}
      <MenuItem onClick={handleBatchArchive}>
        <Archive className="size-3.5" />
        <span className="flex-1">{t("sessionMenu.archive")}</span>
      </MenuItem>

      {/* Send to Workspace */}
      {hasRemoteWorkspaces && (
        <MenuItem onClick={handleSendToWorkspace}>
          <Send className="size-3.5" />
          <span className="flex-1">{t("sessionMenu.sendToWorkspace")}</span>
        </MenuItem>
      )}

      <Separator />

      {/* Delete */}
      <MenuItem onClick={handleBatchDelete} variant="destructive">
        <Trash2 className="size-3.5" />
        <span className="flex-1">{t("common.delete")}</span>
      </MenuItem>
    </>
  )
}
