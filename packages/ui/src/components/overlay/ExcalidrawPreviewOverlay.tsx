/**
 * ExcalidrawPreviewOverlay - In-app preview for .excalidraw and Obsidian .excalidraw.md files.
 */

import * as React from 'react'
import { PenTool } from 'lucide-react'
import LZString from 'lz-string'
import { PreviewOverlay } from './PreviewOverlay'
import { CopyButton } from './CopyButton'
import { ZoomControls } from './ZoomControls'
import { RICH_BLOCK_DEFAULTS } from './rich-block-interaction-spec'
import { useRichBlockInteractions } from './useRichBlockInteractions'

interface ExcalidrawScene {
  type?: string
  version?: number
  source?: string
  elements?: ExcalidrawElement[]
  appState?: {
    viewBackgroundColor?: string
    theme?: 'light' | 'dark'
  }
  files?: Record<string, unknown>
}

type ExcalidrawElementType = 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'arrow' | 'line' | 'freedraw' | 'image' | string

interface ExcalidrawElement {
  id?: string
  type: ExcalidrawElementType
  x: number
  y: number
  width?: number
  height?: number
  angle?: number
  strokeColor?: string
  backgroundColor?: string
  fillStyle?: string
  strokeWidth?: number
  strokeStyle?: string
  opacity?: number
  isDeleted?: boolean
  text?: string
  rawText?: string
  fontSize?: number
  textAlign?: 'left' | 'center' | 'right'
  verticalAlign?: 'top' | 'middle' | 'bottom'
  points?: Array<[number, number]>
  startArrowhead?: string | null
  endArrowhead?: string | null
}

interface SceneBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

export interface ExcalidrawPreviewOverlayProps {
  isOpen: boolean
  onClose: () => void
  filePath: string
  content: string
  theme?: 'light' | 'dark'
  error?: string
}

const PADDING = 80
const FALLBACK_WIDTH = 1200
const FALLBACK_HEIGHT = 800

export function ExcalidrawPreviewOverlay({
  isOpen,
  onClose,
  filePath,
  content,
  theme = 'light',
  error,
}: ExcalidrawPreviewOverlayProps) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const parsed = React.useMemo(() => parseExcalidrawContent(content, filePath), [content, filePath])
  const svg = React.useMemo(() => parsed.scene ? renderSceneSvg(parsed.scene, theme) : null, [parsed.scene, theme])

  const {
    scale,
    translate,
    isDragging,
    isAnimating,
    setIsAnimating,
    zoomByStep,
    zoomToPreset,
    zoomToFit,
    reset,
    onMouseDown,
    onDoubleClick,
  } = useRichBlockInteractions({ isOpen, containerRef })

  const isDefaultView = scale === 1 && translate.x === 0 && translate.y === 0
  const dimensions = svg ? parseSvgDimensions(svg) : null
  const parseError = error || parsed.error

  const headerActions = (
    <div className="flex items-center gap-1.5">
      <ZoomControls
        scale={scale}
        minScale={RICH_BLOCK_DEFAULTS.minScale}
        maxScale={RICH_BLOCK_DEFAULTS.maxScale}
        zoomPresets={RICH_BLOCK_DEFAULTS.zoomPresets}
        onZoomIn={() => zoomByStep('in')}
        onZoomOut={() => zoomByStep('out')}
        onZoomToPreset={zoomToPreset}
        onZoomToFit={() => zoomToFit(dimensions)}
        onReset={reset}
        resetDisabled={isDefaultView}
      />
      <CopyButton content={parsed.json ?? content} title="Copy Excalidraw JSON" className="bg-background shadow-minimal opacity-70 hover:opacity-100" />
    </div>
  )

  return (
    <PreviewOverlay
      isOpen={isOpen}
      onClose={onClose}
      theme={theme}
      typeBadge={{ icon: PenTool, label: 'Excalidraw', variant: 'purple' }}
      filePath={filePath}
      headerActions={headerActions}
      error={parseError ? { label: 'Preview failed', message: parseError } : undefined}
    >
      <div
        ref={containerRef}
        className="flex items-center justify-center select-none"
        onMouseDown={onMouseDown}
        onDoubleClick={onDoubleClick}
        style={{
          marginTop: -72,
          marginBottom: -24,
          height: '100vh',
          cursor: isDragging ? 'grabbing' : 'grab',
          overflow: 'hidden',
        }}
      >
        {svg ? (
          <div
            dangerouslySetInnerHTML={{ __html: svg }}
            onTransitionEnd={() => setIsAnimating(false)}
            style={{
              transform: `translate(${translate.x}px, ${translate.y}px) scale(${scale})`,
              transformOrigin: 'center center',
              transition: isAnimating ? 'transform 150ms ease-out' : 'none',
              boxShadow: '0 18px 60px rgba(15, 23, 42, 0.16)',
              borderRadius: 16,
              overflow: 'hidden',
            }}
          />
        ) : (
          <div className="rounded-lg border border-dashed border-foreground/20 px-6 py-4 text-sm text-muted-foreground">
            Unable to render this Excalidraw file.
          </div>
        )}
      </div>
    </PreviewOverlay>
  )
}

