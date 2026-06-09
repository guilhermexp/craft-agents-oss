/**
 * Settings Pages
 *
 * All pages that appear under the settings navigator.
 */

export { default as SettingsNavigator } from './SettingsNavigator'
export { default as AppSettingsPage } from './AppSettingsPage'
export { default as AiSettingsPage, meta as AiSettingsMeta } from './AiSettingsPage'
export { default as AppearanceSettingsPage, meta as AppearanceMeta } from './AppearanceSettingsPage'
export { default as InputSettingsPage } from './InputSettingsPage'
export { default as WorkspaceSettingsPage, meta as WorkspaceSettingsMeta } from './WorkspaceSettingsPage'
export { default as PermissionsSettingsPage } from './PermissionsSettingsPage'
export { default as LabelsSettingsPage } from './LabelsSettingsPage'
export { default as ShortcutsPage } from './ShortcutsPage'
export { default as PreferencesPage } from './PreferencesPage'

// Re-export types
export type { DetailsPageMeta } from '@/lib/navigation-registry'
