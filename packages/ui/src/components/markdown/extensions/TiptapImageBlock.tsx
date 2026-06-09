import Image from '@tiptap/extension-image'
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react'
import * as React from 'react'

interface TiptapImageNodeViewProps {
  node: { attrs: Record<string, unknown> }
  editor: {
    chain: () => {
      focus: () => {
        setNodeSelection: (pos: number) => { run: () => void }
      }
    }
  }
  getPos: () => number | undefined
  updateAttributes: (attrs: Record<string, unknown>) => void
}

const FALLBACK_IMAGE_MIN_HEIGHT = 220

function toPositiveNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return null
}

function TiptapImageNodeView({ node, editor, getPos, updateAttributes }: TiptapImageNodeViewProps) {
  const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
  const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : ''
  const width = toPositiveNumber(node.attrs.width)
  const height = toPositiveNumber(node.attrs.height)
  const hasIntrinsicSize = width != null && height != null

  const imageRef = React.useRef<HTMLImageElement | null>(null)
  const [loadedSrc, setLoadedSrc] = React.useState<string | null>(null)
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null)
  const loaded = loadedSrc === src
  const failed = failedSrc === src

  // When the image element is reused for a new src, check if the browser has
  // already cached it (complete before any load event fires).
  React.useEffect(() => {
    const image = imageRef.current
    if (!image) return
    if (!image.complete) return
    if (image.naturalWidth > 0 && image.naturalHeight > 0) {
      setLoadedSrc(src)
    } else {
      setFailedSrc(src)
    }
  }, [src])

  const captureIntrinsicDimensions = React.useCallback((image: HTMLImageElement) => {
    if (hasIntrinsicSize) return
    if (!image.naturalWidth || !image.naturalHeight) return

    updateAttributes({
      width: image.naturalWidth,
      height: image.naturalHeight,
    })
  }, [hasIntrinsicSize, updateAttributes])

  const selectNode = React.useCallback(() => {
    const pos = getPos()
    if (typeof pos !== 'number') return
    editor.chain().focus().setNodeSelection(pos).run()
  }, [editor, getPos])

  const shellStyle = hasIntrinsicSize
    ? { aspectRatio: `${width} / ${height}` }
    : !loaded && !failed
      ? { minHeight: `${FALLBACK_IMAGE_MIN_HEIGHT}px` }
      : undefined

  return (
    <NodeViewWrapper
      contentEditable={false}
      className="tiptap-image-block"
      data-drag-handle
      onMouseDownCapture={(event: React.MouseEvent) => {
        if (event.button !== 0) return
        const target = event.target as HTMLElement | null
        if (target?.closest('button')) return
        event.preventDefault()
        event.stopPropagation()
        selectNode()
      }}
    >
      <div
        className="tiptap-image-shell"
        data-loading={!loaded && !failed ? 'true' : 'false'}
        data-error={failed ? 'true' : 'false'}
        style={shellStyle}
      >
        {!loaded && !failed && <div className="tiptap-image-placeholder" aria-hidden="true" />}
        <img
          ref={imageRef}
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(event) => {
            const image = event.currentTarget
            captureIntrinsicDimensions(image)
            setLoadedSrc(src)
          }}
          onError={() => {
            setFailedSrc(src)
          }}
          className="tiptap-image-element"
          data-loaded={loaded ? 'true' : 'false'}
        />
      </div>
    </NodeViewWrapper>
  )
}

export const TiptapImageBlock = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute('width')
          if (!value) return null
          const parsed = Number.parseFloat(value)
          return Number.isFinite(parsed) && parsed > 0 ? parsed : null
        },
        renderHTML: (attributes: { width?: number | null }) => {
          if (!attributes.width) return {}
          return { width: attributes.width }
        },
      },
      height: {
        default: null,
        parseHTML: (element: HTMLElement) => {
          const value = element.getAttribute('height')
          if (!value) return null
          const parsed = Number.parseFloat(value)
          return Number.isFinite(parsed) && parsed > 0 ? parsed : null
        },
        renderHTML: (attributes: { height?: number | null }) => {
          if (!attributes.height) return {}
          return { height: attributes.height }
        },
      },
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(TiptapImageNodeView)
  },
})