function parseExcalidrawContent(content: string, filePath: string): { scene: ExcalidrawScene | null; json: string | null; error: string | null } {
  try {
    const trimmed = content.trim()
    const json = filePath.endsWith('.excalidraw.md')
      ? extractCompressedJson(trimmed)
      : trimmed
    const scene = JSON.parse(json) as ExcalidrawScene
    if (!Array.isArray(scene.elements)) {
      return { scene: null, json, error: 'Excalidraw scene does not contain an elements array.' }
    }
    return { scene, json: JSON.stringify(scene, null, 2), error: null }
  } catch (err) {
    return { scene: null, json: null, error: err instanceof Error ? err.message : 'Invalid Excalidraw content.' }
  }
}

function extractCompressedJson(markdown: string): string {
  const match = markdown.match(/```compressed-json\s*([\s\S]*?)```/)
  if (!match?.[1]) throw new Error('No compressed-json block found in .excalidraw.md file.')
  const compressed = match[1].replace(/\s+/g, '')
  const decompressed = LZString.decompressFromBase64(compressed)
  if (!decompressed) throw new Error('Failed to decompress Excalidraw compressed-json block.')
  return decompressed
}

function renderSceneSvg(scene: ExcalidrawScene, theme: 'light' | 'dark'): string {
  const elements = (scene.elements ?? []).filter((element) => !element.isDeleted)
  const bounds = getSceneBounds(elements)
  const viewBox = `${bounds.minX - PADDING} ${bounds.minY - PADDING} ${bounds.width + PADDING * 2} ${bounds.height + PADDING * 2}`
  const bg = scene.appState?.viewBackgroundColor || (theme === 'dark' ? '#0f172a' : '#ffffff')
  const body = elements.map(renderElement).join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width + PADDING * 2}" height="${bounds.height + PADDING * 2}" viewBox="${viewBox}" style="background:${escapeAttr(bg)};max-width:min(90vw,1400px);max-height:calc(100vh - 160px);">
  <defs>
    <marker id="excalidraw-arrow" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto" markerUnits="strokeWidth">
      <path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" />
    </marker>
  </defs>
  ${body}
