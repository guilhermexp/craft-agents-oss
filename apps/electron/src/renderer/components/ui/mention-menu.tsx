import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { FadingText } from '@/components/ui/fading-text'
import { SkillAvatar } from '@/components/ui/skill-avatar'
import { SourceAvatar } from '@/components/ui/source-avatar'
import type { LoadedSkill, LoadedSource, FileSearchResult } from '../../../shared/types'
import { AGENTS_PLUGIN_NAME } from '@craft-agent/shared/skills/types'

// ============================================================================
// Types
// ============================================================================

export type MentionItemType = 'skill' | 'source' | 'file' | 'folder'

export interface MentionItem {
  id: string
  type: MentionItemType
  label: string
  description?: string
  // Type-specific data
  skill?: LoadedSkill
  source?: LoadedSource
  file?: { path: string; type: 'file' | 'directory'; relativePath: string }
}

export interface MentionSection {
  id: string
  label: string
  items: MentionItem[]
}

export interface InlineMentionMenuProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sections: MentionSection[]
  onSelect: (item: MentionItem) => void
  filter?: string
  position: { x: number; y: number }
  workspaceId?: string
  maxWidth?: number
  className?: string
  /** Whether file search is in progress */
  isSearching?: boolean
}

// ============================================================================
// Shared Styles
// ============================================================================

const MENU_CONTAINER_STYLE = 'overflow-hidden rounded-[8px] bg-background text-foreground shadow-modal-small'
const MENU_LIST_STYLE = 'max-h-[240px] overflow-y-auto py-1'
const MENU_ITEM_STYLE = 'flex cursor-pointer select-none items-center gap-3 rounded-[6px] mx-1 px-2 py-1.5 text-[13px]'
const MENU_ITEM_SELECTED = 'bg-foreground/5'
// Type badge shown to the right of each item label (e.g. "Skill", "Source")
const MENU_TYPE_BADGE = 'rounded-[4px] shadow-minimal bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground shrink-0'

// ============================================================================
// Path utilities
// ============================================================================

/** Extract parent directory from a relative path (e.g. "src/components/Button.tsx" → "src/components/") */
function getParentDir(relativePath: string): string {
  const lastSlash = relativePath.lastIndexOf('/')
  if (lastSlash <= 0) return ''
  return relativePath.slice(0, lastSlash + 1)
}

/** Check if query characters appear in order within target.
 *  Returns true if all characters of query are found sequentially in target.
 *  Note: comparison is literal — pass lowercased inputs for case-insensitive matching. */
function subsequenceMatch(target: string, query: string): boolean {
  let qi = 0
  for (let ti = 0; ti < target.length && qi < query.length; ti++) {
    if (target[ti] === query[qi]) qi++
  }
  return qi === query.length
}

/** Filter cached FileSearchResults by query and convert to MentionItems.
 *  Uses substring matching first (score 2), then subsequence matching as
 *  fallback (score 1) so queries like "appav" find "app availability.md". */
