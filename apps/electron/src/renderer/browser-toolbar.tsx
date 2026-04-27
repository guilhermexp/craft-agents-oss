/**
 * Browser Toolbar — React entry point
 *
 * Renders the shared BrowserControls component inside a chromeless
 * BrowserWindow. Communicates with the main process via a dedicated
 * preload script (browser-toolbar preload).
 */

import React, { useState, useEffect, useCallback, useRef } from 'react'
import ReactDOM from 'react-dom/client'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { EyeOff, X, XCircle } from 'lucide-react'
import { BrowserControls } from '@craft-agent/ui'
import { setupI18n } from '@craft-agent/shared/i18n'
import { HeaderIconButton } from '@/components/ui/HeaderIconButton'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import './index.css'

// Initialize i18n before any React rendering — this entry runs in its own
// renderer (BrowserView) and does not share state with the main app shell.
setupI18n([LanguageDetector, initReactI18next])

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ToolbarProfile {
  id: string
  name: string
  color: string
}

interface ToolbarState {
  url: string
  title: string
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  themeColor?: string | null
  profile?: ToolbarProfile | null
  availableProfiles?: ToolbarProfile[]
}

declare global {
  interface Window {
    browserToolbar: {
      instanceId: string
      navigate: (url: string) => Promise<void>
      goBack: () => Promise<void>
      goForward: () => Promise<void>
      reload: () => Promise<void>
      stop: () => Promise<void>
      setMenuGeometry: (open: boolean, height?: number) => Promise<void>
      hideWindow: () => Promise<void>
      closeWindowEntirely: () => Promise<void>
      requestProfileManagement: () => Promise<void>
      switchProfile: (profileId: string) => Promise<string | null>
      onStateUpdate: (callback: (state: ToolbarState) => void) => () => void
      onThemeColor: (callback: (color: string | null) => void) => () => void
      onForceCloseMenu: (callback: (payload: { reason?: string }) => void) => () => void
    }
  }
}

/* ------------------------------------------------------------------ */
/*  App                                                                */
/* ------------------------------------------------------------------ */

