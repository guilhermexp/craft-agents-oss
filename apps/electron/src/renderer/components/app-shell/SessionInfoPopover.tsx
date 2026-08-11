import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '@/components/ui/drawer'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ArrowLeft, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, FolderOpen, Maximize2, X } from 'lucide-react'
import { classifyFile } from '@craft-agent/ui/file-classification'
import { prepareHtmlPreviewSrcDoc } from '@craft-agent/ui/html-preview-sanitizer'
import { Markdown } from '@craft-agent/ui/markdown'
import { usePlatform } from '@craft-agent/ui/context'
import { ShikiCodeViewer } from '@/components/shiki/ShikiCodeViewer'
import { useAppShellContext } from '@/context/AppShellContext'
import { getLanguageFromPath } from '@/lib/file-utils'
import { cn } from '@/lib/utils'
import { getFileManagerName } from '@/lib/platform'
import { filePreviewLog } from '@/lib/logger'
import { SessionFilesSection, WorkspaceFilesSection } from '../right-sidebar/SessionFilesSection'
import { WorkspaceObjectsSection } from '../right-sidebar/workspace-objects-section'
import { getInlinePreviewLoadState } from './right-sidebar-preview-state'
import { Document, Page } from 'react-pdf'
import { PDF_DOCUMENT_OPTIONS } from '@craft-agent/ui/pdf-worker'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

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

const SESSION_INFO_TABS = ['session', 'workspace', 'objects'] as const
type SessionInfoTab = (typeof SESSION_INFO_TABS)[number]

const SESSION_INFO_TAB_LABEL_KEYS: Record<SessionInfoTab, string> = {
  session: 'chat.sessionFilesTab',
  workspace: 'chat.workspaceFilesTab',
  objects: 'chat.workspaceObjectsTab',
}

function stepSessionInfoTab(current: SessionInfoTab, delta: number): SessionInfoTab {
  const next = (SESSION_INFO_TABS.indexOf(current) + delta + SESSION_INFO_TABS.length) % SESSION_INFO_TABS.length
  return SESSION_INFO_TABS[next] as SessionInfoTab
}

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

export function SessionInfoPopoverContent({ sessionId, sessionFolderPath, compactTabs = false, onClose, onPreviewFileInline, onPreviewObjectInline }: { sessionId: string; sessionFolderPath?: string; compactTabs?: boolean; onClose?: () => void; onPreviewFileInline?: (path: string) => void; onPreviewObjectInline?: (objectId: string) => void }) {
  const { t } = useTranslation()
  const [tab, setTab] = React.useState<SessionInfoTab>('workspace')

  return (
    <div className="h-full min-h-0 flex flex-col">
      <Tabs value={tab} onValueChange={value => setTab(value as SessionInfoTab)} className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {/* The panel has no title bar of its own, so the dismiss control rides
            the tab row instead of costing a header. */}
        <div className="shrink-0 flex items-center gap-1.5 border-b border-border/50 px-2 py-2">
          <div className="min-w-0 flex-1">
            {compactTabs ? (
              // Three labels cannot share ~55px: side by side they become three
              // ellipses, which name nothing. One readable label at a time, with
              // the neighbours a click away. The arrows announce where they go,
              // so the destination is spoken instead of a bare direction.
              <div className="flex h-8 w-full items-center gap-0.5 rounded-[8px] bg-muted p-1 text-muted-foreground">
                <button
                  type="button"
                  aria-label={t(SESSION_INFO_TAB_LABEL_KEYS[stepSessionInfoTab(tab, -1)])}
                  onClick={() => setTab(current => stepSessionInfoTab(current, -1))}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <ChevronLeft className="size-3.5" />
                </button>
                <span className="min-w-0 flex-1 truncate rounded-md bg-background px-1 py-0.5 text-center text-xs font-medium text-foreground shadow">
                  {t(SESSION_INFO_TAB_LABEL_KEYS[tab])}
                </span>
                <button
                  type="button"
                  aria-label={t(SESSION_INFO_TAB_LABEL_KEYS[stepSessionInfoTab(tab, 1)])}
                  onClick={() => setTab(current => stepSessionInfoTab(current, 1))}
                  className="flex size-6 shrink-0 items-center justify-center rounded-md transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </div>
            ) : (
              <TabsList className="grid h-8 w-full grid-cols-3 rounded-[8px]">
                <TabsTrigger value="session" className="h-6 min-w-0 px-1.5 text-xs">
                  <span className="truncate">{t('chat.sessionFilesTab')}</span>
                </TabsTrigger>
                <TabsTrigger value="workspace" className="h-6 min-w-0 px-1.5 text-xs">
                  <span className="truncate">{t('chat.workspaceFilesTab')}</span>
                </TabsTrigger>
                <TabsTrigger value="objects" className="h-6 min-w-0 px-1.5 text-xs">
                  <span className="truncate">{t('chat.workspaceObjectsTab')}</span>
                </TabsTrigger>
              </TabsList>
            )}
          </div>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              title={t("common.close")}
              aria-label={t("common.close")}
            >
              <X className="size-3.5" />
            </button>
          ) : null}
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

