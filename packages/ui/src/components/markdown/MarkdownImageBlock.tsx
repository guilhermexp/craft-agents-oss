/**
 * MarkdownImageBlock - Renders ```image-preview code blocks as inline previews.
 *
 * The block is named for its common case, not its contract: agents point it at
 * whatever artefact they just produced. Anything that is not an image is handed
 * to the app's file view instead of being forced through an `<img>` — a video
 * read as a data URL decodes to nothing but the broken-image glyph, and the
 * bytes were loaded for no one.
 *
 * Expected JSON shapes:
 * Single item:
 * {
 *   "src": "/absolute/path/to/image.png",
 *   "title": "Optional title"
 * }
 *
 * Multiple items:
 * {
 *   "title": "Before/After",
 *   "items": [
 *     { "src": "/path/to/before.png", "label": "Before" },
 *     { "src": "/path/to/after.png", "label": "After" }
 *   ]
 * }
 */

import * as React from 'react'
import { File as FileIcon, Maximize2, PanelRight } from 'lucide-react'
import { OpenInSidePanelButton } from './OpenInSidePanelButton'
import { cn } from '../../lib/utils'
import { CodeBlock } from './CodeBlock'
import { ImagePreviewOverlay } from '../overlay/ImagePreviewOverlay'
import { usePlatform } from '../../context/PlatformContext'
import { ImageCardStack } from './ImageCardStack'
import { classifyFile } from '../../lib/file-classification'
import { useTranslation } from 'react-i18next'

interface PreviewItem {
  src: string
  label?: string
  ratio?: number
}

interface ImagePreviewSpec {
  src?: string
  title?: string
  items?: PreviewItem[]
}

class ImageBlockErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error) {
    console.warn('[MarkdownImageBlock] Render failed, falling back to CodeBlock:', error)
  }
  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}

export interface MarkdownImageBlockProps {
  code: string
  className?: string
  onCreateRegionAnnotation?: (region: { x: number; y: number; w: number; h: number; unit: 'pixel' | 'percent' }) => void
}

function detectImageRatio(src: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      if (!img.naturalWidth || !img.naturalHeight) {
        resolve(null)
        return
      }
      resolve(img.naturalWidth / img.naturalHeight)
    }
    img.onerror = () => resolve(null)
    img.src = src
  })
}

/**
 * `data:` sources carry their own type; a path is judged by its extension, so
 * the `{{SESSION_PATH}}` placeholders agents emit classify fine unresolved.
 */
function isImageSource(src: string): boolean {
  if (src.startsWith('data:')) return src.startsWith('data:image/')
  return classifyFile(src).type === 'image'
}

/**
 * The block for everything the `<img>` path cannot show. It is the whole card,
 * not a badge beside a broken glyph: the file view is the only surface that
 * renders these, so reaching it must not depend on finding a hover button.
 */
function NonImagePreviewCard({ src, label }: { src: string; label?: string }) {
  const { t } = useTranslation()
  const { onOpenFileInSidePanel, onOpenFile } = usePlatform()
  const open = onOpenFileInSidePanel ?? onOpenFile
  const fileName = label || src.split('/').pop() || src
  const kind = classifyFile(src).type

  return (
    <button
      type="button"
      onClick={open ? () => open(src) : undefined}
      disabled={!open}
      className={cn(
        'flex w-full max-w-2xl items-center gap-3 rounded-[8px] border border-border/60 bg-foreground-2 px-3 py-2.5 text-left',
        open ? 'cursor-pointer transition-colors hover:bg-foreground/5' : 'cursor-default',
      )}
      title={open ? t('preview.openInSidePanel') : undefined}
    >
      <FileIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] text-foreground">{fileName}</span>
        <span className="block truncate text-[11px] uppercase tracking-wide text-muted-foreground">{kind}</span>
      </span>
      {open ? <PanelRight className="size-3.5 shrink-0 text-muted-foreground" /> : null}
    </button>
  )
}

/**
 * Shared by every block on screen, because the same artefact is routinely
 * referenced by more than one message and each instance would otherwise read
 * the file again — the dev log showed the same PNG fetched twice per pass.
 * A rejection is evicted so a file the agent writes later is still picked up.
 */
