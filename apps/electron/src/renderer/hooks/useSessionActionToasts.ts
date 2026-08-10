import { useCallback, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"

interface UseSessionActionToastsOptions {
  onFlag?: (sessionId: string) => void
  onUnflag?: (sessionId: string) => void
  onArchive?: (sessionId: string) => void
  onUnarchive?: (sessionId: string) => void
  onDelete: (sessionId: string, skipConfirmation?: boolean) => Promise<boolean>
}

export function useSessionActionToasts({
  onFlag,
  onUnflag,
  onArchive,
  onUnarchive,
  onDelete,
}: UseSessionActionToastsOptions) {
  const { t } = useTranslation()

  /**
   * These handlers are published through `SessionListActions`, which every row
   * subscribes to. A `useCallback` closing over the raw props changes identity
   * whenever the caller re-renders, invalidating that context for the whole
   * list — so the props are read through a ref instead.
   */
  const latest = useRef({ onFlag, onUnflag, onArchive, onUnarchive, onDelete, t })
  useEffect(() => {
    latest.current = { onFlag, onUnflag, onArchive, onUnarchive, onDelete, t }
  }, [onFlag, onUnflag, onArchive, onUnarchive, onDelete, t])

  const handleFlagWithToast = useCallback((sessionId: string) => {
    const { onFlag: flag, onUnflag: unflag, t: translate } = latest.current
    if (!flag) return
    flag(sessionId)
    toast(translate('toast.sessionFlagged'), {
      description: translate('toast.sessionFlaggedDesc'),
      action: unflag ? {
        label: translate('toast.undo'),
        onClick: () => unflag(sessionId),
      } : undefined,
    })
  }, [])

  const handleUnflagWithToast = useCallback((sessionId: string) => {
    const { onFlag: flag, onUnflag: unflag, t: translate } = latest.current
    if (!unflag) return
    unflag(sessionId)
    toast(translate('toast.sessionFlagRemoved'), {
      description: translate('toast.sessionFlagRemovedDesc'),
      action: flag ? {
        label: translate('toast.undo'),
        onClick: () => flag(sessionId),
      } : undefined,
    })
  }, [])

  const handleArchiveWithToast = useCallback((sessionId: string) => {
    const { onArchive: archive, onUnarchive: unarchive, t: translate } = latest.current
    if (!archive) return
    archive(sessionId)
    toast(translate('toast.sessionArchived'), {
      description: translate('toast.sessionArchivedDesc'),
      action: unarchive ? {
        label: translate('toast.undo'),
        onClick: () => unarchive(sessionId),
      } : undefined,
    })
  }, [])

  const handleUnarchiveWithToast = useCallback((sessionId: string) => {
    const { onArchive: archive, onUnarchive: unarchive, t: translate } = latest.current
    if (!unarchive) return
    unarchive(sessionId)
    toast(translate('toast.sessionRestored'), {
      description: translate('toast.sessionRestoredDesc'),
      action: archive ? {
        label: translate('toast.undo'),
        onClick: () => archive(sessionId),
      } : undefined,
    })
  }, [])

  const handleDeleteWithToast = useCallback(async (sessionId: string): Promise<boolean> => {
    // Confirmation dialog is shown by handleDeleteSession in App.tsx
    // We await so toast only shows after successful deletion (if user confirmed)
    const deleted = await latest.current.onDelete(sessionId)
    if (deleted) {
      toast(latest.current.t('toast.sessionDeleted'))
    }
    return deleted
  }, [])

  return {
    handleFlagWithToast,
    handleUnflagWithToast,
    handleArchiveWithToast,
    handleUnarchiveWithToast,
    handleDeleteWithToast,
  }
}