function filterCacheResults(cache: FileSearchResult[], query: string): MentionItem[] {
  const lowerQuery = query.trimEnd().toLowerCase()
  if (!lowerQuery) return []

  const scored = cache
    .flatMap(f => {
      const name = f.name.toLowerCase()
      const path = f.relativePath.toLowerCase()
      let score = 0
      if (name.includes(lowerQuery) || path.includes(lowerQuery)) {
        score = 2
      } else if (subsequenceMatch(name, lowerQuery) || subsequenceMatch(path, lowerQuery)) {
        score = 1
      }
      return score > 0 ? [{ f, score }] : []
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)

  return scored.map(({ f }) => ({
    id: f.path,
    type: f.type === 'directory' ? 'folder' as const : 'file' as const,
    label: f.name,
    description: f.relativePath,
    file: { path: f.path, type: f.type, relativePath: f.relativePath },
  }))
}

// ============================================================================
// Filter utilities
// ============================================================================

/**
 * Get match priority score for filtering (higher = better match)
 * 3 = starts with filter (first word)
 * 2 = word boundary match (2nd+ word after space/hyphen/underscore)
 * 1 = contains filter (mid-word)
 * 0 = no match
 */
function getMatchScore(text: string, filter: string): number {
  const lowerText = text.toLowerCase()
  // Best: starts with filter (first word)
  if (lowerText.startsWith(filter)) return 3
  // Good: word boundary match (after space/hyphen/underscore)
  const escapedFilter = filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const wordBoundaryPattern = new RegExp(`[\\s\\-_]${escapedFilter}`)
  if (wordBoundaryPattern.test(lowerText)) return 2
  // OK: contains filter anywhere
  if (lowerText.includes(filter)) return 1
  return 0
}

function filterSections(sections: MentionSection[], filter: string): MentionSection[] {
  if (!filter) return sections
  const lowerFilter = filter.trimEnd().toLowerCase()
  if (!lowerFilter) return sections

  // Collect all matching items across sections
  const allItems = sections.flatMap(section => section.items)
  const matchingItems = allItems.filter(item =>
    item.label?.toLowerCase().includes(lowerFilter) ||
    item.id?.toLowerCase().includes(lowerFilter) ||
    item.description?.toLowerCase().includes(lowerFilter)
  )

  // Sort by match priority: first word > later word > contains
  matchingItems.sort((a, b) => {
    const aLabelScore = getMatchScore(a.label, lowerFilter)
    const bLabelScore = getMatchScore(b.label, lowerFilter)
    const aIdScore = getMatchScore(a.id, lowerFilter)
    const bIdScore = getMatchScore(b.id, lowerFilter)

    // Compare by best score (label or id)
    const aScore = Math.max(aLabelScore, aIdScore)
    const bScore = Math.max(bLabelScore, bIdScore)
    if (aScore !== bScore) return bScore - aScore

    // Same score tier: alphabetical by label
    return a.label.localeCompare(b.label)
  })

  // Return as flat list in a single virtual section (headers hidden when filtering)
  if (matchingItems.length === 0) return []
  return [{ id: 'results', label: 'Results', items: matchingItems }]
}

function flattenItems(sections: MentionSection[]): MentionItem[] {
  return sections.flatMap(section => section.items)
}

/**
 * Check if the @ character at the given position is a valid mention trigger.
 * Valid triggers are:
 * - @ at the start of input (position 0)
 * - @ preceded by whitespace (space, tab, newline)
 * - @ preceded by opening brackets or quotes: ( " '
 *
 * Invalid triggers (returns false):
 * - @ in the middle of a word (e.g., "test@example.com")
 * - @ preceded by alphanumeric or other characters
 *
 * @param textBeforeCursor - The text from start of input to cursor position
 * @param atPosition - The position of the @ character in textBeforeCursor
 * @returns true if this @ should trigger the mention menu
 */
export function isValidMentionTrigger(textBeforeCursor: string, atPosition: number): boolean {
  if (atPosition < 0) return false
  if (atPosition === 0) return true
  const charBefore = textBeforeCursor[atPosition - 1]
  if (charBefore === undefined) return false
  // Allow whitespace or opening brackets/quotes before @
  return /\s/.test(charBefore) || /[("']/.test(charBefore)
}

// ============================================================================
// InlineMentionMenu Component
// ============================================================================

export function InlineMentionMenu({
  open,
  onOpenChange,
  sections,
  onSelect,
  filter = '',
  position,
  workspaceId,
  maxWidth = 280,
  className,
}: InlineMentionMenuProps) {
  const { t } = useTranslation()
  const menuRef = React.useRef<HTMLDivElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  // Track which filter value the selectedIndex was computed for so the index
  // resets to 0 the moment the filter changes — no effect required.
  const [selectionState, setSelectionState] = React.useState<{ forFilter: string; index: number }>({ forFilter: filter, index: 0 })
  const selectedIndex = selectionState.forFilter === filter ? selectionState.index : 0
  const setSelectedIndex = (next: number | ((prev: number) => number)) => {
    setSelectionState(prev => ({
      forFilter: filter,
      index: typeof next === 'function' ? next(prev.forFilter === filter ? prev.index : 0) : next,
    }))
  }
  const filteredSections = filterSections(sections, filter)
  const flatItems = flattenItems(filteredSections)

  // Effect Events keep the latest callbacks without re-subscribing the keyboard/click effects.
  const onSelectEvent = React.useEffectEvent((item: MentionItem) => onSelect(item))
  const onOpenChangeEvent = React.useEffectEvent((next: boolean) => onOpenChange(next))

  // Keyboard navigation
  // Don't attach listener when no items - allows Enter to propagate to input handler
  React.useEffect(() => {
    if (!open || flatItems.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex(prev => (prev < flatItems.length - 1 ? prev + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex(prev => (prev > 0 ? prev - 1 : flatItems.length - 1))
          break
        case 'Enter':
        case 'Tab':
          e.preventDefault()
          if (flatItems[selectedIndex]) {
            onSelectEvent(flatItems[selectedIndex])
            onOpenChangeEvent(false)
          }
          break
        case 'Escape':
          e.preventDefault()
          onOpenChangeEvent(false)
          break
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, flatItems, selectedIndex])

  // Close on click outside
  React.useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onOpenChangeEvent(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  // Scroll selected item into view when navigating with keyboard
  React.useEffect(() => {
    if (!listRef.current) return
    const selectedEl = listRef.current.querySelector('[data-selected="true"]')
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedIndex])

  if (!open) return null

  // Calculate bottom position from window height (menu appears above cursor)
  const bottomPosition = typeof window !== 'undefined'
    ? window.innerHeight - Math.round(position.y) + 8
    : 0

  return (
    <div
      ref={menuRef}
      data-inline-menu
      className={cn('fixed z-dropdown', MENU_CONTAINER_STYLE, className)}
      style={{
        left: Math.round(position.x) - 10,
        bottom: bottomPosition,
        width: maxWidth,
        maxWidth,
      }}
    >
      {/* Menu header — sticky above scroll area */}
      <div className="px-3 py-1.5 text-[12px] font-medium text-muted-foreground border-b border-foreground/5">
        {t('chat.mentionFilesSkillsSources')}
      </div>

      <div ref={listRef} className={MENU_LIST_STYLE}>
        {flatItems.length === 0 && filter && (
          <div className="px-3 py-2 text-[12px] text-muted-foreground/60">{t('chat.noResults')}</div>
        )}
        {flatItems.map((item, itemIndex) => {
          const isSelected = itemIndex === selectedIndex

          return (
            <button
              type="button"
              key={`${item.type}-${item.id}`}
              data-selected={isSelected}
              onClick={() => {
                onSelect(item)
                onOpenChange(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelect(item)
                  onOpenChange(false)
                }
              }}
              onMouseEnter={() => setSelectedIndex(itemIndex)}
              className={cn(
                MENU_ITEM_STYLE,
                isSelected && MENU_ITEM_SELECTED
              )}
            >
              {/* Icon based on type */}
              <div className="shrink-0">
                {item.type === 'skill' && item.skill && (
                  <SkillAvatar skill={item.skill} size="sm" workspaceId={workspaceId} />
                )}
                {item.type === 'source' && item.source && (
                  <SourceAvatar source={item.source} size="sm" />
                )}
                {item.type === 'folder' && (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" className="text-muted-foreground">
                    <path d="M20.5 10C20.5 9.07 20.5 8.61 20.4 8.22C20.12 7.19 19.31 6.38 18.28 6.1C17.9 6 17.43 6 16.5 6H13.1C12.47 6 12.16 6 11.87 5.91C11.68 5.85 11.5 5.77 11.34 5.65C11.09 5.48 10.89 5.24 10.5 4.75L10.41 4.64C10.11 4.26 9.96 4.07 9.77 3.93C9.54 3.75 9.28 3.62 9 3.55C8.77 3.5 8.53 3.5 8.04 3.5C6.6 3.5 5.89 3.5 5.32 3.74C4.61 4.05 4.05 4.61 3.74 5.32C3.5 5.89 3.5 6.6 3.5 8.04V10M9.47 20.5H14.54C16.91 20.5 18.1 20.5 18.93 19.81C19.76 19.12 19.98 17.96 20.43 15.62L20.82 13.56C21.14 11.91 21.29 11.09 20.84 10.54C20.39 10 19.55 10 17.87 10H6.13C4.45 10 3.61 10 3.16 10.54C2.71 11.09 2.86 11.91 3.18 13.56L3.57 15.62C4.02 17.96 4.24 19.12 5.07 19.81C5.9 20.5 7.09 20.5 9.47 20.5Z"/>
                  </svg>
                )}
                {item.type === 'file' && (
                  <FileMenuIcon name={item.label} />
                )}
              </div>

              {/* Label and optional path/badge */}
              {(item.type === 'file' || item.type === 'folder') ? (
                <>
                  {/* File/folder: filename then parent path fading out on overflow */}
                  <span className="shrink-0">{item.label}</span>
                  {item.file?.relativePath && getParentDir(item.file.relativePath) && (
                    <FadingText className="text-[11px] text-muted-foreground min-w-0 opacity-50" fadeWidth={20}>
                      {getParentDir(item.file.relativePath)}
                    </FadingText>
                  )}
                </>
              ) : (
                <>
                  {/* Skill/source: label with type badge */}
                  <div className="flex-1 min-w-0">
                    <span className="truncate block">{item.label}</span>
                  </div>
                  <span className={MENU_TYPE_BADGE}>
                    {item.type === 'skill' ? t('common.skill') : t('common.source')}
                  </span>
                </>
              )}
            </button>
          )
        })}

      </div>
    </div>
  )
}

// ============================================================================
// File icon component - picks icon variant based on file extension
// ============================================================================

/** Known code file extensions that get the code file icon (< >) */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'java', 'rb', 'swift', 'kt',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less', 'html', 'vue', 'svelte',
  'json', 'yaml', 'yml', 'toml', 'xml',
  'sh', 'bash', 'zsh', 'fish',
  'md', 'mdx',
  'sql', 'graphql', 'proto',
])

/** Known image file extensions that get the image icon */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif',
])

function getFileIconType(name: string): 'code' | 'image' | 'generic' {
  const ext = name.split('.').pop()?.toLowerCase()
  if (!ext) return 'generic'
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  return 'generic'
}

/** Renders the appropriate file icon based on extension (code, image, or generic) */
function FileMenuIcon({ name }: { name: string }) {
  const iconType = getFileIconType(name)

  if (iconType === 'code') {
    // Code file icon (document with < > brackets)
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
        <path d="M10.5 2.5C12.16 2.5 13.5 3.84 13.5 5.5V6.1C13.5 6.47 13.5 6.66 13.52 6.81C13.66 7.67 14.33 8.34 15.19 8.48C15.34 8.5 15.53 8.5 15.9 8.5H16.5C18.16 8.5 19.5 9.84 19.5 11.5M10.5 12.88C9.7 13.3 9.11 13.83 8.64 14.55C8.51 14.75 8.44 14.85 8.44 15C8.44 15.15 8.51 15.25 8.64 15.45C9.11 16.17 9.7 16.7 10.5 17.12M13.5 12.88C14.3 13.3 14.89 13.83 15.36 14.55C15.49 14.75 15.56 14.85 15.56 15C15.56 15.15 15.49 15.25 15.36 15.45C14.89 16.17 14.3 16.7 13.5 17.12M10.96 2.5H10.67C8.65 2.5 7.64 2.5 6.85 2.86C5.97 3.26 5.26 3.97 4.86 4.85C4.5 5.64 4.5 6.65 4.5 8.67V14C4.5 17.29 4.5 18.93 5.41 20.04C5.57 20.24 5.76 20.43 5.96 20.59C7.07 21.5 8.71 21.5 12 21.5C15.29 21.5 16.93 21.5 18.04 20.59C18.24 20.43 18.43 20.24 18.59 20.04C19.5 18.93 19.5 17.29 19.5 14V11.04C19.5 10 19.5 9.49 19.42 9C19.27 8.1 18.91 7.24 18.39 6.5C18.1 6.1 17.73 5.73 17 5C16.27 4.27 15.9 3.9 15.5 3.61C14.76 3.09 13.9 2.73 13.01 2.58C12.51 2.5 12 2.5 10.96 2.5Z"/>
      </svg>
    )
  }

  if (iconType === 'image') {
    // Image file icon (landscape frame with mountain/sun)
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
        <path d="M8 8.5C8 8.78 7.78 9 7.5 9C7.22 9 7 8.78 7 8.5C7 8.22 7.22 8 7.5 8C7.78 8 8 8.22 8 8.5Z" fill="currentColor"/>
        <path d="M21 16.1L17.95 13.05C16.62 11.72 15.95 11.05 15.12 11.05C14.29 11.05 13.63 11.72 12.29 13.05L5.34 20M8 8.5C8 8.78 7.78 9 7.5 9C7.22 9 7 8.78 7 8.5C7 8.22 7.22 8 7.5 8C7.78 8 8 8.22 8 8.5ZM10.5 20.5H13.5C17.27 20.5 19.16 20.5 20.33 19.33C21.5 18.16 21.5 16.27 21.5 12.5V11.5C21.5 7.73 21.5 5.84 20.33 4.67C19.16 3.5 17.27 3.5 13.5 3.5H10.5C6.73 3.5 4.84 3.5 3.67 4.67C2.5 5.84 2.5 7.73 2.5 11.5V12.5C2.5 16.27 2.5 18.16 3.67 19.33C4.84 20.5 6.73 20.5 10.5 20.5Z"/>
      </svg>
    )
  }

  // Generic file icon (document with folded corner)
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground">
      <path d="M10.5 2.5C12.16 2.5 13.5 3.84 13.5 5.5V6.1C13.5 6.47 13.5 6.66 13.52 6.81C13.66 7.67 14.33 8.34 15.19 8.48C15.34 8.5 15.53 8.5 15.9 8.5H16.5C18.16 8.5 19.5 9.84 19.5 11.5M9 16H15M9 12H10M10.96 2.5H10.67C8.65 2.5 7.64 2.5 6.85 2.86C5.97 3.26 5.26 3.97 4.86 4.85C4.5 5.64 4.5 6.65 4.5 8.67V14C4.5 17.29 4.5 18.93 5.41 20.04C5.57 20.24 5.76 20.43 5.96 20.59C7.07 21.5 8.71 21.5 12 21.5C15.29 21.5 16.93 21.5 18.04 20.59C18.24 20.43 18.43 20.24 18.59 20.04C19.5 18.93 19.5 17.29 19.5 14V11.04C19.5 10 19.5 9.49 19.42 9C19.27 8.1 18.91 7.24 18.39 6.5C18.1 6.1 17.73 5.73 17 5C16.27 4.27 15.9 3.9 15.5 3.61C14.76 3.09 13.9 2.73 13.01 2.58C12.51 2.5 12 2.5 10.96 2.5Z"/>
    </svg>
  )
}

