import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ArrowLeft, Copy, ExternalLink, FolderOpen, Maximize2 } from 'lucide-react'
import { classifyFile } from '@craft-agent/ui/file-classification'
import { Markdown } from '@craft-agent/ui/markdown'
import { ShikiCodeViewer } from '@/components/shiki/ShikiCodeViewer'
import { useAppShellContext, useSession } from '@/context/AppShellContext'
import { getLanguageFromPath } from '@/lib/file-utils'
import { cn } from '@/lib/utils'
import { getFileManagerName } from '@/lib/platform'
import { SessionFilesSection, WorkspaceFilesSection } from '../right-sidebar/SessionFilesSection'
import { WorkspaceObjectsSection } from '../right-sidebar/workspace-objects-section'
import { getInlinePreviewLoadState } from './right-sidebar-preview-state'

interface SessionInfoPopoverProps {
  sessionId: string
  sessionFolderPath?: string
  trigger: React.ReactElement
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  sideOffset?: number
  contentClassName?: string
  presentation?: 'popover' | 'drawer'
}

const DEFAULT_POPOVER_CONTENT_CLASS = 'w-[360px] h-[460px] min-w-[200px] max-w-[420px] overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small p-0'
const DEFAULT_DRAWER_CONTENT_CLASS = [
  'data-[vaul-drawer-direction=bottom]:inset-x-2',
  'data-[vaul-drawer-direction=bottom]:bottom-2',
  'data-[vaul-drawer-direction=bottom]:mt-0',
  'data-[vaul-drawer-direction=bottom]:max-h-[min(82vh,42rem)]',
  'overflow-hidden rounded-[14px] border border-border/60 bg-background shadow-modal-small',
].join(' ')

export function SessionInfoPopover({
  sessionId,
  sessionFolderPath,
  trigger,
  side = 'top',
  align = 'end',
  sideOffset = 6,
  contentClassName,
  presentation = 'popover',
}: SessionInfoPopoverProps) {
  const [open, setOpen] = React.useState(false)

  const handleOpenChange = React.useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)

    if (!nextOpen) {
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('craft:focus-input', {
          detail: { sessionId },
        }))
      })
    }
  }, [sessionId])

  if (presentation === 'drawer') {
    return (
      <Drawer open={open} onOpenChange={handleOpenChange} direction="bottom">
        <DrawerTrigger asChild>
          {trigger}
        </DrawerTrigger>
        <DrawerContent
          className={cn(DEFAULT_DRAWER_CONTENT_CLASS, contentClassName)}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
          }}
        >
          <DrawerHeader className="border-b border-border/50 px-4 py-3 group-data-[vaul-drawer-direction=bottom]/drawer-content:text-left">
            <DrawerTitle className="text-sm font-medium">Session info</DrawerTitle>
          </DrawerHeader>
          <div className="flex-1 min-h-0 overflow-hidden">
            <SessionInfoPopoverContent sessionId={sessionId} sessionFolderPath={sessionFolderPath} />
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        className={contentClassName ?? DEFAULT_POPOVER_CONTENT_CLASS}
        side={side}
        align={align}
        sideOffset={sideOffset}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
        }}
      >
        <SessionInfoPopoverContent sessionId={sessionId} sessionFolderPath={sessionFolderPath} />
      </PopoverContent>
    </Popover>
  )
}

export function SessionInfoPopoverContent({ sessionId, sessionFolderPath, onPreviewFileInline, onPreviewObjectInline }: { sessionId: string; sessionFolderPath?: string; onPreviewFileInline?: (path: string) => void; onPreviewObjectInline?: (objectId: string) => void }) {
  const { t } = useTranslation()
  const session = useSession(sessionId)
  const { onRenameSession } = useAppShellContext()
  const [name, setName] = React.useState('')
  const renameTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    setName(session?.name || '')
  }, [session?.name])

  React.useEffect(() => {
    return () => {
      // Capture current value so the cleanup closure sees the correct timer id
      const timeout = renameTimeoutRef.current
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }, [])

  const handleNameChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value
    setName(newName)

    if (renameTimeoutRef.current) {
      clearTimeout(renameTimeoutRef.current)
    }

    renameTimeoutRef.current = setTimeout(() => {
      const trimmed = newName.trim()
      if (trimmed) {
        onRenameSession(sessionId, trimmed)
      }
    }, 500)
  }, [onRenameSession, sessionId])

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 p-3 border-b border-border/50">
        <label
          htmlFor={`session-title-${sessionId}`}
          className="text-xs font-medium text-muted-foreground block mb-1.5 select-none"
        >
          {t("chat.title")}
        </label>
        <div className="rounded-lg bg-foreground-2 has-[:focus]:bg-background shadow-minimal transition-colors">
          <Input
            id={`session-title-${sessionId}`}
            value={name}
            onChange={handleNameChange}
            placeholder={t("chat.titlePlaceholder")}
            className="h-9 py-2 text-sm border-0 shadow-none bg-transparent focus-visible:ring-0"
          />
        </div>
      </div>
      <Tabs defaultValue="workspace" className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <div className="shrink-0 border-b border-border/50 px-3 py-2">
          {/*
            Grid items default to min-width:auto, so the triggers' nowrap labels
            push their cells past 1fr and print over each other once the pane
            narrows. min-w-0 lets the cell shrink. The ellipsis needs the inner
            span: text-overflow does not apply to the trigger's own inline-flex
            box, only to a block-level child of it.
          */}
          <TabsList className="grid h-8 w-full grid-cols-3 rounded-[8px]">
            <TabsTrigger value="session" title={t('chat.sessionFilesTab')} className="h-6 min-w-0 px-1.5 text-xs">
              <span className="truncate">{t('chat.sessionFilesTab')}</span>
            </TabsTrigger>
            <TabsTrigger value="workspace" title={t('chat.workspaceFilesTab')} className="h-6 min-w-0 px-1.5 text-xs">
              <span className="truncate">{t('chat.workspaceFilesTab')}</span>
            </TabsTrigger>
            <TabsTrigger value="objects" title={t('chat.workspaceObjectsTab')} className="h-6 min-w-0 px-1.5 text-xs">
              <span className="truncate">{t('chat.workspaceObjectsTab')}</span>
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="session" className="m-0 flex-1 min-h-0 overflow-hidden">
          <SessionFilesSection
            sessionId={sessionId}
            sessionFolderPath={sessionFolderPath}
            hideHeader={false}
            className="h-full min-h-0"
            onPreviewFileInline={onPreviewFileInline}
          />
        </TabsContent>
        <TabsContent value="workspace" className="m-0 flex-1 min-h-0 overflow-hidden">
          <WorkspaceFilesSection
            sessionId={sessionId}
            className="h-full min-h-0"
            onPreviewFileInline={onPreviewFileInline}
          />
        </TabsContent>
        <TabsContent value="objects" className="m-0 flex-1 min-h-0 overflow-hidden">
          <WorkspaceObjectsSection onPreviewObject={onPreviewObjectInline ?? (() => {})} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() || filePath
}