const PREVIEW_ACTION_BUTTON_CLASS = 'flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

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
  // Already inside the in-app preview: "Open" must launch the system editor, so
  // it goes through the interceptor's external path (which also toasts on failure)
  // instead of onOpenFile, which would just re-enter this panel.
  const { onOpenFileExternal } = usePlatform()
  const fileManagerName = getFileManagerName()
  const fileName = getFileName(filePath)
  const classification = React.useMemo(() => classifyFile(filePath), [filePath])
  const previewType = classification.type
  const previewLoadState = React.useMemo(() => getInlinePreviewLoadState(filePath), [filePath])
  const [content, setContent] = React.useState('')
  const [html, setHtml] = React.useState<string | null>(null)
  const [liveUrl, setLiveUrl] = React.useState<string | null>(null)
  const [dataUrl, setDataUrl] = React.useState<string | null>(null)
  const [pdfData, setPdfData] = React.useState<Uint8Array | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const copiedTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setContent('')
    setHtml(null)
    setLiveUrl(null)
    setDataUrl(null)
    setPdfData(null)
    setError(null)
    setLoading(previewLoadState.loading)

    // Which branch a file takes is invisible from the outside when a preview
    // silently does nothing — log it so the reason is recoverable from the log.
    filePreviewLog.info('preview', {
      filePath,
      type: previewType,
      kind: previewLoadState.kind,
    })

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

    if (previewLoadState.kind === 'pdf') {
      window.electronAPI.readFileBinary(filePath)
        .then((data) => {
          if (!cancelled) setPdfData(new Uint8Array(data))
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      return () => { cancelled = true }
    }

    // Office documents open against a live `officecli watch` server rather than
    // a rendered snapshot: the served page carries the binary's own editor and
    // formula engine, so cells are actually editable.
    if (previewLoadState.kind === 'office') {
      window.electronAPI.openOfficeLive(filePath)
        .then((url) => {
          filePreviewLog.info('live server ready', { filePath, url })
          if (!cancelled) setLiveUrl(url)
        })
        .catch((err) => {
          filePreviewLog.error('live server failed', { filePath, error: String(err) })
          if (!cancelled) setError(err instanceof Error ? err.message : String(err))
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
      return () => {
        cancelled = true
        // Releases the port and the in-memory document when the user moves on.
        void window.electronAPI.closeOfficeLive(filePath)
      }
    }

    if (previewLoadState.kind === 'html') {
      window.electronAPI.readFile(filePath)
        .then((text) => {
          if (!cancelled) setHtml(text)
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
    if (onOpenFileExternal) {
      onOpenFileExternal(filePath)
      return
    }
    onOpenFile(filePath)
  }, [filePath, onOpenFile, onOpenFileExternal])

  const reveal = React.useCallback(() => {
    void window.electronAPI.showInFolder(filePath)
  }, [filePath])

  const copyPath = React.useCallback(() => {
    void navigator.clipboard?.writeText(filePath)
    setCopied(true)
    clearTimeout(copiedTimeoutRef.current ?? undefined)
    copiedTimeoutRef.current = setTimeout(() => setCopied(false), 1500)
  }, [filePath])

  React.useEffect(() => () => {
    clearTimeout(copiedTimeoutRef.current ?? undefined)
  }, [])


  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 flex h-9 items-center gap-0.5 border-b border-border/50 px-1.5">
        <button
          type="button"
          onClick={onBack}
          className={PREVIEW_ACTION_BUTTON_CLASS}
          title={t('common.back')}
          aria-label={t('common.back')}
        >
          <ArrowLeft className="size-3.5" />
        </button>
        {/* The full path is the tooltip, not a second line: it is reference
            information, and spending a row on it shrinks the preview itself. */}
        <div className="min-w-0 flex-1 truncate px-1 text-xs font-medium" title={filePath}>{fileName}</div>
        <button
          type="button"
          onClick={() => onOpenDialog(filePath)}
          className={PREVIEW_ACTION_BUTTON_CLASS}
          title={t('chat.openInPreviewDialog')}
          aria-label={t('chat.openInPreviewDialog')}
        >
          <Maximize2 className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={openExternal}
          className={PREVIEW_ACTION_BUTTON_CLASS}
          title={t('common.open')}
          aria-label={t('common.open')}
        >
          <ExternalLink className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={reveal}
          className={PREVIEW_ACTION_BUTTON_CLASS}
          title={t('chat.showInFileManager', { fileManager: fileManagerName })}
          aria-label={t('chat.showInFileManager', { fileManager: fileManagerName })}
        >
          <FolderOpen className="size-3.5" />
        </button>
        {/* Without a label there is nothing to confirm the copy happened, so the
            icon itself acknowledges it. */}
        <button
          type="button"
          onClick={copyPath}
          className={PREVIEW_ACTION_BUTTON_CLASS}
          title={t('common.copyPath')}
          aria-label={t('common.copyPath')}
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </button>
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
        ) : previewType === 'video' ? (
          <div className="flex min-h-full items-center justify-center p-4">
            {/* Streams over media:// so large files aren't buffered into memory,
                and seeking works via byte-range requests. */}
            <video
              src={`media://workspace/${encodeURIComponent(filePath)}`}
              controls
              className="max-h-full max-w-full rounded-md shadow-minimal"
            />
          </div>
        ) : previewLoadState.kind === 'office' && liveUrl !== null ? (
          // Points at the loopback `officecli watch` server rather than a
          // srcdoc snapshot: double-click editing, formula recalculation and
          // sheet tabs all live in the served page. No sandbox attribute — the
          // frame needs its own origin for its fetch/SSE calls to work, and CSP
          // frame-src already restricts what may be framed.
          <iframe
            title={fileName}
            src={liveUrl}
            className="h-full w-full border-0 bg-white"
          />
        ) : previewLoadState.kind === 'html' && html !== null ? (
          // Arbitrary .html from the workspace stays script-free.
          <iframe
            title={fileName}
            sandbox="allow-same-origin allow-top-navigation-by-user-activation"
            srcDoc={prepareHtmlPreviewSrcDoc(html)}
            className="h-full w-full border-0 bg-white"
          />
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
        ) : previewLoadState.kind === 'pdf' && pdfData ? (
          <InlinePdfViewer data={pdfData} />
        ) : (
          <div className="p-4 text-xs text-muted-foreground">
            {t('chat.inlinePreviewUsesDialog')}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * PDF pages stacked vertically, fit to the panel's width.
 *
 * The pages track the panel: the sidebar is resizable and a fixed page width
 * would either clip or letterbox after every drag.
 */
function InlinePdfViewer({ data }: { data: Uint8Array }) {
  const { t } = useTranslation()
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(0)
  const [pageCount, setPageCount] = React.useState(0)

  React.useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.floor(entry.contentRect.width))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // react-pdf transfers the ArrayBuffer to its worker, detaching what it is
  // handed - give it a copy and keep the master.
  const fileObj = React.useMemo(() => ({ data: new Uint8Array(data) }), [data])

  return (
    <div ref={containerRef} className="min-h-full bg-white">
      {width > 0 && (
        <Document
          file={fileObj}
          options={PDF_DOCUMENT_OPTIONS}
          onLoadSuccess={(doc) => setPageCount(doc.numPages)}
          loading={<div className="p-4 text-xs text-muted-foreground">{t('common.rendering')}</div>}
          error={<div className="p-4 text-xs text-destructive">{t('preview.failedToRenderPdf')}</div>}
        >
          {Array.from({ length: pageCount }, (_, index) => (
            <Page
              key={index}
              pageNumber={index + 1}
              width={width}
              renderTextLayer={false}
              renderAnnotationLayer={false}
            />
          ))}
        </Document>
      )}
    </div>
  )
}
