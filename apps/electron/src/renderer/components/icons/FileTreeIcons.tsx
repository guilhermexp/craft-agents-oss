/**
 * File Tree Icons
 *
 * Filled SVG glyphs for the file trees, in the same house style as
 * SettingsIcons: solid shapes on `fill="currentColor"` rather than strokes.
 *
 * Lucide's 2px outlines are drawn for 24px. At the 14px the tree uses, the
 * stroke is most of the glyph and the interior is empty, so on a dark surface
 * they read as grey scaffolding instead of icons. A filled shape carries the
 * same silhouette with enough ink to survive the size.
 */

type IconProps = { className?: string }

function Glyph({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      {children}
    </svg>
  )
}

export const FolderGlyph = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.06a2.5 2.5 0 0 1 1.77.73L11.5 6h7A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5v-11Z" />
  </Glyph>
)

export const FolderOpenGlyph = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.06a2.5 2.5 0 0 1 1.77.73L11.5 6h7A2.5 2.5 0 0 1 21 8.5V10H8.62a2.5 2.5 0 0 0-2.4 1.8L4 19.4a2.49 2.49 0 0 1-1-2V6.5Z" />
    <path d="M7.66 12.2a1.5 1.5 0 0 1 1.44-1.08h12.2a1.5 1.5 0 0 1 1.44 1.92l-1.83 6.24A2.5 2.5 0 0 1 18.51 21H5.1a1.5 1.5 0 0 1-1.44-1.92l4-6.88Z" />
  </Glyph>
)

/** Sheet with a folded corner. The fold is a lighter facet so it reads as paper. */
export const DocumentGlyph = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M6 2h7.17L20 8.83V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z" />
    <path d="M13.5 2.2 19.8 8.5h-5.3a1 1 0 0 1-1-1V2.2Z" className="opacity-40" />
  </Glyph>
)

export const ImageGlyph = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M3 6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6Zm5.75 1.5a2.25 2.25 0 1 0 0 4.5 2.25 2.25 0 0 0 0-4.5ZM5 19v-1.2l3.9-4.36a1.5 1.5 0 0 1 2.2-.03l2.62 2.8 1.63-1.6a1.5 1.5 0 0 1 2.13.03L19 16.3V19H5Z"
    />
  </Glyph>
)

export const AudioGlyph = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M19.4 2.1a1.4 1.4 0 0 1 1.6 1.38v10.9a3.6 3.6 0 1 1-2.8-3.5V6.3l-7.4 1.6v9.06a3.6 3.6 0 1 1-2.8-3.5V6.9a1.4 1.4 0 0 1 1.1-1.37l10.3-2.23Z" />
  </Glyph>
)

export const VideoGlyph = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h8A2.5 2.5 0 0 1 16 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 3 16.5v-9Z" />
    <path d="M17.5 10.2l3.1-2.2a.9.9 0 0 1 1.4.74v6.52a.9.9 0 0 1-1.4.74l-3.1-2.2v-3.6Z" className="opacity-60" />
  </Glyph>
)

/** Angle brackets cut out of the sheet, so code reads apart from prose. */
export const CodeGlyph = ({ className }: IconProps) => (
  <Glyph className={className}>
    <path
      fillRule="evenodd"
      clipRule="evenodd"
      d="M6 2h7.17L20 8.83V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm3.6 9.3a1 1 0 0 0-1.4-.1l-2.3 2a1 1 0 0 0 0 1.5l2.3 2a1 1 0 1 0 1.3-1.5l-1.43-1.25L9.5 12.7a1 1 0 0 0 .1-1.4Zm4.8 0a1 1 0 0 1 1.4-.1l2.3 2a1 1 0 0 1 0 1.5l-2.3 2a1 1 0 1 1-1.3-1.5l1.43-1.25-1.43-1.25a1 1 0 0 1-.1-1.4Z"
    />
  </Glyph>
)

export const FileGlyph = DocumentGlyph
