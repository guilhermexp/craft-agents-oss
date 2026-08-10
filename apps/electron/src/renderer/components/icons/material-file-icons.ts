/**
 * Material file icon resolution.
 *
 * Name -> icon lookup for the Material Icon Theme assets vendored under
 * `src/renderer/public/file-icons`. Pure and manifest-driven so the mapping
 * stays testable without touching the DOM or the asset directory.
 *
 * The manifest is pruned at vendor time: every name it can return has a file,
 * so a lookup either hits a real asset or falls through to the defaults.
 */

export interface MaterialFileIconManifest {
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
  folderNames: Record<string, string>
  folderNamesExpanded: Record<string, string>
  defaultIcon: string
  defaultFolderIcon: string
  defaultFolderOpenIcon: string
}

export function getMaterialIconName(
  name: string,
  isDirectory: boolean,
  isOpen: boolean,
  manifest: MaterialFileIconManifest,
): string {
  return isDirectory
    ? folderIconName(name, isOpen, manifest)
    : fileIconName(name, manifest)
}

function folderIconName(folderName: string, isOpen: boolean, manifest: MaterialFileIconManifest): string {
  const key = folderName.toLowerCase()

  // A named folder with no open variant keeps its closed icon: the specific
  // shape says more than a generic open folder does.
  if (isOpen) {
    return manifest.folderNamesExpanded[key] ?? manifest.folderNames[key] ?? manifest.defaultFolderOpenIcon
  }

  return manifest.folderNames[key] ?? manifest.defaultFolderIcon
}

function fileIconName(fileName: string, manifest: MaterialFileIconManifest): string {
  const exact = manifest.fileNames[fileName] ?? manifest.fileNames[fileName.toLowerCase()]
  if (exact) return exact

  // Longest compound extension first: `component.test.tsx` should find `test.tsx`
  // before falling back to `tsx`, which is how the theme distinguishes them.
  const dotIndex = fileName.indexOf('.')
  if (dotIndex !== -1) {
    const segments = fileName.slice(dotIndex + 1).toLowerCase().split('.')
    for (let index = 0; index < segments.length; index++) {
      const candidate = manifest.fileExtensions[segments.slice(index).join('.')]
      if (candidate) return candidate
    }
  }

  return manifest.defaultIcon
}

/**
 * Public-asset URL for an icon name.
 *
 * Relative to the document rather than rooted at `/`: the packaged renderer is
 * loaded over `file://`, where an absolute path resolves against the filesystem
 * root instead of the bundle.
 */
export function materialIconUrl(iconName: string): string {
  const safe = iconName.replace(/^\/+/, '').replace(/\.svg$/i, '')
  const usable = safe && !safe.includes('/') && !safe.includes('\\') && !safe.includes('..')
  return `${import.meta.env.BASE_URL}file-icons/${usable ? safe : 'file'}.svg`
}
