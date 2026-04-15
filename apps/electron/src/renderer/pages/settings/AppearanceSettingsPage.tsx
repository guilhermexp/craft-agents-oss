/**
 * AppearanceSettingsPage
 *
 * Visual customization settings: theme mode, color theme, font,
 * workspace-specific theme overrides, and CLI tool icon mappings.
 */

import { useState, useEffect, useMemo, useCallback, type ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { LANGUAGES, type LanguageCode } from '@craft-agent/shared/i18n'
import type { ColumnDef } from '@tanstack/react-table'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Button } from '@/components/ui/button'
import { EditPopover, EditButton, getEditConfig } from '@/components/ui/EditPopover'
import { useTheme } from '@/context/ThemeContext'
import { useAppShellContext } from '@/context/AppShellContext'
import { routes } from '@/lib/navigate'
import { Image as ImageIcon, Monitor, Sun, Moon } from 'lucide-react'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { ToolIconMapping } from '../../../shared/types'

import {
  SettingsSection,
  SettingsCard,
  SettingsCardContent,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsMenuSelect,
  SettingsToggle,
} from '@/components/settings'
import * as storage from '@/lib/local-storage'
import { useWorkspaceIcons } from '@/hooks/useWorkspaceIcon'
import { Info_DataTable, SortableHeader } from '@/components/info/Info_DataTable'
import { Info_Badge } from '@/components/info/Info_Badge'
import type { PresetTheme } from '@config/theme'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'appearance',
}

// ============================================
// Tool Icons Table
// ============================================

/**
 * Column definitions for the tool icon mappings table.
 * Shows a preview icon, tool name, and the CLI commands that trigger it.
 */
const getToolIconColumns = (t: (key: string) => string): ColumnDef<ToolIconMapping>[] => [
  {
    accessorKey: 'iconDataUrl',
    header: () => <span className="p-1.5 pl-2.5">{t("settings.appearance.iconHeader")}</span>,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5">
        <img
          src={row.original.iconDataUrl}
          alt={row.original.displayName}
          className="w-5 h-5 object-contain"
        />
      </div>
    ),
    size: 60,
    enableSorting: false,
  },
  {
    accessorKey: 'displayName',
    header: ({ column }) => <SortableHeader column={column} title={t("settings.appearance.toolHeader")} />,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5 font-medium">
        {row.original.displayName}
      </div>
    ),
    size: 150,
  },
  {
    accessorKey: 'commands',
    header: () => <span className="p-1.5 pl-2.5">{t("settings.appearance.commandsHeader")}</span>,
    cell: ({ row }) => (
      <div className="p-1.5 pl-2.5 flex flex-wrap gap-1">
        {row.original.commands.map(cmd => (
          <Info_Badge key={cmd} color="muted" className="font-mono">
            {cmd}
          </Info_Badge>
        ))}
      </div>
    ),
    meta: { fillWidth: true },
    enableSorting: false,
  },
]

const SOLID_SCENIC_BACKGROUNDS = {
  black: createSolidBackgroundDataUrl('#0b0b0c'),
  gray: createSolidBackgroundDataUrl('#565b63'),
} as const

type ScenicBackgroundType = 'image' | keyof typeof SOLID_SCENIC_BACKGROUNDS
const DEFAULT_SCENIC_BACKGROUND_OPACITY = 1

function createSolidBackgroundDataUrl(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${color}"/></svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function getScenicBackgroundType(backgroundImage: string | null | undefined): ScenicBackgroundType {
  if (!backgroundImage) return 'image'
  if (backgroundImage === SOLID_SCENIC_BACKGROUNDS.black) return 'black'
  if (backgroundImage === SOLID_SCENIC_BACKGROUNDS.gray) return 'gray'
  return 'image'
}

function buildNextAppTheme(
  currentTheme: import('@config/theme').ThemeOverrides | null,
  updates: Partial<import('@config/theme').ThemeOverrides>
): import('@config/theme').ThemeOverrides | null {
  const nextTheme: import('@config/theme').ThemeOverrides = {
    ...(currentTheme ?? {}),
    ...updates,
  }

  if (nextTheme.dark && Object.keys(nextTheme.dark).length === 0) {
    delete nextTheme.dark
  }

  for (const key of Object.keys(nextTheme) as Array<keyof typeof nextTheme>) {
    if (nextTheme[key] === undefined) {
      delete nextTheme[key]
    }
  }

  return Object.keys(nextTheme).length > 0 ? nextTheme : null
}

