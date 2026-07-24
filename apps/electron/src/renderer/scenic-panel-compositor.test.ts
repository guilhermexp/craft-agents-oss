import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(import.meta.dir, 'index.css'), 'utf8')

function declarationBlock(selectorPattern: RegExp): string {
  const match = css.match(selectorPattern)
  expect(match).not.toBeNull()
  return match?.[1] ?? ''
}

describe('scenic panel compositor contract', () => {
  it('keeps shared scrolling panels off live backdrop filtering', () => {
    const panelBlock = declarationBlock(
      /html\[data-scenic\] \.shadow-middle,\s*html\[data-scenic\] \.shadow-strong\s*\{([^}]*)\}/,
    )

    expect(panelBlock).not.toMatch(/(?:^|\n)\s*(?:-webkit-)?backdrop-filter\s*:/)
    expect(panelBlock).toContain('position: relative')
    expect(panelBlock).toContain('z-index: var(--z-panel)')
  })

  it('preserves scenic translucency, wallpaper softness, and panel borders', () => {
    const scenicSurfaceBlock = declarationBlock(/html\[data-scenic\]\s*\{([^}]*)\}/)
    const wallpaperBlock = declarationBlock(/html\[data-scenic\]::before\s*\{([^}]*)\}/)
    const borderBlock = declarationBlock(
      /html\[data-scenic\] \.shadow-middle::before,\s*html\[data-scenic\] \.shadow-strong::before\s*\{([^}]*)\}/,
    )

    expect(scenicSurfaceBlock).toMatch(/--background:[^;]*\/\s*0\.55\s*\)/)
    expect(wallpaperBlock).toContain('filter: blur(var(--scenic-background-blur')
    expect(borderBlock).toContain('-webkit-mask-composite: xor')
    expect(borderBlock).toContain('mix-blend-mode: soft-light')
  })
})