// ============================================================================
// Hook for managing inline mention state
// ============================================================================

/** Interface for elements that can be used with useInlineMention */
export interface MentionInputElement {
  getBoundingClientRect: () => DOMRect
  getCaretRect?: () => DOMRect | null
  value: string
  selectionStart: number
}

export interface UseInlineMentionOptions {
  /** Ref to input element (textarea or RichTextInput handle) */
  inputRef: React.RefObject<MentionInputElement | null>
  skills: LoadedSkill[]
  sources: LoadedSource[]
  /** Base path for file search (working directory) */
  basePath?: string
  onSelect: (item: MentionItem) => void
  /** Workspace ID for fully-qualified skill names */
  workspaceId?: string
}

export interface UseInlineMentionReturn {
  isOpen: boolean
  filter: string
  position: { x: number; y: number }
  sections: MentionSection[]
  /** Whether file search is in progress */
  isSearching: boolean
  handleInputChange: (value: string, cursorPosition: number) => void
  close: () => void
  handleSelect: (item: MentionItem) => { value: string; cursorPosition: number }
}

export function useInlineMention({
  inputRef,
  skills,
  sources,
  basePath,
  onSelect,
  workspaceId,
}: UseInlineMentionOptions): UseInlineMentionReturn {
  const [isOpen, setIsOpen] = React.useState(false)
  const [filter, setFilter] = React.useState('')
  // committedFilter: only updates when IPC returns (or immediately when no IPC needed).
  // Prevents visual jumps — the menu shows all items until results are ready,
  // then applies filter + file results in a single frame.
  const [committedFilter, setCommittedFilter] = React.useState('')
  const [position, setPosition] = React.useState({ x: 0, y: 0 })
  const [atStart, setAtStart] = React.useState(-1)
  const [fileResults, setFileResults] = React.useState<MentionItem[]>([])
  const fileSearchTimeout = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cache of raw IPC file search results for the current menu session.
  // Allows instant client-side filtering when user edits the query (add/delete chars)
  // without waiting for a new IPC round-trip. Cleared when menu closes.
  const fileCache = React.useRef<FileSearchResult[]>([])
  // Store current input state for handleSelect
  const currentInputRef = React.useRef({ value: '', cursorPosition: 0 })

  // Cleanup pending timeout on unmount
  React.useEffect(() => {
    return () => {
      if (fileSearchTimeout.current) {
        clearTimeout(fileSearchTimeout.current)
      }
    }
  }, [])

  // Build sections from available data (skills, sources, and file search results)
  const sections = React.useMemo((): MentionSection[] => {
    const result: MentionSection[] = []

    // Skills section
    if (skills.length > 0) {
      result.push({
        id: 'skills',
        label: 'Skills',
        items: skills.map(skill => ({
          id: skill.slug,
          type: 'skill' as const,
          label: skill.metadata.name,
          description: skill.metadata.description,
          skill,
        })),
      })
    }

    // Sources section
    if (sources.length > 0) {
      result.push({
        id: 'sources',
        label: 'Sources',
        items: sources.flatMap(source =>
          source.config.slug && source.config.name
            ? [{
                id: source.config.slug,
                type: 'source' as const,
                label: source.config.name,
                description: source.config.tagline,
                source,
              }]
            : []
        ),
      })
    }

    // Files section (from async search results)
    if (fileResults.length > 0) {
      result.push({
        id: 'files',
        label: 'Files',
        items: fileResults,
      })
    }

    return result
  }, [skills, sources, fileResults])

  const handleInputChange = React.useCallback((value: string, cursorPosition: number) => {
    // Store current state for handleSelect
    currentInputRef.current = { value, cursorPosition }

    const textBeforeCursor = value.slice(0, cursorPosition)
    // Match @ followed by up to 100 chars (word chars, hyphens, slashes, dots, and spaces).
    // Spaces are allowed so users can type filenames with spaces (e.g. @app availability.md).
    // The menu auto-closes when a space produces no matches (Slack-style behavior).
    const atMatch = textBeforeCursor.match(/@([\w\-\/.\s]{0,100})?$/)

    // Check if this is a valid @ mention trigger
    const matchStart = atMatch ? textBeforeCursor.lastIndexOf('@') : -1
    const isValidTrigger = atMatch && isValidMentionTrigger(textBeforeCursor, matchStart)

    if (isValidTrigger) {
      const filterText = atMatch[1] || ''

      // Slack-style auto-close: if the query contains a space and the file cache is
      // populated but produces zero matches, close the menu. This prevents the
      // "infinite spaces" problem while still allowing multi-word queries like
      // "app availability.md". Skills/sources rarely have spaces in names, so
      // file cache is the authoritative signal here.
      if (filterText.includes(' ') && fileCache.current.length > 0) {
        const fileMatches = filterCacheResults(fileCache.current, filterText)
        if (fileMatches.length === 0) {
          setIsOpen(false)
          setFilter('')
          setCommittedFilter('')
          setAtStart(-1)
          if (fileSearchTimeout.current) {
            clearTimeout(fileSearchTimeout.current)
            fileSearchTimeout.current = null
          }
          setFileResults([])
          fileCache.current = []
          return
        }
      }

      setAtStart(matchStart)
      setFilter(filterText)

      // Cache-first file search: if cache has entries from a previous IPC call,
      // filter client-side instantly (no IPC, no debounce). Otherwise fire a
      // debounced IPC to populate the cache. Cache clears when menu closes.
      window.electronAPI.debugLog('[mention] filterText:', filterText, 'basePath:', basePath, 'cacheSize:', fileCache.current.length)
      if (basePath && filterText.length >= 1) {
        if (fileCache.current.length > 0) {
          // Cache exists — filter client-side instantly, no IPC needed
          if (fileSearchTimeout.current) {
            clearTimeout(fileSearchTimeout.current)
            fileSearchTimeout.current = null
          }
          const filtered = filterCacheResults(fileCache.current, filterText)
          window.electronAPI.debugLog('[mention] cache hit:', filtered.length, 'items')
          setFileResults(filtered)
          setCommittedFilter(filterText)
        } else {
          // First search — fire debounced IPC to populate cache
          if (fileSearchTimeout.current) clearTimeout(fileSearchTimeout.current)

          fileSearchTimeout.current = setTimeout(async () => {
            try {
              window.electronAPI.debugLog('[mention] calling IPC searchFiles:', basePath, filterText)
              const results = await window.electronAPI.searchFiles(basePath, filterText)
              window.electronAPI.debugLog('[mention] IPC returned:', results?.length, 'results')
              fileCache.current = results
              const filtered = filterCacheResults(fileCache.current, filterText)
              window.electronAPI.debugLog('[mention] after cache filter:', filtered.length, 'items')
              setFileResults(filtered)
              setCommittedFilter(filterText)
            } catch (err) {
              window.electronAPI.debugLog('[mention] IPC searchFiles error:', String(err))
            }
          }, 150)
        }
      } else {
        window.electronAPI.debugLog('[mention] skipping file search (no basePath or empty filter)')
        if (fileSearchTimeout.current) {
          clearTimeout(fileSearchTimeout.current)
          fileSearchTimeout.current = null
        }
        setFileResults([])
        setCommittedFilter(filterText)
      }

      if (inputRef.current) {
        // Try to get actual caret position from the input element
        const caretRect = inputRef.current.getCaretRect?.()

        if (caretRect && caretRect.x > 0) {
          // Use actual caret position
          setPosition({
            x: caretRect.x,
            y: caretRect.y,
          })
        } else {
          // Fallback: position at input element's left edge
          const rect = inputRef.current.getBoundingClientRect()
          const lineHeight = 20
          const linesBeforeCursor = textBeforeCursor.split('\n').length - 1
          setPosition({
            x: rect.left,
            y: rect.top + (linesBeforeCursor + 1) * lineHeight,
          })
        }
      }

      setIsOpen(true)
    } else {
      setIsOpen(false)
      setFilter('')
      setCommittedFilter('')
      setAtStart(-1)
      // Clear file search state and cache when menu closes
      if (fileSearchTimeout.current) {
        clearTimeout(fileSearchTimeout.current)
        fileSearchTimeout.current = null
      }
      setFileResults([])
      fileCache.current = []
    }
  }, [inputRef, basePath])

  const handleSelect = React.useCallback((item: MentionItem): { value: string; cursorPosition: number } => {
    let result = ''
    let newCursorPosition = 0

    if (atStart >= 0) {
      const { value: currentValue, cursorPosition } = currentInputRef.current
      const before = currentValue.slice(0, atStart)
      const after = currentValue.slice(cursorPosition)

      const buildMentionText = (kind: 'skill' | 'source' | 'file' | 'folder', value: string): string =>
        '[' + kind + ':' + value + '] '

      // Build the mention text based on type using bracket syntax.
      // Skills use fully-qualified names (workspaceId:slug) because the SDK's
      // Skill tool requires this format to resolve workspace-scoped skills.
      let mentionText: string
      if (item.type === 'skill') {
        // Plugin name depends on which tier the skill came from:
        //   workspace → workspaceId, project/global → ".agents"
        const pluginName = item.skill?.source === 'workspace' ? workspaceId : AGENTS_PLUGIN_NAME
        const qualifiedName = pluginName ? `${pluginName}:${item.id}` : item.id
        mentionText = buildMentionText('skill', qualifiedName)
      } else if (item.type === 'source') {
        mentionText = buildMentionText('source', item.id)
      } else if (item.type === 'file') {
        // Use relative path for file mentions
        mentionText = buildMentionText('file', item.file?.relativePath || item.id)
      } else if (item.type === 'folder') {
        mentionText = buildMentionText('folder', item.file?.relativePath || item.id)
      } else {
        mentionText = buildMentionText('skill', item.id)
      }

      result = before + mentionText + after
      newCursorPosition = before.length + mentionText.length
    }

    onSelect(item)
    setIsOpen(false)
    setCommittedFilter('')
    // Clear file search state and cache to prevent stale results on next open
    if (fileSearchTimeout.current) {
      clearTimeout(fileSearchTimeout.current)
      fileSearchTimeout.current = null
    }
    setFileResults([])
    fileCache.current = []

    return { value: result, cursorPosition: newCursorPosition }
  }, [onSelect, atStart, workspaceId])

  const close = React.useCallback(() => {
    setIsOpen(false)
    setFilter('')
    setCommittedFilter('')
    setAtStart(-1)
    // Clear file search state and cache to prevent stale results on next open
    if (fileSearchTimeout.current) {
      clearTimeout(fileSearchTimeout.current)
      fileSearchTimeout.current = null
    }
    setFileResults([])
    fileCache.current = []
  }, [])

  return {
    isOpen,
    filter: committedFilter,
    position,
    sections,
    isSearching: false,
    handleInputChange,
    close,
    handleSelect,
  }
}