</svg>`
}

function getSceneBounds(elements: ExcalidrawElement[]): SceneBounds {
  if (elements.length === 0) {
    return { minX: 0, minY: 0, maxX: FALLBACK_WIDTH, maxY: FALLBACK_HEIGHT, width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT }
  }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const element of elements) {
    const box = getElementBox(element)
    minX = Math.min(minX, box.minX)
    minY = Math.min(minY, box.minY)
    maxX = Math.max(maxX, box.maxX)
    maxY = Math.max(maxY, box.maxY)
  }

  const width = Math.max(maxX - minX, 200)
  const height = Math.max(maxY - minY, 160)
  return { minX, minY, maxX, maxY, width, height }
}

function getElementBox(element: ExcalidrawElement): SceneBounds {
  if ((element.type === 'arrow' || element.type === 'line' || element.type === 'freedraw') && element.points?.length) {
    const xs = element.points.map(([x]) => element.x + x)
    const ys = element.points.map(([, y]) => element.y + y)
    const minX = Math.min(...xs)
    const minY = Math.min(...ys)
    const maxX = Math.max(...xs)
    const maxY = Math.max(...ys)
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
  }
  const width = element.width ?? 0
  const height = element.height ?? 0
  return { minX: element.x, minY: element.y, maxX: element.x + width, maxY: element.y + height, width, height }
}

function renderElement(element: ExcalidrawElement): string {
  const stroke = element.strokeColor || '#1e1e1e'
  const fill = normalizeFill(element.backgroundColor)
  const strokeWidth = element.strokeWidth ?? 2
  const opacity = (element.opacity ?? 100) / 100
  const common = `stroke="${escapeAttr(stroke)}" stroke-width="${strokeWidth}" opacity="${opacity}"`
  const transform = element.angle ? ` transform="rotate(${radiansToDegrees(element.angle)} ${element.x + (element.width ?? 0) / 2} ${element.y + (element.height ?? 0) / 2})"` : ''

  switch (element.type) {
    case 'rectangle':
      return `<rect x="${element.x}" y="${element.y}" width="${element.width ?? 0}" height="${element.height ?? 0}" rx="10" fill="${fill}" ${common}${transform}/>`
    case 'ellipse':
      return `<ellipse cx="${element.x + (element.width ?? 0) / 2}" cy="${element.y + (element.height ?? 0) / 2}" rx="${Math.abs(element.width ?? 0) / 2}" ry="${Math.abs(element.height ?? 0) / 2}" fill="${fill}" ${common}${transform}/>`
    case 'diamond': {
      const w = element.width ?? 0
      const h = element.height ?? 0
      const points = `${element.x + w / 2},${element.y} ${element.x + w},${element.y + h / 2} ${element.x + w / 2},${element.y + h} ${element.x},${element.y + h / 2}`
      return `<polygon points="${points}" fill="${fill}" ${common}${transform}/>`
    }
    case 'text':
      return renderText(element)
    case 'arrow':
    case 'line':
    case 'freedraw':
      return renderPolyline(element, common)
    case 'image':
      return `<rect x="${element.x}" y="${element.y}" width="${element.width ?? 0}" height="${element.height ?? 0}" rx="8" fill="#f8fafc" stroke="#cbd5e1" stroke-width="1" opacity="${opacity}"/><text x="${element.x + 12}" y="${element.y + 28}" font-family="Inter, system-ui, sans-serif" font-size="14" fill="#64748b">Image element</text>`
    default:
      return ''
  }
}

function renderPolyline(element: ExcalidrawElement, common: string): string {
  if (!element.points?.length) return ''
  const points = element.points.map(([x, y]) => `${element.x + x},${element.y + y}`).join(' ')
  const markerStart = element.startArrowhead ? ' marker-start="url(#excalidraw-arrow)"' : ''
  const markerEnd = element.endArrowhead ? ' marker-end="url(#excalidraw-arrow)"' : ''
  return `<polyline points="${points}" fill="none" ${common} stroke-linecap="round" stroke-linejoin="round"${markerStart}${markerEnd}/>`
}

function renderText(element: ExcalidrawElement): string {
  const text = element.text ?? element.rawText ?? ''
  const fontSize = element.fontSize ?? 20
  const fill = element.strokeColor || '#1e1e1e'
  const lines = text.split('\n')
  const lineHeight = fontSize * 1.25
  const width = element.width ?? lines.reduce((max, line) => Math.max(max, line.length * fontSize * 0.55), 0)
  const height = element.height ?? lines.length * lineHeight
  const anchor = element.textAlign === 'center' ? 'middle' : element.textAlign === 'right' ? 'end' : 'start'
  const x = element.textAlign === 'center' ? element.x + width / 2 : element.textAlign === 'right' ? element.x + width : element.x
  const verticalOffset = element.verticalAlign === 'middle'
    ? (height - lines.length * lineHeight) / 2
    : element.verticalAlign === 'bottom'
      ? height - lines.length * lineHeight
      : 0
  const tspans = lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeText(line)}</tspan>`).join('')
  return `<text x="${x}" y="${element.y + verticalOffset + fontSize}" font-family="Virgil, Comic Sans MS, Bradley Hand, system-ui, sans-serif" font-size="${fontSize}" fill="${escapeAttr(fill)}" text-anchor="${anchor}">${tspans}</text>`
}

function normalizeFill(color?: string): string {
  if (!color || color === 'transparent') return 'none'
  return escapeAttr(color)
}

function parseSvgDimensions(svgString: string): { width: number; height: number } | null {
  const widthMatch = svgString.match(/width="(\d+(?:\.\d+)?)"/)
  const heightMatch = svgString.match(/height="(\d+(?:\.\d+)?)"/)
  if (!widthMatch?.[1] || !heightMatch?.[1]) return null
  return { width: parseFloat(widthMatch[1]), height: parseFloat(heightMatch[1]) }
}

function radiansToDegrees(value: number): number {
  return value * (180 / Math.PI)
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;')
}