export function InlineFilePreviewPanel({
  filePath,
  onBack,
  onOpenDialog,
}: {
  filePath: string
  onBack: () => void
  onOpenDialog: (path: string) => void
}) {
  const { t } = useTranslation()
  const { onOpenFile, onOpenUrl } = useAppShellContext()
  const fileManagerName = getFileManagerName()
  const fileName = getFileName(filePath)
  const classification = React.useMemo(() => classifyFile(filePath), [filePath])
  const previewType = classification.type
  const previewLoadState = React.useMemo(() => getInlinePreviewLoadState(filePath), [filePath])
  const [content, setContent] = React.useState('')
  const [dataUrl, setDataUrl] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    setContent('')
    setDataUrl(null)
    setError(null)
    setLoading(previewLoadState.loading)

    if (previewLoadState.kind === 'unsupported') return

    if (previewLoadState.kind === 'image') {
      window.electronAPI.readFileDataUrl(filePath)
        .then((url) => {
          if (!cancelled) setDataUrl(url)
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      return () => { cancelled = true }
    }

    if (previewLoadState.kind === 'text') {
      window.electronAPI.readFile(filePath)
        .then((text) => {
          if (!cancelled) setContent(text)
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      return () => { cancelled = true }
    }
  }, [filePath, previewLoadState.kind, previewLoadState.loading])

  const openExternal = React.useCallback(() => {
    void window.electronAPI.openFile(filePath)
  }, [filePath])

  const reveal = React.useCallback(() => {
    void window.electronAPI.showInFolder(filePath)
  }, [filePath])

  const copyPath = React.useCallback(() => {
    void navigator.clipboard?.writeText(filePath)
  }, [filePath])

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="size-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            title={t('common.back')}
          >
            <ArrowLeft className="size-4" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{fileName}</div>
            <div className="truncate text-[11px] text-muted-foreground">{filePath}</div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => onOpenDialog(filePath)} className="h-7 rounded-md px-2 text-xs text-foreground/80 hover:bg-foreground/5 flex items-center gap-1">
            <Maximize2 className="size-3.5" />
            {t('chat.openInPreviewDialog')}
          </button>
          <button type="button" onClick={openExternal} className="h-7 rounded-md px-2 text-xs text-foreground/80 hover:bg-foreground/5 flex items-center gap-1">
            <ExternalLink className="size-3.5" />
            {t('common.open')}
          </button>
          <button type="button" onClick={reveal} className="h-7 rounded-md px-2 text-xs text-foreground/80 hover:bg-foreground/5 flex items-center gap-1">
            <FolderOpen className="size-3.5" />
            {t('chat.showInFileManager', { fileManager: fileManagerName })}
          </button>
          <button type="button" onClick={copyPath} className="h-7 rounded-md px-2 text-xs text-foreground/80 hover:bg-foreground/5 flex items-center gap-1">
            <Copy className="size-3.5" />
            {t('common.copyPath')}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto bg-foreground-3">
        {loading ? (
          <div className="p-4 text-xs text-muted-foreground">{t('common.loading')}</div>
        ) : error ? (
          <div className="p-4 text-xs text-destructive">{error}</div>
        ) : previewType === 'image' && dataUrl ? (
          <div className="flex min-h-full items-center justify-center p-4">
            <img src={dataUrl} alt={fileName} className="max-h-full max-w-full rounded-md object-contain shadow-minimal" />
          </div>
        ) : previewType === 'markdown' ? (
          <div className="p-4 text-sm">
            <Markdown mode="full" onUrlClick={onOpenUrl} onFileClick={onOpenFile}>{content}</Markdown>
          </div>
        ) : previewLoadState.kind === 'text' ? (
          <ShikiCodeViewer
            code={content}
            filePath={filePath}
            language={previewType === 'code' ? getLanguageFromPath(filePath) : previewType === 'json' ? 'json' : 'text'}
            className="min-w-full"
          />
        ) : (
          <div className="p-4 text-xs text-muted-foreground">
            {t('chat.inlinePreviewUsesDialog')}
          </div>
        )}
      </div>
    </div>
  )
}
