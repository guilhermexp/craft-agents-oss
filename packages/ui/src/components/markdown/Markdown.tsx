import * as React from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import { markdownUrlTransform } from './url-transform'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { cn } from '../../lib/utils'
import { CodeBlock, InlineCode } from './CodeBlock'
import { MarkdownDiffBlock } from './MarkdownDiffBlock'
import { MarkdownJsonBlock } from './MarkdownJsonBlock'
import { MarkdownMermaidBlock } from './MarkdownMermaidBlock'
import { MarkdownDatatableBlock } from './MarkdownDatatableBlock'
import { MarkdownSpreadsheetBlock } from './MarkdownSpreadsheetBlock'
import { MarkdownHtmlBlock } from './MarkdownHtmlBlock'
import { MarkdownImageBlock } from './MarkdownImageBlock'
import { MarkdownLatexBlock } from './MarkdownLatexBlock'
import { MarkdownPdfBlock } from './MarkdownPdfBlock'
import { MarkdownDocBlock } from './MarkdownDocBlock'
import { preprocessLinks } from './linkify'
import { resolveMarkdownLinkTarget } from './link-target'
import { classifyFile } from '../../lib/file-classification'
import { PlatformProvider, usePlatform } from '../../context/PlatformContext'
import {
  TranscriptViewerAudio,
  TranscriptViewerContainer,
  TranscriptViewerPlayPauseButton,
  TranscriptViewerScrubBar,
  type CharacterAlignmentResponseModel,
} from '../ui/transcript-viewer'
import { ImageIcon, ImageOffIcon, PauseIcon, PlayIcon } from 'lucide-react'
import remarkCollapsibleSections from './remarkCollapsibleSections'
import { CollapsibleSection } from './CollapsibleSection'
import { useCollapsibleMarkdown } from './CollapsibleMarkdownContext'
import { wrapWithSafeProxy } from './safe-components'
import { MARKDOWN_MATH_OPTIONS } from './math-options'
import { buildPdfPreviewCodeFromPlainPath } from './pdf-path-preview'
import { buildTabularPreviewCodeFromPlainPath } from './tabular-preview'
import { prefixFolderContext } from './folder-context-prefix'

// remark/rehype plugin lists are hoisted to module scope so ReactMarkdown gets
// a stable reference and does not rebuild its unified processor (a full document
// re-parse) on every render — the single largest markdown render cost.
// MARKDOWN_MATH_OPTIONS disables single-dollar inline math so currency like
// $2M–$4M stays plain text; math must use $$...$$ delimiters.
const MARKDOWN_MATH_PLUGIN: [typeof remarkMath, typeof MARKDOWN_MATH_OPTIONS] = [
  remarkMath,
  MARKDOWN_MATH_OPTIONS,
]
const REMARK_PLUGINS = [remarkGfm, MARKDOWN_MATH_PLUGIN]
const REMARK_PLUGINS_COLLAPSIBLE = [remarkGfm, MARKDOWN_MATH_PLUGIN, remarkCollapsibleSections]
const REHYPE_PLUGINS = [rehypeKatex, rehypeRaw]
const PLAIN_TEXT_REMARK_PLUGINS = [remarkGfm]

export type DisablablePreviewBlock =
  | 'markdown-preview'
  | 'html-preview'
  | 'pdf-preview'
  | 'image-preview'

/**
 * Render modes for markdown content:
 *
 * - 'terminal': Raw output with minimal formatting, control chars visible
 *   Best for: Debug output, raw logs, when you want to see exactly what's there
 *
 * - 'minimal': Clean rendering with syntax highlighting but no extra chrome
 *   Best for: Chat messages, inline content, when you want readability without clutter
 *
 * - 'full': Rich rendering with beautiful tables, styled code blocks, proper typography
 *   Best for: Documentation, long-form content, when presentation matters
 */
export type RenderMode = 'terminal' | 'minimal' | 'full'

export interface MarkdownProps {
  children: string
  /**
   * Render mode controlling formatting level
   * @default 'minimal'
   */
  mode?: RenderMode
  className?: string
  /**
   * Message ID for memoization (optional)
   * When provided, memoizes parsed blocks to avoid re-parsing during streaming
   */
  id?: string
  /**
   * Callback when a URL is clicked
   */
  onUrlClick?: (url: string) => void
  /**
   * Callback when a file path is clicked
   */
  onFileClick?: (path: string) => void
  /**
   * Resolve a markdown file path before inline media previews read it.
   */
  onResolveFilePath?: (path: string) => Promise<string | null>
  /**
   * Enable collapsible headings
   * Requires wrapping in CollapsibleMarkdownProvider
   * @default false
   */
  collapsible?: boolean
  /**
   * Hide expand button on first mermaid block (when message starts with mermaid)
   * Used in chat to avoid overlap with TurnCard's fullscreen button
   * @default true
   */
  hideFirstMermaidExpand?: boolean
  /**
   * Disable specific preview-block handlers for nested rendering.
   *
   * When a preview-block component renders user-supplied markdown through
   * `Markdown` again (e.g. `MarkdownDocBlock`), it can pass the names of the
   * preview-block types it wants to suppress to prevent infinite recursion.
   * Suppressed blocks fall through to the default `CodeBlock` renderer.
   *
   * Default behavior (prop omitted): all preview blocks are registered.
   */
  disablePreviewBlocks?: ReadonlySet<DisablablePreviewBlock>
}

