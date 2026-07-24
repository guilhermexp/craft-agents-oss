export interface RightSidebarResizeInput {
  windowWidth: number
  clientX: number
  edgeInset: number
  minWidth: number
  /** Optional hard cap on the resulting width (e.g. compact file-list mode). */
  maxWidthCap?: number
}

export interface RightSidebarEffectiveWidthInput {
  width: number
  windowWidth: number
  edgeInset: number
  minWidth: number
  requiredMinWidth?: number
  /** Optional hard cap on the resulting width (e.g. compact file-list mode). */
  maxWidthCap?: number
}

export const RIGHT_SIDEBAR_MIN_WIDTH = 260
export const RIGHT_SIDEBAR_SPLIT_MIN_WIDTH = 541

/** Default width for the file-list-only view (no preview open). */
export const RIGHT_SIDEBAR_DEFAULT_WIDTH = 320
/** Hard cap for the file-list-only view so it never opens absurdly wide. */
export const RIGHT_SIDEBAR_TREE_ONLY_MAX_WIDTH = 380
/** Default width when a file preview is open — wide enough for a large preview. */
export const RIGHT_SIDEBAR_SPLIT_DEFAULT_WIDTH = 720

export function getRightSidebarEffectiveWidth({
  width,
  windowWidth,
  edgeInset,
  minWidth,
  requiredMinWidth = minWidth,
  maxWidthCap,
}: RightSidebarEffectiveWidthInput): number {
  const windowMax = Math.max(minWidth, windowWidth - edgeInset * 2)
  const maxWidth = maxWidthCap !== undefined
    ? Math.min(windowMax, Math.max(minWidth, maxWidthCap))
    : windowMax
  const effectiveMinWidth = Math.min(Math.max(minWidth, requiredMinWidth), maxWidth)
  return Math.min(Math.max(width, effectiveMinWidth), maxWidth)
}

export function getRightSidebarResizeWidth({
  windowWidth,
  clientX,
  edgeInset,
  minWidth,
  maxWidthCap,
}: RightSidebarResizeInput): number {
  const requestedWidth = windowWidth - clientX - edgeInset
  return getRightSidebarEffectiveWidth({
    width: requestedWidth,
    windowWidth,
    edgeInset,
    minWidth,
    maxWidthCap,
  })
}