// ============================================
// Main Component
// ============================================

export default function AppearanceSettingsPage() {
  const { t, i18n } = useTranslation()
  const toolIconColumns = useMemo(() => getToolIconColumns(t), [t])

  const {
    mode,
    setMode,
    colorTheme,
    setColorTheme,
    font,
    setFont,
    appTheme,
    setAppTheme,
    activeWorkspaceId,
    setWorkspaceColorTheme,
    resolvedTheme,
    themeLoadError,
    themeResolvedFrom,
  } = useTheme()
  const { workspaces } = useAppShellContext()

  // Fetch workspace icons as data URLs (file:// URLs don't work in renderer)
  const workspaceIconMap = useWorkspaceIcons(workspaces)

  // Preset themes for the color theme dropdown
  const [presetThemes, setPresetThemes] = useState<PresetTheme[]>([])

  // Per-workspace theme overrides (workspaceId -> themeId or undefined)
  const [workspaceThemes, setWorkspaceThemes] = useState<Record<string, string | undefined>>({})

  // Tool icon mappings loaded from main process
  const [toolIcons, setToolIcons] = useState<ToolIconMapping[]>([])

  // Resolved path to tool-icons.json (needed for EditPopover and "Edit File" action)
  const [toolIconsJsonPath, setToolIconsJsonPath] = useState<string | null>(null)

  // Connection icon visibility toggle
  const [showConnectionIcons, setShowConnectionIcons] = useState(() =>
    storage.get(storage.KEYS.showConnectionIcons, true)
  )
  const handleConnectionIconsChange = useCallback((checked: boolean) => {
    setShowConnectionIcons(checked)
    storage.set(storage.KEYS.showConnectionIcons, checked)
  }, [])

  // Rich tool descriptions toggle (persisted in config.json, read by SDK subprocess)
  const [richToolDescriptions, setRichToolDescriptions] = useState(true)
  useEffect(() => {
    window.electronAPI?.getRichToolDescriptions?.().then(setRichToolDescriptions)
  }, [])
  const handleRichToolDescriptionsChange = useCallback(async (checked: boolean) => {
    setRichToolDescriptions(checked)
    await window.electronAPI?.setRichToolDescriptions?.(checked)
  }, [])

  // Load preset themes on mount
  useEffect(() => {
    const loadThemes = async () => {
      if (!window.electronAPI) {
        setPresetThemes([])
        return
      }
      try {
        const themes = await window.electronAPI.loadPresetThemes()
        setPresetThemes(themes)
      } catch (error) {
        console.error('Failed to load preset themes:', error)
        setPresetThemes([])
      }
    }
    loadThemes()
  }, [])

  // Load workspace themes on mount
  useEffect(() => {
    const loadWorkspaceThemes = async () => {
      if (!window.electronAPI?.getAllWorkspaceThemes) return
      try {
        const themes = await window.electronAPI.getAllWorkspaceThemes()
        setWorkspaceThemes(themes)
      } catch (error) {
        console.error('Failed to load workspace themes:', error)
      }
    }
    loadWorkspaceThemes()
  }, [])

  // Load tool icon mappings and resolve the config file path on mount
  useEffect(() => {
    const load = async () => {
      if (!window.electronAPI) return
      try {
        const [mappings, homeDir] = await Promise.all([
          window.electronAPI.getToolIconMappings(),
          window.electronAPI.getHomeDir(),
        ])
        setToolIcons(mappings)
        setToolIconsJsonPath(`${homeDir}/.craft-agent/tool-icons/tool-icons.json`)
      } catch (error) {
        console.error('Failed to load tool icon mappings:', error)
      }
    }
    load()
  }, [])

  // Handler for workspace theme change
  // Uses ThemeContext for the active workspace (immediate visual update) and IPC for other workspaces
  const handleWorkspaceThemeChange = useCallback(
    async (workspaceId: string, value: string) => {
      // 'default' means inherit from app default (null in storage)
      const themeId = value === 'default' ? null : value

      // If changing the current workspace, use context for immediate update
      if (workspaceId === activeWorkspaceId) {
        setWorkspaceColorTheme(themeId)
      } else {
        // For other workspaces, just persist via IPC
        await window.electronAPI?.setWorkspaceColorTheme?.(workspaceId, themeId)
      }

      // Update local state for UI
      setWorkspaceThemes(prev => ({
        ...prev,
        [workspaceId]: themeId ?? undefined
      }))
    },
    [activeWorkspaceId, setWorkspaceColorTheme]
  )

  // Theme options for dropdowns
  const themeOptions = useMemo(() => [
    { value: 'default', label: t("settings.appearance.useDefault") },
    ...presetThemes
      .filter(t => t.id !== 'default')
      .map(t => ({
        value: t.id,
        label: t.theme.name || t.id,
      })),
  ], [presetThemes, t])

  // Get current app default theme label for display (null when using 'default' to avoid redundant "Use Default (Default)")
  const appDefaultLabel = useMemo(() => {
    if (colorTheme === 'default') return null
    const preset = presetThemes.find(t => t.id === colorTheme)
    return preset?.theme.name || colorTheme
  }, [colorTheme, presetThemes])

  const scenicBackgroundType = getScenicBackgroundType(appTheme?.backgroundImage)
  const scenicBackgroundOpacity = appTheme?.scenicBackgroundOpacity ?? DEFAULT_SCENIC_BACKGROUND_OPACITY
  const scenicBackgroundOpacityPercent = Math.round(scenicBackgroundOpacity * 100)
  const scenicBackgroundPreview = scenicBackgroundType === 'image'
    ? (appTheme?.backgroundImage ?? resolvedTheme.backgroundImage ?? null)
    : SOLID_SCENIC_BACKGROUNDS[scenicBackgroundType]
  const hasCustomScenicBackground = Boolean(appTheme?.backgroundImage) && scenicBackgroundType === 'image'
  const showScenicBackgroundControls = resolvedTheme.mode === 'scenic'

  const scenicBackgroundHelpText = scenicBackgroundType === 'image'
    ? hasCustomScenicBackground
      ? t('settings.appearance.customScenicBackgroundDesc', { defaultValue: 'Using a custom background image for this scenic theme.' })
      : t('settings.appearance.defaultScenicBackgroundDesc', { defaultValue: 'Using the default background that ships with this scenic theme.' })
    : scenicBackgroundType === 'black'
      ? t('settings.appearance.solidBlackBackgroundDesc', { defaultValue: 'Using a solid black background instead of the theme image.' })
      : t('settings.appearance.solidGrayBackgroundDesc', { defaultValue: 'Using a solid gray background instead of the theme image.' })

  const handleScenicBackgroundTypeChange = useCallback(async (value: string) => {
    const nextType = value as ScenicBackgroundType

    try {
      if (nextType === 'image') {
        await setAppTheme(buildNextAppTheme(appTheme, { backgroundImage: undefined }))
        return
      }

      await setAppTheme(buildNextAppTheme(appTheme, {
        backgroundImage: SOLID_SCENIC_BACKGROUNDS[nextType],
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('settings.appearance.failedToSetBackgroundImage', { defaultValue: 'Failed to update background image.' }), {
        description: message,
      })
    }
  }, [appTheme, setAppTheme, t])

  const handleChooseScenicBackground = useCallback(async () => {
    try {
      const paths = await window.electronAPI.openFileDialog()
      const selectedPath = paths[0]
      if (!selectedPath) return

      const lowerPath = selectedPath.toLowerCase()
      const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif'].some(ext => lowerPath.endsWith(ext))
      if (!isImage) {
        toast.error(t('settings.appearance.invalidBackgroundImage', { defaultValue: 'Select an image file to use as background.' }))
        return
      }

      await setAppTheme(buildNextAppTheme(appTheme, { backgroundImage: selectedPath }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('settings.appearance.failedToSetBackgroundImage', { defaultValue: 'Failed to update background image.' }), {
        description: message,
      })
    }
  }, [appTheme, setAppTheme, t])

  const handleResetScenicBackground = useCallback(async () => {
    try {
      const nextTheme = buildNextAppTheme(appTheme, { backgroundImage: undefined })
      await setAppTheme(nextTheme)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('settings.appearance.failedToResetBackgroundImage', { defaultValue: 'Failed to restore the default background image.' }), {
        description: message,
      })
    }
  }, [appTheme, setAppTheme, t])

  const handleScenicOpacityChange = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const nextOpacity = Number(event.target.value) / 100

    try {
      await setAppTheme(buildNextAppTheme(appTheme, {
        scenicBackgroundOpacity: Math.abs(nextOpacity - DEFAULT_SCENIC_BACKGROUND_OPACITY) < 0.001
          ? undefined
          : Number(nextOpacity.toFixed(2)),
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('settings.appearance.failedToSetBackgroundOpacity', { defaultValue: 'Failed to update background opacity.' }), {
        description: message,
      })
    }
  }, [appTheme, setAppTheme, t])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title={t("settings.appearance.title")}
        actions={<HeaderMenu route={routes.view.settings('appearance')} helpFeature="themes" />}
      />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">

              {/* Default Theme */}
              <SettingsSection title={t("settings.appearance.defaultTheme")}>
                <SettingsCard>
                  <SettingsRow label={t("settings.appearance.mode")}>
                    <SettingsSegmentedControl
                      value={mode}
                      onValueChange={setMode}
                      options={[
                        { value: 'system', label: t("settings.appearance.system"), icon: <Monitor className="w-4 h-4" /> },
                        { value: 'light', label: t("settings.appearance.light"), icon: <Sun className="w-4 h-4" /> },
                        { value: 'dark', label: t("settings.appearance.dark"), icon: <Moon className="w-4 h-4" /> },
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={t("settings.appearance.colorTheme")}>
                    <SettingsMenuSelect
                      value={colorTheme}
                      onValueChange={setColorTheme}
                      options={themeOptions}
                    />
                  </SettingsRow>
                  <SettingsRow label={t("settings.appearance.font")}>
                    <SettingsSegmentedControl
                      value={font}
                      onValueChange={setFont}
                      options={[
                        { value: 'inter', label: t("settings.appearance.fontInter") },
                        { value: 'system', label: t("settings.appearance.fontSystem") },
                      ]}
                    />
                  </SettingsRow>
                  <SettingsRow label={t("settings.appearance.language")}>
                    <SettingsMenuSelect
                      value={(i18n.resolvedLanguage ?? i18n.language) as LanguageCode}
                      onValueChange={(value) => {
                        i18n.changeLanguage(value)
                        window.electronAPI?.changeLanguage?.(value)
                      }}
                      options={Object.entries(LANGUAGES).map(([code, config]) => ({
                        value: code,
                        label: config.nativeName,
                      }))}
                    />
                  </SettingsRow>
                </SettingsCard>
                {themeLoadError && (
                  <p className="mt-2 text-xs text-info">
                    {t("settings.appearance.themeWarning")} {themeLoadError} ({themeResolvedFrom === 'fallback' ? t("settings.appearance.usingBundledFallback") : t("settings.appearance.usingDefaultTheme")})
                  </p>
                )}
              </SettingsSection>

              {showScenicBackgroundControls && (
                <SettingsSection
                  title={t('settings.appearance.scenicBackground', { defaultValue: 'Scenic Background' })}
                  description={t('settings.appearance.scenicBackgroundSectionDesc', { defaultValue: 'Choose a custom image for scenic themes like Haze.' })}
                >
                  <SettingsCard divided={false}>
                    <SettingsCardContent className="space-y-4">
                      <div className="flex items-start gap-4">
                        <div className="w-28 h-20 rounded-lg overflow-hidden bg-muted/40 border border-border/50 shrink-0">
                          {scenicBackgroundPreview ? (
                            <img
                              src={scenicBackgroundPreview}
                              alt=""
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
                              <ImageIcon className="w-5 h-5" />
                            </div>
                          )}
                        </div>
                        <div className="min-w-0 flex-1 space-y-3">
                          <div>
                            <div className="text-sm font-medium text-foreground">
                              {t('settings.appearance.scenicBackgroundLabel', { defaultValue: 'Background image' })}
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              {scenicBackgroundHelpText}
                            </p>
                          </div>
                          <SettingsSegmentedControl
                            value={scenicBackgroundType}
                            onValueChange={handleScenicBackgroundTypeChange}
                            options={[
                              { value: 'image', label: t('settings.appearance.scenicBackgroundImageOption', { defaultValue: 'Image' }) },
                              { value: 'black', label: t('settings.appearance.scenicBackgroundBlackOption', { defaultValue: 'Black' }) },
                              { value: 'gray', label: t('settings.appearance.scenicBackgroundGrayOption', { defaultValue: 'Gray' }) },
                            ]}
                          />
                          <div className="space-y-2">
                            <div className="flex items-center justify-between gap-3 text-xs">
                              <span className="text-muted-foreground">
                                {t('settings.appearance.scenicBackgroundOpacity', { defaultValue: 'Opacity' })}
                              </span>
                              <span className="font-medium text-foreground">
                                {scenicBackgroundOpacityPercent}%
                              </span>
                            </div>
                            <input
                              type="range"
                              min={0}
                              max={100}
                              step={1}
                              value={scenicBackgroundOpacityPercent}
                              onChange={handleScenicOpacityChange}
                              className="w-full accent-[var(--accent)]"
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleChooseScenicBackground}
                              disabled={scenicBackgroundType !== 'image'}
                            >
                              {t('settings.appearance.chooseBackgroundImage', { defaultValue: 'Choose image' })}
                            </Button>
                            {hasCustomScenicBackground && scenicBackgroundType === 'image' && (
                              <Button variant="ghost" size="sm" onClick={handleResetScenicBackground}>
                                {t('settings.appearance.resetBackgroundImage', { defaultValue: 'Use theme default' })}
                              </Button>
                            )}
                          </div>
                        </div>
                      </div>
                    </SettingsCardContent>
                  </SettingsCard>
                </SettingsSection>
              )}

              {/* Workspace Themes */}
              {workspaces.length > 0 && (
                <SettingsSection
                  title={t("settings.appearance.workspaceThemes")}
                  description={t("settings.appearance.workspaceThemesDesc")}
                >
                  <SettingsCard>
                    {workspaces.map((workspace) => {
                      const wsTheme = workspaceThemes[workspace.id]
                      const hasCustomTheme = wsTheme !== undefined
                      return (
                        <SettingsRow
                          key={workspace.id}
                          label={
                            <div className="flex items-center gap-2">
                              {workspaceIconMap.get(workspace.id) ? (
                                <img
                                  src={workspaceIconMap.get(workspace.id)}
                                  alt=""
                                  className="w-4 h-4 rounded object-cover"
                                />
                              ) : (
                                <div className="w-4 h-4 rounded bg-foreground/10" />
                              )}
                              <span>{workspace.name}</span>
                            </div>
                          }
                        >
                          <SettingsMenuSelect
                            value={hasCustomTheme ? wsTheme : 'default'}
                            onValueChange={(value) => handleWorkspaceThemeChange(workspace.id, value)}
                            options={[
                              { value: 'default', label: appDefaultLabel ? t("settings.appearance.useDefaultWithTheme", { theme: appDefaultLabel }) : t("settings.appearance.useDefault") },
                              ...presetThemes
                                .filter(t => t.id !== 'default')
                                .map(t => ({
                                  value: t.id,
                                  label: t.theme.name || t.id,
                                })),
                            ]}
                          />
                        </SettingsRow>
                      )
                    })}
                  </SettingsCard>
                </SettingsSection>
              )}

              {/* Interface */}
              <SettingsSection title={t("settings.appearance.interface")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.appearance.connectionIcons")}
                    description={t("settings.appearance.connectionIconsDesc")}
                    checked={showConnectionIcons}
                    onCheckedChange={handleConnectionIconsChange}
                  />
                  <SettingsToggle
                    label={t("settings.appearance.richToolDescriptions")}
                    description={t("settings.appearance.richToolDescriptionsDesc")}
                    checked={richToolDescriptions}
                    onCheckedChange={handleRichToolDescriptionsChange}
                  />
                </SettingsCard>
              </SettingsSection>

              {/* Tool Icons — shows the command → icon mapping used in turn cards */}
              <SettingsSection
                title={t("settings.appearance.toolIcons")}
                description={t("settings.appearance.toolIconsDesc")}
                action={
                  toolIconsJsonPath ? (
                    <EditPopover
                      trigger={<EditButton />}
                      {...getEditConfig('edit-tool-icons', toolIconsJsonPath)}
                      secondaryAction={{
                        label: t("settings.appearance.editFile"),
                        filePath: toolIconsJsonPath,
                      }}
                    />
                  ) : undefined
                }
              >
                <SettingsCard>
                  <Info_DataTable
                    columns={toolIconColumns}
                    data={toolIcons}
                    searchable={{ placeholder: t("settings.appearance.searchTools") }}
                    maxHeight={480}
                    emptyContent={t("settings.appearance.noToolIcons")}
                  />
                </SettingsCard>
              </SettingsSection>

            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