/** Context for collapsible sections */
interface CollapsibleContext {
  collapsedSections: Set<string>
  toggleSection: (id: string) => void
}

/**
 * Create custom components based on render mode.
 *
 * @param firstMermaidCodeRef - Ref holding the code of the first mermaid block
 *   when the markdown message starts with a mermaid fence. Used to hide the
 *   inline expand button on that block (TurnCard's own fullscreen button
 *   occupies the same top-right position). A ref is used so the closure can
 *   read the latest value without adding content to the memo deps — that would
 *   cause component re-mounting on every streaming update.
 * @param hideFirstMermaidExpand - Whether to hide the expand button on the first
 *   mermaid block when the message starts with a mermaid fence. Defaults to true.
 */
function stableHash(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function getPlainText(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('')
}

const InlineCodeWithFileClick = React.memo(function InlineCodeWithFileClick({
  children,
  onFileClick,
}: {
  children: React.ReactNode
  onFileClick?: (path: string) => void
}) {
  const text = getPlainText(children).trim()
  const resolvedTarget = text ? resolveMarkdownLinkTarget(text) : null

  if (!onFileClick || resolvedTarget?.kind !== 'file') {
    return <InlineCode>{children}</InlineCode>
  }

  return (
    <button
      type="button"
      onClick={() => onFileClick(resolvedTarget.path)}
      className="inline cursor-pointer border-0 bg-transparent p-0 text-left text-accent align-baseline hover:underline"
      title={resolvedTarget.path}
    >
      <InlineCode className="text-accent">{children}</InlineCode>
    </button>
  )
})

const EMPTY_AUDIO_ALIGNMENT: CharacterAlignmentResponseModel = {
  characters: [],
  characterStartTimesSeconds: [],
  characterEndTimesSeconds: [],
}

const audioPreviewDataUrlCache = new Map<string, Promise<string>>()

function MarkdownAudioInlinePreview({
  filePath,
}: {
  filePath: string
}) {
  const { onReadFileDataUrl, onResolveFilePath } = usePlatform()
  const [audioSrc, setAudioSrc] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [isMissing, setIsMissing] = React.useState(false)

  React.useEffect(() => {
    if (!onReadFileDataUrl) return

    let cancelled = false
    setAudioSrc(null)
    setError(null)
    setIsMissing(false)

    const load = async () => {
      const resolvedPath = onResolveFilePath ? await onResolveFilePath(filePath) : filePath
      if (!resolvedPath) return null

      const cached = audioPreviewDataUrlCache.get(resolvedPath)
      if (cached) return cached

      const request = onReadFileDataUrl(resolvedPath).catch((err) => {
        audioPreviewDataUrlCache.delete(resolvedPath)
        throw err
      })
      audioPreviewDataUrlCache.set(resolvedPath, request)
      return request
    }

    load()
      .then((url) => {
        if (cancelled) return
        if (url) {
          setAudioSrc(url)
        } else {
          setIsMissing(true)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load audio')
      })

    return () => { cancelled = true }
  }, [filePath, onReadFileDataUrl, onResolveFilePath])

  if (!onReadFileDataUrl || isMissing) return null

  return (
    <span className="my-3 block w-full max-w-2xl">
      <TranscriptViewerContainer
        as="span"
        className="bg-card w-full rounded-[8px] border border-border/60 p-3 shadow-minimal"
        audioSrc={audioSrc ?? ''}
        audioType={inferAudioMimeType(filePath)}
        alignment={EMPTY_AUDIO_ALIGNMENT}
      >
        {audioSrc && <TranscriptViewerAudio className="sr-only" />}
        {audioSrc ? (
          <>
            <span className="block truncate rounded-[8px] border border-border/60 bg-foreground-2 px-3 py-2 text-sm text-muted-foreground">
              {filePath.split('/').pop() || filePath}
            </span>
            <TranscriptViewerScrubBar />
            <TranscriptViewerPlayPauseButton className="w-full cursor-pointer" disabled={!audioSrc}>
              {({ isPlaying }) => (
                <>
                  {isPlaying ? (
                    <>
                      <PauseIcon className="size-4" /> Pause
                    </>
                  ) : (
                    <>
                      <PlayIcon className="size-4" /> Play
                    </>
                  )}
                </>
              )}
            </TranscriptViewerPlayPauseButton>
          </>
        ) : (
          <span className="block text-sm text-muted-foreground">
            {error ? `Audio preview failed: ${error}` : 'Loading audio...'}
          </span>
        )}
      </TranscriptViewerContainer>
    </span>
  )
}

const imagePreviewDataUrlCache = new Map<string, Promise<string>>()

function MarkdownImageInlinePreview({
  filePath,
}: {
  filePath: string
}) {
  const { onReadFileDataUrl, onResolveFilePath } = usePlatform()
  const [imageSrc, setImageSrc] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [isMissing, setIsMissing] = React.useState(false)

  React.useEffect(() => {
    if (!onReadFileDataUrl) return

    let cancelled = false
    setImageSrc(null)
    setError(null)
    setIsMissing(false)

    const load = async () => {
      const resolvedPath = onResolveFilePath ? await onResolveFilePath(filePath) : filePath
      if (!resolvedPath) return null

      const cached = imagePreviewDataUrlCache.get(resolvedPath)
      if (cached) return cached

      const request = onReadFileDataUrl(resolvedPath).catch((err) => {
        imagePreviewDataUrlCache.delete(resolvedPath)
        throw err
      })
      imagePreviewDataUrlCache.set(resolvedPath, request)
      return request
    }

    load()
      .then((url) => {
        if (cancelled) return
        if (url) {
          setImageSrc(url)
        } else {
          setIsMissing(true)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load image')
      })

    return () => { cancelled = true }
  }, [filePath, onReadFileDataUrl, onResolveFilePath])

  if (!onReadFileDataUrl) return null

  const fileName = filePath.split('/').pop() || filePath

  if (isMissing) {
    return (
      <span className="my-2 inline-flex max-w-full items-center gap-2 rounded-[8px] border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-[13px] text-muted-foreground">
        <ImageOffIcon className="size-4 shrink-0" />
        <span className="truncate">File not found: {fileName}</span>
      </span>
    )
  }

  if (error) {
    return (
      <span className="my-2 inline-flex max-w-full items-center gap-2 rounded-[8px] border border-dashed border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
        <ImageOffIcon className="size-4 shrink-0" />
        <span className="truncate">Failed to load {fileName}: {error}</span>
      </span>
    )
  }

  if (!imageSrc) {
    return (
      <span className="my-2 inline-flex max-w-full items-center gap-2 rounded-[8px] border border-border/60 bg-muted/20 px-3 py-2 text-[13px] text-muted-foreground">
        <ImageIcon className="size-4 shrink-0 animate-pulse" />
        <span className="truncate">Loading {fileName}…</span>
      </span>
    )
  }

  return (
    <span className="my-3 block max-w-2xl">
      <img
        src={imageSrc}
        alt={fileName}
        className="block max-w-full rounded-[8px] border border-border/60 shadow-minimal"
        draggable={false}
      />
    </span>
  )
}

function inferAudioMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'mp3':
      return 'audio/mpeg'
    case 'wav':
      return 'audio/wav'
    case 'm4a':
      return 'audio/mp4'
    case 'aac':
      return 'audio/aac'
    case 'ogg':
    case 'oga':
      return 'audio/ogg'
    case 'opus':
      return 'audio/opus'
    case 'flac':
      return 'audio/flac'
    default:
      return 'audio/mpeg'
  }
}

function PlainTextBlock({ code, onUrlClick, onFileClick }: {
  code: string
  onUrlClick?: (url: string) => void
  onFileClick?: (path: string) => void
}) {
  const processed = React.useMemo(() => preprocessLinks(code), [code])
  const components = React.useMemo<Partial<Components>>(() => ({
    p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
    a: ({ href, children }) => {
      const fallbackText = React.Children.toArray(children)
        .map((child) => (typeof child === 'string' ? child : ''))
        .join('')
        .trim()
      const trimmedHref = href?.trim() ?? ''
      const target = (trimmedHref || fallbackText)
      const resolvedTarget = target ? resolveMarkdownLinkTarget(target) : null
      // Sanitize the DOM href separately from the click-dispatch target: the
      // click handler routes the ORIGINAL href through onFileClick/onUrlClick,
      // but the rendered href passes through defaultUrlTransform so dangerous
      // schemes (file:/javascript:/data:) can't escape via middle-click/cmd-click.
      const sanitized = trimmedHref ? defaultUrlTransform(trimmedHref) : ''
      const safeHref = sanitized ? sanitized : undefined

      const handleClick = (e: React.MouseEvent) => {
        e.preventDefault()
        if (!target) return
        if (resolvedTarget?.kind === 'file' && onFileClick) {
          onFileClick(resolvedTarget.path)
        } else if (resolvedTarget?.kind === 'url' && onUrlClick) {
          onUrlClick(resolvedTarget.url)
        }
      }

      return (
        <a href={safeHref} onClick={handleClick} className="text-accent hover:underline cursor-pointer">
          {children}
        </a>
      )
    },
    code: ({ children }) => <code className="bg-muted px-1 py-0.5 rounded text-sm">{children}</code>,
  }), [onUrlClick, onFileClick])

  return <ReactMarkdown components={components} remarkPlugins={PLAIN_TEXT_REMARK_PLUGINS} urlTransform={markdownUrlTransform}>{processed}</ReactMarkdown>
}

function createComponents(
  mode: RenderMode,
  onUrlClick?: (url: string) => void,
  onFileClick?: (path: string) => void,
  collapsibleContext?: CollapsibleContext | null,
  firstMermaidCodeRef?: React.RefObject<string | null>,
  hideFirstMermaidExpand: boolean = true,
  disablePreviewBlocks?: ReadonlySet<DisablablePreviewBlock>,
): Partial<Components> {
  const isPreviewEnabled = (name: DisablablePreviewBlock) => !disablePreviewBlocks?.has(name)
  let blockIndex = 0
  const wrapBlock = (
    blockType: string,
    content: string,
    child: React.ReactNode,
    nodePosition?: { start?: { line?: number }; end?: { line?: number } },
  ) => {
    blockIndex += 1
    const startLine = nodePosition?.start?.line
    const endLine = nodePosition?.end?.line
    const path = startLine && endLine
      ? `line:${startLine}-${endLine}`
      : `idx:${blockIndex}`
    const blockId = `blk-${stableHash(`${blockType}|${path}|${content.slice(0, 240)}`)}`

    return (
      <div
        data-ca-block-type={blockType}
        data-ca-block-path={path}
        data-ca-block-id={blockId}
      >
        {child}
      </div>
    )
  }

  const baseComponents: Partial<Components> = {
    // Section wrapper for collapsible headings
    div: ({ node, children, ...props }) => {
      const sectionId = (props as Record<string, unknown>)['data-section-id'] as string | undefined
      const headingLevel = (props as Record<string, unknown>)['data-heading-level'] as number | undefined

      // If this is a collapsible section div and we have context
      if (sectionId && headingLevel && collapsibleContext) {
        return (
          <CollapsibleSection
            sectionId={sectionId}
            headingLevel={headingLevel}
            isCollapsed={collapsibleContext.collapsedSections.has(sectionId)}
            onToggle={collapsibleContext.toggleSection}
          >
            {children}
          </CollapsibleSection>
        )
      }

      // Regular div
      return <div {...props}>{children}</div>
    },
    // Links: Make clickable with callbacks.
    //
    // We sanitize the DOM `href` separately from the click-dispatch target:
    // - `safeHref` is what React puts on the `<a>` element. We pass `href`
    //   through `defaultUrlTransform`; any dangerous scheme
    //   (javascript:/data:/vbscript:/file:) is stripped to empty, in which case
    //   we omit the attribute entirely. That blocks middle-click and
    //   cmd-click escape routes (Electron's `setWindowOpenHandler` /
    //   `will-navigate` would otherwise bypass our React `onClick` and call
    //   `shell.openExternal` directly).
    // - The click handler still receives the ORIGINAL `href` and routes it
    //   through `resolveMarkdownLinkTarget` so file URLs land in `onFileClick`
    //   and blocked URLs surface a meaningful error via `onUrlClick` →
    //   `classifyExternalUrl`.
    a: ({ href, children }) => {
      const fallbackText = React.Children.toArray(children)
        .map((child) => (typeof child === 'string' ? child : ''))
        .join('')
        .trim()
      const trimmedHref = href?.trim() ?? ''
      const target = (trimmedHref || fallbackText)
      const resolvedTarget = target ? resolveMarkdownLinkTarget(target) : null
      const fileKind = resolvedTarget?.kind === 'file' ? classifyFile(resolvedTarget.path).type : null
      const isAudioFile = fileKind === 'audio'
      const isImageFile = fileKind === 'image'
      // DOM href is sanitized independently of the click-dispatch target so
      // dangerous schemes can't escape via middle-click/cmd-click (#807).
      const sanitized = trimmedHref ? defaultUrlTransform(trimmedHref) : ''
      const safeHref = sanitized ? sanitized : undefined

      const handleClick = (e: React.MouseEvent) => {
        e.preventDefault()

        if (!target) return

        if (resolvedTarget?.kind === 'file' && onFileClick) {
          onFileClick(resolvedTarget.path)
        } else if (resolvedTarget?.kind === 'url' && onUrlClick) {
          onUrlClick(resolvedTarget.url)
        }
      }

      const link = (
        <a
          href={safeHref}
          onClick={handleClick}
          className="text-accent hover:underline cursor-pointer"
        >
          {children}
        </a>
      )

      if (isAudioFile && resolvedTarget?.kind === 'file') {
        return (
          <>
            {link}
            <MarkdownAudioInlinePreview filePath={resolvedTarget.path} />
          </>
        )
      }

      if (isImageFile && resolvedTarget?.kind === 'file') {
        return (
          <>
            {link}
            <MarkdownImageInlinePreview filePath={resolvedTarget.path} />
          </>
        )
      }

      return (
        link
      )
    },
  }

  // Terminal mode: minimal formatting
  if (mode === 'terminal') {
    return {
      ...baseComponents,
      // No special code handling - just monospace
      code: ({ children }) => (
        <code className="font-mono">{children}</code>
      ),
      pre: ({ children }) => (
        <pre className="font-mono whitespace-pre-wrap my-2">{children}</pre>
      ),
      // Minimal paragraph spacing
      p: ({ children }) => <p className="my-1">{children}</p>,
      // Simple lists
      ul: ({ children }) => <ul className="list-disc list-inside my-1">{children}</ul>,
      ol: ({ children }) => <ol className="list-decimal list-inside my-1">{children}</ol>,
      li: ({ children }) => <li className="my-0.5">{children}</li>,
      // Plain tables
      table: ({ children }) => (
        <table className="my-2 font-mono text-sm">{children}</table>
      ),
      th: ({ children }) => <th className="text-left pr-4">{children}</th>,
      td: ({ children }) => <td className="pr-4">{children}</td>,
    }
  }

  // Minimal mode: clean with syntax highlighting
  if (mode === 'minimal') {
    return {
      ...baseComponents,
      // Inline code
      code: ({ className, children, ...props }) => {
        const match = /language-([\w-]+)/.exec(className || '')
        const isBlock = 'node' in props && props.node?.position?.start.line !== props.node?.position?.end.line

        // Block code
        if (match || isBlock) {
          const code = String(children).replace(/\n$/, '')
          // Diff code blocks → pierre/diffs for a proper diff viewer
          if (match?.[1] === 'diff') {
            return wrapBlock('code', code, <MarkdownDiffBlock code={code} className="my-2" />, props.node?.position)
          }
          // JSON code blocks → interactive tree viewer
          if (match?.[1] === 'json') {
            return wrapBlock('code', code, <MarkdownJsonBlock code={code} className="my-2" />, props.node?.position)
          }
          // Datatable code blocks → sortable/filterable data table
          if (match?.[1] === 'datatable') {
            return wrapBlock('datatable', code, <MarkdownDatatableBlock code={code} className="my-2" />, props.node?.position)
          }
          // Spreadsheet code blocks → Excel-style grid
          if (match?.[1] === 'spreadsheet') {
            return wrapBlock('spreadsheet', code, <MarkdownSpreadsheetBlock code={code} className="my-2" />, props.node?.position)
          }
          const inferredTabularPreview = buildTabularPreviewCodeFromPlainPath(code, match?.[1])
          if (inferredTabularPreview) {
            const child = inferredTabularPreview.blockType === 'datatable'
              ? <MarkdownDatatableBlock code={inferredTabularPreview.previewCode} className="my-2" />
              : <MarkdownSpreadsheetBlock code={inferredTabularPreview.previewCode} className="my-2" />
            return wrapBlock(inferredTabularPreview.blockType, code, child, props.node?.position)
          }
          // HTML preview blocks → sandboxed iframe
          if (match?.[1] === 'html-preview' && isPreviewEnabled('html-preview')) {
            return wrapBlock('html-preview', code, <MarkdownHtmlBlock code={code} className="my-2" />, props.node?.position)
          }
          // PDF preview blocks → inline first page with expand to full viewer
          if (match?.[1] === 'pdf-preview' && isPreviewEnabled('pdf-preview')) {
            return wrapBlock('pdf-preview', code, <MarkdownPdfBlock code={code} className="my-2" />, props.node?.position)
          }
          const inferredPdfPreviewCode = buildPdfPreviewCodeFromPlainPath(code, match?.[1])
          if (inferredPdfPreviewCode) {
            return wrapBlock('pdf-preview', code, <MarkdownPdfBlock code={inferredPdfPreviewCode} className="my-2" />, props.node?.position)
          }
          // Image preview blocks → inline image with expand to full viewer
          if (match?.[1] === 'image-preview' && isPreviewEnabled('image-preview')) {
            return wrapBlock('image-preview', code, <MarkdownImageBlock code={code} className="my-2" />, props.node?.position)
          }
          // Markdown preview blocks → inline rendered .md file
          if (match?.[1] === 'markdown-preview' && isPreviewEnabled('markdown-preview')) {
            return wrapBlock(
              'markdown-preview',
              code,
              <MarkdownDocBlock code={code} className="my-2" onUrlClick={onUrlClick} onFileClick={onFileClick} />,
              props.node?.position,
            )
          }
          // LaTeX/math code blocks → KaTeX rendered display math
          if (match?.[1] === 'latex' || match?.[1] === 'math') {
            return wrapBlock('latex', code, <MarkdownLatexBlock code={code} className="my-2" />, props.node?.position)
          }
          // Mermaid code blocks → zinc-styled SVG diagram.
          // Hide the inline expand button when the mermaid block is the first
          // content in the message — TurnCard's own fullscreen button occupies
          // the same top-right spot. Detection uses firstMermaidCodeRef (content
          // match) rather than AST line positions which are unreliable after
          // preprocessLinks transforms the markdown.
          if (match?.[1] === 'mermaid') {
            const isFirstBlock = hideFirstMermaidExpand &&
                                firstMermaidCodeRef?.current != null &&
                                code === firstMermaidCodeRef.current
            return wrapBlock(
              'mermaid',
              code,
              <MarkdownMermaidBlock code={code} className="my-2" showExpandButton={!isFirstBlock} />,
              props.node?.position,
            )
          }
          const lang = match?.[1]?.toLowerCase()
          if (lang === 'txt' || lang === 'text' || lang === 'plaintext') {
            return <PlainTextBlock code={code} onUrlClick={onUrlClick} onFileClick={onFileClick} />
          }
          return wrapBlock(
            'code',
            code,
            <CodeBlock
              code={code}
              language={match?.[1]}
              mode="full"
              className="my-2"
              onUrlClick={onUrlClick}
              onFileClick={onFileClick}
            />,
            props.node?.position,
          )
        }

        // Inline code
        return <InlineCodeWithFileClick onFileClick={onFileClick}>{children}</InlineCodeWithFileClick>
      },
      pre: ({ children }) => <>{children}</>,
      // Comfortable paragraph spacing
      p: ({ children }) => <p className="my-2 leading-relaxed">{children}</p>,
      // Styled lists - ul uses tighter spacing, ol uses standard for number alignment
      ul: ({ children, className }) => (
        <ul
          className={cn(
            'my-2 space-y-1 ps-[16px] pe-2 list-disc marker:text-[var(--md-bullets)]',
            className?.includes('contains-task-list') && 'list-none ps-0 marker:content-none',
          )}
        >
          {children}
        </ul>
      ),
      ol: ({ children, className }) => (
        <ol className={cn('my-2 space-y-1 pl-6 list-decimal', className)}>{children}</ol>
      ),
      li: ({ children, className }) => (
        <li className={cn(className?.includes('task-list-item') && 'list-none')}>{children}</li>
      ),
      input: ({ type, checked }) => {
        if (type === 'checkbox') {
          return (
            <input
              type="checkbox"
              checked={checked}
              readOnly
              aria-label="task item"
              className="mr-2 rounded border-muted-foreground align-middle"
            />
          )
        }
        return <input type={type} aria-label="input field" />
      },
      // Clean tables
      table: ({ children }) => (
        <div className="my-3 overflow-x-auto">
          <table className="min-w-full text-sm">{children}</table>
        </div>
      ),
      thead: ({ children }) => <thead className="border-b">{children}</thead>,
      th: ({ children }) => (
        <th className="text-left py-2 px-3 font-semibold text-muted-foreground">{children}</th>
      ),
      td: ({ children }) => (
        <td className="py-2 px-3 border-b border-border/50">{children}</td>
      ),
      // Headings - H1/H2 same size, differentiated by weight
      h1: ({ children }) => <h1 className="font-sans text-[16px] font-bold mt-5 mb-3">{children}</h1>,
      h2: ({ children }) => <h2 className="font-sans text-[16px] font-semibold mt-4 mb-3">{children}</h2>,
      h3: ({ children }) => <h3 className="font-sans text-[15px] font-semibold mt-4 mb-2">{children}</h3>,
      // Blockquotes
      blockquote: ({ children }) => (
        <blockquote className="border-l-2 border-muted-foreground/30 pl-3 my-2 text-muted-foreground italic">
          {children}
        </blockquote>
      ),
      // Horizontal rules
      hr: () => <hr className="my-4 border-border" />,
      // Strong/emphasis
      strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
      em: ({ children }) => <em className="italic">{children}</em>,
    }
  }

  // Full mode: rich styling
  return {
    ...baseComponents,
    // Full code blocks with copy button
    code: ({ className, children, ...props }) => {
      const match = /language-([\w-]+)/.exec(className || '')
      const isBlock = 'node' in props && props.node?.position?.start.line !== props.node?.position?.end.line

      if (match || isBlock) {
        const code = String(children).replace(/\n$/, '')
        // Diff code blocks → pierre/diffs for a proper diff viewer
        if (match?.[1] === 'diff') {
          return wrapBlock('code', code, <MarkdownDiffBlock code={code} className="my-2" />, props.node?.position)
        }
        // JSON code blocks → interactive tree viewer
        if (match?.[1] === 'json') {
          return wrapBlock('code', code, <MarkdownJsonBlock code={code} className="my-2" />, props.node?.position)
        }
        // Datatable code blocks → sortable/filterable data table
        if (match?.[1] === 'datatable') {
          return wrapBlock('datatable', code, <MarkdownDatatableBlock code={code} className="my-2" />, props.node?.position)
        }
        // Spreadsheet code blocks → Excel-style grid
        if (match?.[1] === 'spreadsheet') {
          return wrapBlock('spreadsheet', code, <MarkdownSpreadsheetBlock code={code} className="my-2" />, props.node?.position)
        }
        const inferredTabularPreview = buildTabularPreviewCodeFromPlainPath(code, match?.[1])
        if (inferredTabularPreview) {
          const child = inferredTabularPreview.blockType === 'datatable'
            ? <MarkdownDatatableBlock code={inferredTabularPreview.previewCode} className="my-2" />
            : <MarkdownSpreadsheetBlock code={inferredTabularPreview.previewCode} className="my-2" />
          return wrapBlock(inferredTabularPreview.blockType, code, child, props.node?.position)
        }
        // HTML preview blocks → sandboxed iframe
        if (match?.[1] === 'html-preview' && isPreviewEnabled('html-preview')) {
          return wrapBlock('html-preview', code, <MarkdownHtmlBlock code={code} className="my-2" />, props.node?.position)
        }
        // PDF preview blocks → inline first page with expand to full viewer
        if (match?.[1] === 'pdf-preview' && isPreviewEnabled('pdf-preview')) {
          return wrapBlock('pdf-preview', code, <MarkdownPdfBlock code={code} className="my-2" />, props.node?.position)
        }
        const inferredPdfPreviewCode = buildPdfPreviewCodeFromPlainPath(code, match?.[1])
        if (inferredPdfPreviewCode) {
          return wrapBlock('pdf-preview', code, <MarkdownPdfBlock code={inferredPdfPreviewCode} className="my-2" />, props.node?.position)
        }
        // Image preview blocks → inline image with expand to full viewer
        if (match?.[1] === 'image-preview' && isPreviewEnabled('image-preview')) {
          return wrapBlock('image-preview', code, <MarkdownImageBlock code={code} className="my-2" />, props.node?.position)
        }
        // Markdown preview blocks → inline rendered .md file
        if (match?.[1] === 'markdown-preview' && isPreviewEnabled('markdown-preview')) {
          return wrapBlock(
            'markdown-preview',
            code,
            <MarkdownDocBlock code={code} className="my-2" onUrlClick={onUrlClick} onFileClick={onFileClick} />,
            props.node?.position,
          )
        }
        // LaTeX/math code blocks → KaTeX rendered display math
        if (match?.[1] === 'latex' || match?.[1] === 'math') {
          return wrapBlock('latex', code, <MarkdownLatexBlock code={code} className="my-2" />, props.node?.position)
        }
        // Mermaid code blocks → zinc-styled SVG diagram.
        // (Same first-block detection as minimal mode — see comment above.)
        if (match?.[1] === 'mermaid') {
          const isFirstBlock = hideFirstMermaidExpand &&
                              firstMermaidCodeRef?.current != null &&
                              code === firstMermaidCodeRef.current
          return wrapBlock(
            'mermaid',
            code,
            <MarkdownMermaidBlock code={code} className="my-2" showExpandButton={!isFirstBlock} />,
            props.node?.position,
          )
        }
        const lang = match?.[1]?.toLowerCase()
        if (lang === 'txt' || lang === 'text' || lang === 'plaintext') {
          return <div className="my-2 whitespace-pre-line">{code}</div>
        }
        return wrapBlock(
          'code',
          code,
          <CodeBlock
            code={code}
            language={match?.[1]}
            mode="full"
            className="my-2"
            onUrlClick={onUrlClick}
            onFileClick={onFileClick}
          />,
          props.node?.position,
        )
      }

      return <InlineCodeWithFileClick onFileClick={onFileClick}>{children}</InlineCodeWithFileClick>
    },
    pre: ({ children }) => <>{children}</>,
    // Rich paragraph spacing
    p: ({ children }) => <p className="my-3 leading-relaxed">{children}</p>,
    // Styled lists - ul uses tighter spacing, ol uses standard for number alignment
    ul: ({ children, className }) => (
      <ul
        className={cn(
          'my-3 space-y-1.5 ps-[16px] pe-2 list-disc marker:text-[var(--md-bullets)]',
          className?.includes('contains-task-list') && 'list-none ps-0 marker:content-none',
        )}
      >
        {children}
      </ul>
    ),
    ol: ({ children, className }) => (
      <ol className={cn('my-3 space-y-1.5 pl-6 list-decimal', className)}>{children}</ol>
    ),
    li: ({ children, className }) => (
      <li className={cn('leading-relaxed', className?.includes('task-list-item') && 'list-none')}>{children}</li>
    ),
    // Beautiful tables
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y divide-border">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
    tbody: ({ children }) => <tbody className="divide-y divide-border">{children}</tbody>,
    th: ({ children }) => (
      <th className="text-left py-3 px-4 font-semibold text-sm">{children}</th>
    ),
    td: ({ children }) => (
      <td className="py-3 px-4 text-sm">{children}</td>
    ),
    tr: ({ children }) => (
      <tr className="hover:bg-muted/30 transition-colors">{children}</tr>
    ),
    // Rich headings - H1/H2 same size, differentiated by weight
    h1: ({ children }) => (
      <h1 className="font-sans text-[16px] font-bold mt-7 mb-4">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="font-sans text-[16px] font-semibold mt-6 mb-3">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="font-sans text-[15px] font-semibold mt-5 mb-3">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="text-[14px] font-semibold mt-3 mb-1">{children}</h4>
    ),
    // Styled blockquotes
    blockquote: ({ children }) => (
      <blockquote className="border-l-4 border-foreground/30 bg-muted/30 pl-4 pr-3 py-2 my-3 rounded-r-md">
        {children}
      </blockquote>
    ),
    // Task lists (GFM)
    input: ({ type, checked }) => {
      if (type === 'checkbox') {
        return (
          <input
            type="checkbox"
            checked={checked}
            readOnly
            aria-label="task item"
            className="mr-2 rounded border-muted-foreground"
          />
        )
      }
      return <input type={type} aria-label="input field" />
    },
    // Horizontal rules
    hr: () => <hr className="my-6 border-border" />,
    // Strong/emphasis
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    del: ({ children }) => <del className="line-through text-muted-foreground">{children}</del>,
    // Handle unknown <markdown> tags that may come through rehype-raw
    // Type assertion needed because 'markdown' is not a standard HTML element
    markdown: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  } as Partial<Components>
}

/**
 * Markdown - Customizable markdown renderer with multiple render modes
 *
 * Features:
 * - Three render modes: terminal, minimal, full
 * - Syntax highlighting via Shiki
 * - GFM support (tables, task lists, strikethrough)
 * - Clickable links and file paths
 *
 * Exported memoized (see the bottom of this file): re-parsing markdown is the
 * single most expensive render in the app, and the profiler measured 501 of
 * 1264 renders in 221 s with no prop change at all.
 */
function MarkdownImpl({
  children,
  mode = 'minimal',
  className,
  id,
  onUrlClick,
  onFileClick,
  onResolveFilePath,
  collapsible = false,
  hideFirstMermaidExpand = true,
  disablePreviewBlocks,
}: MarkdownProps) {
  const platformActions = usePlatform()
  // Get collapsible context if enabled
  const collapsibleContext = useCollapsibleMarkdown()

  // Extract the first mermaid code block's content when the message starts
  // with a mermaid fence. Stored in a ref so createComponents can read it
  // without adding `children` to the memo deps (which would remount all
  // components on every streaming update, breaking internal state).
  const firstMermaidCodeRef = React.useRef<string | null>(null)
  const trimmed = children.trimStart()
  if (trimmed.startsWith('```mermaid')) {
    const m = trimmed.match(/^```mermaid\n([\s\S]*?)```/)
    // react-doctor-disable-next-line no-ref-current-in-render -- deliberate stable-memo channel: read by memoized components in the same render; a useEffect write would be stale for same-render consumers (see comment above)
    firstMermaidCodeRef.current = m?.[1] ? m[1].replace(/\n$/, '') : null
  } else {
    // react-doctor-disable-next-line no-ref-current-in-render -- same deliberate stable-memo channel as the branch above
    firstMermaidCodeRef.current = null
  }

  const components = React.useMemo(
    () => wrapWithSafeProxy(createComponents(mode, onUrlClick, onFileClick, collapsible ? collapsibleContext : null, firstMermaidCodeRef, hideFirstMermaidExpand, disablePreviewBlocks)),
    [mode, onUrlClick, onFileClick, collapsible, collapsibleContext, hideFirstMermaidExpand, disablePreviewBlocks]
  )

  const scopedPlatformActions = React.useMemo(
    () => onResolveFilePath ? { ...platformActions, onResolveFilePath } : platformActions,
    [platformActions, onResolveFilePath]
  )

  // Preprocess to convert raw URLs and file paths to markdown links.
  // prefixFolderContext runs first so "Pasta:/Folder:" + bullet basenames
  // become absolute markdown links before linkify sees them.
  const processedContent = React.useMemo(
    () => preprocessLinks(prefixFolderContext(children)),
    [children]
  )

  // Collapsible mode adds the sections plugin; both variants are module
  // constants (see REMARK_PLUGINS above), so no per-render allocation.
  const remarkPlugins = collapsible ? REMARK_PLUGINS_COLLAPSIBLE : REMARK_PLUGINS

  return (
    <PlatformProvider actions={scopedPlatformActions}>
      <div className={cn('markdown-content', className)}>
        {/* react-doctor-disable-next-line react-markdown-unsanitized-raw-html -- renders the app's own agent/tool output in local Electron; rehype-sanitize with a KaTeX-safe schema is the recommended follow-up (adding it now would risk breaking math rendering) */}
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={REHYPE_PLUGINS}
          components={components}
          urlTransform={markdownUrlTransform}
        >
          {processedContent}
        </ReactMarkdown>
      </div>
    </PlatformProvider>
  )
}

/**
 * Every prop is compared, unlike the previous hand-written comparator which
 * looked at `id`/`children`/`mode` only and would have served stale output if a
 * consumer changed `onFileClick`, `collapsible` or `className`.
 *
 * A shallow compare is enough because `children` is the markdown source string
 * and the callbacks are stabilised at their producers.
 */
export const Markdown = React.memo(MarkdownImpl)
Markdown.displayName = 'Markdown'

// Re-export for convenience
export { CodeBlock, InlineCode } from './CodeBlock'
export { CollapsibleMarkdownProvider } from './CollapsibleMarkdownContext'
