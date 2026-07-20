export interface RightSidebarResizeInput {
  windowWidth: number
  clientX: number
  edgeInset: number
  minWidth: number
}

export interface RightSidebarEffectiveWidthInput {
  width: number
  windowWidth: number
  edgeInset: number
  minWidth: number
  requiredMinWidth?: number
}

export const RIGHT_SIDEBAR_MIN_WIDTH = 260
export const RIGHT_SIDEBAR_SPLIT_MIN_WIDTH = 541

export function getRightSidebarEffectiveWidth({
  width,
  windowWidth,
  edgeInset,
  minWidth,
  requiredMinWidth = minWidth,
}: RightSidebarEffectiveWidthInput): number {
  const maxWidth = Math.max(minWidth, windowWidth - edgeInset * 2)
  const effectiveMinWidth = Math.min(Math.max(minWidth, requiredMinWidth), maxWidth)
  return Math.min(Math.max(width, effectiveMinWidth), maxWidth)
}

export function getRightSidebarResizeWidth({
  windowWidth,
  clientX,
  edgeInset,
  minWidth,
}: RightSidebarResizeInput): number {
  const requestedWidth = windowWidth - clientX - edgeInset
  return getRightSidebarEffectiveWidth({
    width: requestedWidth,
    windowWidth,
    edgeInset,
    minWidth,
  })
}
