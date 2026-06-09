import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as ReactDOM from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * AcceptPlanDropdown - Dropdown for accepting plans with or without compaction
 *
 * Provides two options:
 * 1. Accept - Execute the plan immediately
 * 2. Accept & Compact - Summarize conversation first, then execute
 *
 * The compact option is useful when context is running low after a long planning session.
 */

interface AcceptPlanDropdownProps {
  /** Callback when user selects "Accept" (execute immediately) */
  onAccept: () => void
  /** Callback when user selects "Accept & Compact" (compact first, then execute) */
  onAcceptWithCompact: () => void
  /** Trigger label */
  acceptLabel?: string
  /** Primary dropdown option label */
  acceptOptionLabel?: string
  /** Additional className for the trigger button */
  className?: string
}

export function AcceptPlanDropdown({
  onAccept,
  onAcceptWithCompact,
  acceptLabel,
  acceptOptionLabel,
  className,
}: AcceptPlanDropdownProps) {
  const { t } = useTranslation()
  const effectiveAcceptLabel = acceptLabel ?? t('plan.acceptPlan')
  const effectiveAcceptOptionLabel = acceptOptionLabel ?? t('plan.accept')
  const [isOpen, setIsOpen] = useState(false)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()

    if (!isOpen) {
      // Calculate position before opening
      if (triggerRef.current) {
        const rect = triggerRef.current.getBoundingClientRect()
        const menuWidth = 280
        const menuHeight = 120
        const gap = 4
        // Prefer below, fall back to above if no space
        const spaceBelow = window.innerHeight - rect.bottom
        const top = spaceBelow >= menuHeight + gap
          ? rect.bottom + gap
          : rect.top - menuHeight - gap
        let left = rect.right - menuWidth
        if (left < 8) left = 8
        if (left + menuWidth > window.innerWidth - 8) {
          left = window.innerWidth - menuWidth - 8
        }
        setPosition({ top, left })
      }
    }
    setIsOpen(prev => !prev)
  }, [isOpen])

  const handleClose = useCallback(() => {
    setIsOpen(false)
  }, [])

  // Handle option selection
  const handleSelectAccept = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    handleClose()
    onAccept()
  }, [handleClose, onAccept])

  const handleSelectCompact = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    handleClose()
    onAcceptWithCompact()
  }, [handleClose, onAcceptWithCompact])

  // Click outside detection
  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        handleClose()
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)

    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [isOpen, handleClose])

  return (
    <>
      {/* Trigger button - matches existing Accept Plan button styling */}
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        className={cn(
          "h-[28px] pl-2.5 pr-2 text-xs font-medium rounded-[6px] flex items-center gap-1.5 transition-all",
          "bg-success/5 text-success hover:bg-success/10 shadow-tinted",
          className
        )}
        style={{ '--shadow-color': '34, 136, 82' } as React.CSSProperties}
      >
        <svg className="size-3.5" viewBox="0 0 25 24" fill="currentColor">
          <path fillRule="nonzero" d="M13.72,22.65 C13.26,22.65 12.94,22.49 12.73,22.16 C12.53,21.84 12.36,21.43 12.22,20.94 L10.66,15.79 C10.57,15.46 10.54,15.2 10.57,15 C10.59,14.8 10.7,14.6 10.89,14.4 L20.86,3.65 C20.92,3.59 20.95,3.52 20.95,3.45 C20.95,3.38 20.92,3.32 20.87,3.28 C20.82,3.23 20.76,3.21 20.69,3.2 C20.62,3.2 20.56,3.23 20.5,3.29 L9.79,13.3 C9.57,13.49 9.36,13.6 9.16,13.62 C8.96,13.65 8.7,13.61 8.39,13.51 L3.12,11.91 C2.65,11.77 2.26,11.6 1.95,11.4 C1.65,11.2 1.49,10.88 1.49,10.43 C1.49,10.07 1.63,9.77 1.91,9.52 C2.19,9.26 2.54,9.06 2.95,8.9 L19.75,2.47 C19.97,2.38 20.19,2.32 20.39,2.27 C20.58,2.22 20.76,2.19 20.93,2.19 C21.25,2.19 21.5,2.28 21.68,2.47 C21.86,2.65 21.95,2.9 21.95,3.22 C21.95,3.39 21.93,3.57 21.88,3.77 C21.83,3.96 21.76,4.17 21.68,4.4 L15.28,21.11 C15.1,21.58 14.88,21.95 14.63,22.23 C14.38,22.51 14.07,22.65 13.72,22.65 Z" />
        </svg>
        <span>{effectiveAcceptLabel}</span>
        <ChevronDown className={cn(
          "size-3 transition-transform duration-150",
          isOpen && "rotate-180"
        )} />
      </button>

      {/* Dropdown menu - rendered via portal */}
      {isOpen && position && ReactDOM.createPortal(
        <div
          ref={menuRef}
          className={cn(
            "fixed z-50 min-w-[280px] p-1.5",
            "bg-background rounded-[8px] shadow-strong border border-border/50",
            "animate-in fade-in-0 zoom-in-95 duration-100"
          )}
          style={{ top: position.top, left: position.left }}
        >
          {/* Option 1: Accept (execute immediately) */}
          <button
            type="button"
            onClick={handleSelectAccept}
            className={cn(
              "flex flex-col w-full px-3 py-2 text-left rounded-[6px]",
              "hover:bg-foreground/[0.05] focus:bg-foreground/[0.05] focus:outline-none",
              "transition-colors"
            )}
          >
            <span className="text-[13px] font-medium">{effectiveAcceptOptionLabel}</span>
            <span className="text-xs text-muted-foreground">
              {t('plan.executeImmediately')}
            </span>
          </button>

          {/* Option 2: Accept & Compact */}
          <button
            type="button"
            onClick={handleSelectCompact}
            className={cn(
              "flex flex-col w-full px-3 py-2 text-left rounded-[6px]",
              "hover:bg-foreground/[0.05] focus:bg-foreground/[0.05] focus:outline-none",
              "transition-colors"
            )}
          >
            <span className="text-[13px] font-medium">{t('plan.acceptAndCompact')}</span>
            <span className="text-xs text-muted-foreground">
              {t('plan.worksForComplex')}
            </span>
          </button>
        </div>,
        document.body
      )}
    </>
  )
}
