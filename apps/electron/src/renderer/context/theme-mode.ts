import type { ThemeOverrides } from '@config/theme'

export function isScenicTheme(theme: Pick<ThemeOverrides, 'mode' | 'backgroundImage'>): boolean {
  return theme.mode === 'scenic' && Boolean(theme.backgroundImage)
}
