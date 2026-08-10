import { describe, expect, it } from 'bun:test'
import manifestJson from '../../../generated/file-icons/manifest.json'
import { getMaterialIconName, materialIconUrl, type MaterialFileIconManifest } from '../material-file-icons'

const manifest = manifestJson as MaterialFileIconManifest

describe('material file icon resolution', () => {
  it('prefers the longest compound extension over the trailing one', () => {
    // `test.tsx` and `tsx` both map; picking the short one would give every
    // spec file the plain React icon and erase the distinction.
    expect(manifest.fileExtensions['test.tsx']).toBeDefined()
    expect(getMaterialIconName('button.test.tsx', false, false, manifest))
      .toBe(manifest.fileExtensions['test.tsx']!)
    expect(getMaterialIconName('button.tsx', false, false, manifest))
      .toBe(manifest.fileExtensions['tsx']!)
  })

  it('matches an exact filename ahead of its extension', () => {
    expect(getMaterialIconName('package.json', false, false, manifest))
      .toBe(manifest.fileNames['package.json']!)
    expect(getMaterialIconName('package.json', false, false, manifest))
      .not.toBe(manifest.fileExtensions['json']!)
  })

  it('keeps a named folder icon when open, rather than dropping to the generic one', () => {
    // Not every named folder ships an expanded variant. The specific closed
    // shape still says more than a generic open folder.
    const named = Object.keys(manifest.folderNames)
      .find(key => !manifest.folderNamesExpanded[key])

    if (named) {
      expect(getMaterialIconName(named, true, true, manifest)).toBe(manifest.folderNames[named]!)
    }

    expect(getMaterialIconName('a-folder-nobody-named', true, true, manifest))
      .toBe(manifest.defaultFolderOpenIcon)
  })

  it('resolves folder names case-insensitively', () => {
    expect(getMaterialIconName('DOCS', true, false, manifest))
      .toBe(getMaterialIconName('docs', true, false, manifest))
  })

  it('falls back to the default icon for unknown files', () => {
    expect(getMaterialIconName('mystery.zzzz', false, false, manifest)).toBe(manifest.defaultIcon)
    expect(getMaterialIconName('LICENSE-unknown', false, false, manifest)).toBe(manifest.defaultIcon)
  })

  it('never lets a name escape the icon directory', () => {
    expect(materialIconUrl('../../etc/passwd')).toMatch(/file-icons\/file\.svg$/)
    expect(materialIconUrl('/absolute')).toMatch(/file-icons\/absolute\.svg$/)
    expect(materialIconUrl('markdown.svg')).toMatch(/file-icons\/markdown\.svg$/)
  })

  it('can resolve every name the manifest returns', () => {
    // A mapping whose asset is missing renders a broken image in the tree, so
    // the vendored manifest must not reference one.
    const referenced = new Set<string>([
      manifest.defaultIcon,
      manifest.defaultFolderIcon,
      manifest.defaultFolderOpenIcon,
      ...Object.values(manifest.fileNames),
      ...Object.values(manifest.fileExtensions),
      ...Object.values(manifest.folderNames),
      ...Object.values(manifest.folderNamesExpanded),
    ])

    const missing = [...referenced].filter(name => !Bun.file(
      new URL(`../../../public/file-icons/${name}.svg`, import.meta.url).pathname,
    ).size)

    expect(missing).toEqual([])
  })
})