function BrowserToolbarApp() {
  const [state, setState] = useState<ToolbarState>({
    url: 'about:blank',
    title: 'New Tab',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
  })
  const [themeColor, setThemeColor] = useState<string | null>(null)
  const [windowMenuOpen, setWindowMenuOpen] = useState(false)
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const menuContentRef = useRef<HTMLDivElement | null>(null)
  const profileMenuContentRef = useRef<HTMLDivElement | null>(null)
  const anyMenuOpen = windowMenuOpen || profileMenuOpen

  const api = window.browserToolbar

  useEffect(() => {
    if (!api) return
    return api.onStateUpdate((s) => {
      setState(s)
      // Sync theme color from full state push (initial load / reconnection)
      if ('themeColor' in s) {
        setThemeColor((s as ToolbarState).themeColor ?? null)
      }
    })
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onThemeColor(setThemeColor)
  }, [api])

  useEffect(() => {
    if (!api) return
    return api.onForceCloseMenu(() => {
      setWindowMenuOpen(false)
      setProfileMenuOpen(false)
    })
  }, [api])

  useEffect(() => {
    if (!api) return

    if (!anyMenuOpen) {
      void api.setMenuGeometry(false, 0)
      return
    }

    // Prime expansion immediately to avoid a constrained first measurement.
    void api.setMenuGeometry(true, 120)

    const activeRef = windowMenuOpen ? menuContentRef : profileMenuContentRef
    const sendGeometry = () => {
      const height = Math.ceil(activeRef.current?.getBoundingClientRect().height ?? 0)
      void api.setMenuGeometry(true, height)
    }

    let frame = requestAnimationFrame(sendGeometry)
    const observer = new ResizeObserver(() => {
      sendGeometry()
    })

    if (activeRef.current) {
      observer.observe(activeRef.current)
    }

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      void api.setMenuGeometry(false, 0)
    }
  }, [api, anyMenuOpen, windowMenuOpen])

  const handleNavigate = useCallback((url: string) => {
    void api?.navigate(url)
  }, [api])

  const handleGoBack = useCallback(() => {
    void api?.goBack()
  }, [api])

  const handleGoForward = useCallback(() => {
    void api?.goForward()
  }, [api])

  const handleReload = useCallback(() => {
    void api?.reload()
  }, [api])

  const handleStop = useCallback(() => {
    void api?.stop()
  }, [api])

  const handleHideWindow = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.hideWindow()
  }, [api])

  const handleCloseWindowEntirely = useCallback(() => {
    setWindowMenuOpen(false)
    void api?.closeWindowEntirely()
  }, [api])

  return (
    <>
      {/*
        Full-window outside-tap catcher while any menu is open.
        Critical for draggable titlebar windows (Windows) where outside-click
        dismissal can be unreliable if events fall into app-region: drag zones.
      */}
      {anyMenuOpen && (
        <div
          className="fixed inset-0 z-[90] titlebar-no-drag bg-black/[0.0039215686]"
          onPointerDown={(event) => {
            event.preventDefault()
            setWindowMenuOpen(false)
            setProfileMenuOpen(false)
          }}
        />
      )}

      <BrowserControls
        url={state.url}
        loading={state.isLoading}
        canGoBack={state.canGoBack}
        canGoForward={state.canGoForward}
        onNavigate={handleNavigate}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onReload={handleReload}
        onStop={handleStop}
        trailingContent={(
          <div className="ml-2 flex items-center gap-1.5 titlebar-no-drag">
            {state.profile && (
              <ProfileMenu
                current={state.profile}
                profiles={state.availableProfiles ?? [state.profile]}
                open={profileMenuOpen}
                onOpenChange={setProfileMenuOpen}
                contentRef={profileMenuContentRef}
                onSwitch={(id) => {
                  setProfileMenuOpen(false)
                  void api?.switchProfile(id)
                }}
                onManage={() => {
                  setProfileMenuOpen(false)
                  void api?.requestProfileManagement()
                }}
              />
            )}
            <DropdownMenu open={windowMenuOpen} onOpenChange={setWindowMenuOpen}>
              <DropdownMenuTrigger asChild>
                <HeaderIconButton
                  icon={<X className="h-3.5 w-3.5" />}
                  aria-label="Browser window options"
                  className={themeColor ? '' : 'bg-background shadow-minimal hover:bg-foreground/5'}
                  style={themeColor ? { color: 'var(--tb-fg)' } : undefined}
                />
              </DropdownMenuTrigger>

              <StyledDropdownMenuContent
                ref={menuContentRef}
                align="end"
                side="bottom"
                sideOffset={6}
                minWidth="min-w-44"
                className="titlebar-no-drag z-[110] max-h-none overflow-visible"
              >
                <StyledDropdownMenuItem onSelect={handleHideWindow}>
                  <EyeOff className="h-3.5 w-3.5" />
                  Hide Window
                </StyledDropdownMenuItem>
                <StyledDropdownMenuItem variant="destructive" onSelect={handleCloseWindowEntirely}>
                  <XCircle className="h-3.5 w-3.5" />
                  Close Window Entirely
                </StyledDropdownMenuItem>
              </StyledDropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        themeColor={themeColor}
        urlBarClassName="max-w-[600px]"
        className="titlebar-drag-region bg-background"
      />
    </>
  )
}

interface ProfileMenuProps {
  current: ToolbarProfile
  profiles: ToolbarProfile[]
  open: boolean
  onOpenChange: (open: boolean) => void
  contentRef: React.MutableRefObject<HTMLDivElement | null>
  onSwitch: (id: string) => void
  onManage: () => void
}

function ProfileMenu({
  current,
  profiles,
  open,
  onOpenChange,
  contentRef,
  onSwitch,
  onManage,
}: ProfileMenuProps) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Perfil: ${current.name}`}
          title={`Perfil: ${current.name}`}
          className="size-6 rounded-full flex items-center justify-center text-white text-[10px] font-semibold transition hover:ring-2 hover:ring-foreground/30"
          style={{ backgroundColor: current.color }}
        >
          {(current.name?.trim().charAt(0) || '?').toUpperCase()}
        </button>
      </DropdownMenuTrigger>
      <StyledDropdownMenuContent
        ref={contentRef}
        align="end"
        side="bottom"
        sideOffset={6}
        minWidth="min-w-44"
        className="titlebar-no-drag z-[110] max-h-none overflow-visible"
      >
        {profiles.map((p) => (
          <StyledDropdownMenuItem
            key={p.id}
            onSelect={() => {
              if (p.id !== current.id) onSwitch(p.id)
            }}
          >
            <div
              className="size-4 rounded-full flex items-center justify-center text-white text-[8px] font-semibold"
              style={{ backgroundColor: p.color }}
            >
              {(p.name?.trim().charAt(0) || '?').toUpperCase()}
            </div>
            <span className={p.id === current.id ? 'font-semibold' : undefined}>
              {p.name}
              {p.id === current.id ? ' ✓' : ''}
            </span>
          </StyledDropdownMenuItem>
        ))}
        <StyledDropdownMenuItem onSelect={onManage}>
          Gerenciar perfis…
        </StyledDropdownMenuItem>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}

/* ------------------------------------------------------------------ */
/*  Mount                                                              */
/* ------------------------------------------------------------------ */

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserToolbarApp />
  </React.StrictMode>,
)
