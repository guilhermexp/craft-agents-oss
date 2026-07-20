import { describe, expect, it } from 'bun:test'
import * as rightSidebarSizing from '../right-sidebar-sizing'

interface EffectiveWidthInput {
  width: number
  windowWidth: number
  edgeInset: number
  minWidth: number
  requiredMinWidth?: number
}

type GetEffectiveWidth = (input: EffectiveWidthInput) => number

function getEffectiveWidthFunction(): GetEffectiveWidth | undefined {
  const sizing = rightSidebarSizing as unknown as {
    getRightSidebarEffectiveWidth?: GetEffectiveWidth
  }
  return sizing.getRightSidebarEffectiveWidth
}

describe('getRightSidebarResizeWidth', () => {
  it('allows the right sidebar to grow past the old 520px cap', () => {
    expect(rightSidebarSizing.getRightSidebarResizeWidth({
      windowWidth: 1440,
      clientX: 300,
      edgeInset: 8,
      minWidth: 260,
    })).toBe(1132)
  })

  it('still keeps the panel at a usable minimum', () => {
    expect(rightSidebarSizing.getRightSidebarResizeWidth({
      windowWidth: 1440,
      clientX: 1300,
      edgeInset: 8,
      minWidth: 260,
    })).toBe(260)
  })

  it('grows a narrow sidebar to the minimum required by the split preview', () => {
    const getEffectiveWidth = getEffectiveWidthFunction()
    expect(typeof getEffectiveWidth).toBe('function')
    if (!getEffectiveWidth) return

    expect(getEffectiveWidth({
      width: 320,
      windowWidth: 1440,
      edgeInset: 8,
      minWidth: 260,
      requiredMinWidth: 541,
    })).toBe(541)
  })

  it('reclamps a persisted width when the viewport becomes smaller', () => {
    const getEffectiveWidth = getEffectiveWidthFunction()
    expect(typeof getEffectiveWidth).toBe('function')
    if (!getEffectiveWidth) return

    expect(getEffectiveWidth({
      width: 1200,
      windowWidth: 800,
      edgeInset: 8,
      minWidth: 260,
    })).toBe(784)
  })
})
