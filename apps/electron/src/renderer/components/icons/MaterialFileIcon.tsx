/**
 * Material file icons
 *
 * Colour-coded per filename, extension and folder name, the way an editor's
 * file tree reads. Monochrome glyphs make every row look the same; these carry
 * the type in the colour, so a tree is scannable without reading extensions.
 *
 * Rendered as <img> against the vendored public assets rather than inlined
 * components: 1080 icons would be 1080 modules in the bundle for the handful a
 * given tree actually shows.
 */

import manifestJson from '@/generated/file-icons/manifest.json'
import { cn } from '@/lib/utils'
import { getMaterialIconName, materialIconUrl, type MaterialFileIconManifest } from './material-file-icons'

const manifest = manifestJson as MaterialFileIconManifest

interface MaterialIconProps {
  className?: string
}

export function MaterialFileIcon({ fileName, className }: MaterialIconProps & { fileName: string }) {
  return <MaterialIconImage iconName={getMaterialIconName(fileName, false, false, manifest)} className={className} />
}

export function MaterialFolderIcon({
  folderName,
  isOpen = false,
  className,
}: MaterialIconProps & { folderName: string; isOpen?: boolean }) {
  return <MaterialIconImage iconName={getMaterialIconName(folderName, true, isOpen, manifest)} className={className} />
}

function MaterialIconImage({ iconName, className }: MaterialIconProps & { iconName: string }) {
  return (
    <img
      src={materialIconUrl(iconName)}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn('size-4 shrink-0 select-none object-contain', className)}
    />
  )
}
