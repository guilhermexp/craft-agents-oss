import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '../ui/StyledDropdown'

/**
 * AcceptPlanDropdown — Accept-Plan trigger with two options.
 *
 * Uses Radix `DropdownMenu` so positioning is handled by Floating UI (correct
 * under `@container/*` ancestors, transformed parents, and inside scroll
 * containers — issues that bit a previous hand-rolled `position: fixed` portal
 * in WebUI mobile / auto-compact).
 *
 * Options:
 *  - "Accept" — execute the plan immediately
 *  - "Accept & Compact" — summarize conversation first, then execute (useful
 *    when context is running low after a long planning session)
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "group/accept h-[28px] pl-2.5 pr-2 text-xs font-medium rounded-[6px] flex items-center gap-1.5 transition-all",
            "bg-success/5 text-success hover:bg-success/10 shadow-tinted",
            className
          )}
          style={{ '--shadow-color': '34, 136, 82' } as React.CSSProperties}
        >
        <svg className="size-3.5" viewBox="0 0 25 24" fill="currentColor">
          <path fillRule="nonzero" d="M13.72,22.65 C13.26,22.65 12.94,22.49 12.73,22.16 C12.53,21.84 12.36,21.43 12.22,20.94 L10.66,15.79 C10.57,15.46 10.54,15.2 10.57,15 C10.59,14.8 10.7,14.6 10.89,14.4 L20.86,3.65 C20.92,3.59 20.95,3.52 20.95,3.45 C20.95,3.38 20.92,3.32 20.87,3.28 C20.82,3.23 20.76,3.21 20.69,3.2 C20.62,3.2 20.56,3.23 20.5,3.29 L9.79,13.3 C9.57,13.49 9.36,13.6 9.16,13.62 C8.96,13.65 8.7,13.61 8.39,13.51 L3.12,11.91 C2.65,11.77 2.26,11.6 1.95,11.4 C1.65,11.2 1.49,10.88 1.49,10.43 C1.49,10.07 1.63,9.77 1.91,9.52 C2.19,9.26 2.54,9.06 2.95,8.9 L19.75,2.47 C19.97,2.38 20.19,2.32 20.39,2.27 C20.58,2.22 20.76,2.19 20.93,2.19 C21.25,2.19 21.5,2.28 21.68,2.47 C21.86,2.65 21.95,2.9 21.95,3.22 C21.95,3.39 21.93,3.57 21.88,3.77 C21.83,3.96 21.76,4.17 21.68,4.4 L15.28,21.11 C15.1,21.58 14.88,21.95 14.63,22.23 C14.38,22.51 14.07,22.65 13.72,22.65 Z" />
        </svg>
        <span>{effectiveAcceptLabel}</span>
          <ChevronDown className="size-3 transition-transform duration-150 group-data-[state=open]/accept:rotate-180" />
        </button>
      </DropdownMenuTrigger>

      <StyledDropdownMenuContent align="end" minWidth="min-w-64" sideOffset={6}>
        <StyledDropdownMenuItem onSelect={() => onAccept()} className="items-start py-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] leading-tight">{effectiveAcceptOptionLabel}</span>
            <span className="max-w-[220px] whitespace-normal text-xs leading-tight text-muted-foreground">
              {t('plan.executeImmediately')}
            </span>
          </div>
        </StyledDropdownMenuItem>

        <StyledDropdownMenuItem onSelect={() => onAcceptWithCompact()} className="items-start py-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] leading-tight">{t('plan.acceptAndCompact')}</span>
            <span className="max-w-[220px] whitespace-normal text-xs leading-tight text-muted-foreground">
              {t('plan.worksForComplex')}
            </span>
          </div>
        </StyledDropdownMenuItem>
      </StyledDropdownMenuContent>
    </DropdownMenu>
  )
}