const blockDataUrlCache = new Map<string, Promise<string>>()

function loadBlockDataUrl(src: string, read: (path: string) => Promise<string>): Promise<string> {
  const cached = blockDataUrlCache.get(src)
  if (cached) return cached

  const request = read(src).catch((err: unknown) => {
    blockDataUrlCache.delete(src)
    throw err
  })
  blockDataUrlCache.set(src, request)
  return request
}

export function MarkdownImageBlock({ code, className, onCreateRegionAnnotation: _onCreateRegionAnnotation }: MarkdownImageBlockProps) {
  const { t } = useTranslation()
  const { onReadFileDataUrl } = usePlatform()

  const spec = React.useMemo<ImagePreviewSpec | null>(() => {
    try {
      const raw = JSON.parse(code)
      if (raw.items && Array.isArray(raw.items) && raw.items.length > 0) {
        return raw as ImagePreviewSpec
      }
      if (raw.src && typeof raw.src === 'string') {
        return raw as ImagePreviewSpec
      }
      return null
    } catch {
      return null
    }
  }, [code])

  const items = React.useMemo<PreviewItem[]>(() => {
    if (!spec) return []
    if (spec.items && spec.items.length > 0) return spec.items
    if (spec.src) return [{ src: spec.src }]
    return []
  }, [spec])

  const [activeIndex, setActiveIndex] = React.useState(0)
  const [isFullscreen, setIsFullscreen] = React.useState(false)

  // Content cache: src path → data URL string
  const [contentCache, setContentCache] = React.useState<Record<string, string>>({})
  // Ratio cache: src path → intrinsic width/height ratio
  const [ratioCache, setRatioCache] = React.useState<Record<string, number>>({})
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Derive a safe index inline — clamps to [0, items.length-1] so we never see a stale
  // out-of-bounds value after items shrink, removing the need for a reset effect.
  const safeActiveIndex = items.length > 0 && activeIndex < items.length ? activeIndex : 0
  const activeItem = items[safeActiveIndex]
  const safeActiveItem = activeItem
  const activeDataUrl = safeActiveItem ? contentCache[safeActiveItem.src] : undefined
  const hasMultiple = items.length > 1

  React.useEffect(() => {
    if (!onReadFileDataUrl || items.length === 0) return

    // Only images: a data URL is how an `<img>` is fed, and nothing else here
    // consumes one. Base64-ing a video the user may never open is pure waste.
    const pendingItems = items.filter((item) => isImageSource(item.src) && !contentCache[item.src])
    if (pendingItems.length === 0) {
      setError(null)
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    Promise.allSettled(
      pendingItems.map(async (item) => {
        const dataUrl = await loadBlockDataUrl(item.src, onReadFileDataUrl)
        const ratio = await detectImageRatio(dataUrl)
        return { src: item.src, dataUrl, ratio }
      })
    )
      .then((results) => {
        if (cancelled) return

        const nextCache: Record<string, string> = {}
        const nextRatios: Record<string, number> = {}
        let failedCount = 0

        for (const result of results) {
          if (result.status === 'fulfilled') {
            const { src, dataUrl, ratio } = result.value
            nextCache[src] = dataUrl
            if (ratio && Number.isFinite(ratio)) {
              nextRatios[src] = ratio
            }
          } else {
            failedCount += 1
          }
        }

        if (Object.keys(nextCache).length > 0) {
          setContentCache((prev) => ({ ...prev, ...nextCache }))
        }
        if (Object.keys(nextRatios).length > 0) {
          setRatioCache((prev) => ({ ...prev, ...nextRatios }))
        }

        if (failedCount > 0) {
          setError(
            failedCount === pendingItems.length
              ? 'Failed to load image files'
              : `Failed to load ${failedCount} image${failedCount > 1 ? 's' : ''}`
          )
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [items, onReadFileDataUrl, contentCache])

  const handleLoadDataUrl = React.useCallback(async (path: string) => {
    if (contentCache[path]) return contentCache[path]
    if (!onReadFileDataUrl) throw new Error('Cannot load image')
    const dataUrl = await loadBlockDataUrl(path, onReadFileDataUrl)
    setContentCache((prev) => ({ ...prev, [path]: dataUrl }))
    return dataUrl
  }, [contentCache, onReadFileDataUrl])

  if (!spec || items.length === 0 || !onReadFileDataUrl) {
    return <CodeBlock code={code} language="json" mode="full" className={className} />
  }

  const stackItems = items.reduce<Array<{ src: string; label?: string; ratio?: number; alt: string }>>((acc, item, index) => {
    const dataUrl = contentCache[item.src]
    if (!dataUrl) return acc
    acc.push({
      src: dataUrl,
      label: item.label,
      ratio: item.ratio ?? ratioCache[item.src],
      alt: item.label || `Image ${index + 1}`,
    })
    return acc
  }, [])

  const fallback = <CodeBlock code={code} language="json" mode="full" className={className} />

  if (!safeActiveItem) {
    return fallback
  }

  // A single non-image artefact is not a degraded image — it is a different
  // surface, so it replaces the frame instead of sitting inside it. In a mixed
  // stack the image chrome stays: the neighbours still need it.
  if (!hasMultiple && !isImageSource(safeActiveItem.src)) {
    return (
      <ImageBlockErrorBoundary fallback={fallback}>
        <div className={cn('my-2', className)}>
          <NonImagePreviewCard src={safeActiveItem.src} label={safeActiveItem.label ?? spec.title} />
        </div>
      </ImageBlockErrorBoundary>
    )
  }

  return (
    <ImageBlockErrorBoundary fallback={fallback}>
      <div className={cn('relative group rounded-[8px] overflow-visible', className)}>
        <div className="relative h-[320px] overflow-visible flex items-center justify-center p-3">
          <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
            <OpenInSidePanelButton src={safeActiveItem.src} alwaysVisible={hasMultiple} />
            <button
              type="button"
              onClick={() => setIsFullscreen(true)}
              className={cn(
                'p-1 rounded-[6px] transition-all select-none',
                'bg-background/90 shadow-minimal',
                'text-muted-foreground/60 hover:text-foreground',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:opacity-100',
                hasMultiple ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
              )}
              title={t('common.viewFullscreen')}
            >
              <Maximize2 className="size-3.5" />
            </button>
          </div>
          {hasMultiple && stackItems.length > 0 && (
            <ImageCardStack
              items={stackItems}
              currentIndex={safeActiveIndex}
              onIndexChange={setActiveIndex}
              onTopCardTap={() => setIsFullscreen(true)}
              className="max-w-full max-h-full"
            />
          )}

          {!hasMultiple && activeDataUrl && (
            <button
              type="button"
              className="contents cursor-zoom-in"
              onClick={() => setIsFullscreen(true)}
              aria-label={safeActiveItem?.label || 'Open image fullscreen'}
            >
              <img
                src={activeDataUrl}
                alt={safeActiveItem?.label || safeActiveItem?.src.split('/').pop() || 'Image preview'}
                className="max-w-full max-h-full object-contain"
                draggable={false}
              />
            </button>
          )}

          {hasMultiple && stackItems.length === 0 && !loading && (
            <NonImagePreviewCard src={safeActiveItem.src} label={safeActiveItem.label ?? spec.title} />
          )}

          {loading && (!activeDataUrl || (hasMultiple && stackItems.length === 0)) && (
            <div className="py-8 text-center text-muted-foreground text-[13px]">{t('common.loading')}</div>
          )}

          {!loading && error && (!activeDataUrl || (hasMultiple && stackItems.length === 0)) && (
            <div className="py-6 text-center text-destructive/70 text-[13px]">{error}</div>
          )}

        </div>
      </div>

      <ImagePreviewOverlay
        isOpen={isFullscreen}
        onClose={() => setIsFullscreen(false)}
        filePath={safeActiveItem.src}
        items={items}
        initialIndex={safeActiveIndex}
        loadDataUrl={handleLoadDataUrl}
        title={spec.title}
      />
    </ImageBlockErrorBoundary>
  )
}
