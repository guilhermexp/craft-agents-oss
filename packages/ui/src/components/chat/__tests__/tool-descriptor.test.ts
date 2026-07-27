/**
 * Unit tests for tool classification and display helpers.
 *
 * Verifies getToolDescriptor() classification flags/icons, getToolDisplayName()
 * prefix stripping and friendly names, computeEditWriteDiffStats() diff math,
 * and stripMarkdown() plain-text extraction.
 */

import { describe, it, expect } from 'bun:test'
import {
  getToolDescriptor,
  getToolDisplayName,
  computeEditWriteDiffStats,
  stripMarkdown,
} from '../tool-descriptor'

describe('getToolDescriptor', () => {
  it('classifies Edit as an edit/write tool with the edit completed icon', () => {
    const d = getToolDescriptor('Edit')
    expect(d.isEditOrWrite).toBe(true)
    expect(d.completedIcon).toBe('edit')
    expect(d.isRead).toBe(false)
    expect(d.isMcp).toBe(false)
    expect(d.isCallLlm).toBe(false)
  })

  it('classifies Write as an edit/write tool with the write completed icon', () => {
    const d = getToolDescriptor('Write')
    expect(d.isEditOrWrite).toBe(true)
    expect(d.completedIcon).toBe('write')
  })

  it('classifies Read as a read tool', () => {
    const d = getToolDescriptor('Read')
    expect(d.isRead).toBe(true)
    expect(d.isEditOrWrite).toBe(false)
    expect(d.completedIcon).toBe('default')
  })

  it('classifies a plain native tool (Bash) with all flags false and default icon', () => {
    const d = getToolDescriptor('Bash')
    expect(d.isMcp).toBe(false)
    expect(d.isCallLlm).toBe(false)
    expect(d.isEditOrWrite).toBe(false)
    expect(d.isRead).toBe(false)
    expect(d.completedIcon).toBe('default')
  })

  it('flags an mcp tool as mcp', () => {
    const d = getToolDescriptor('mcp__foo__bar')
    expect(d.isMcp).toBe(true)
    expect(d.isCallLlm).toBe(false)
  })

  it('flags the call_llm mcp tool as both mcp and callLlm', () => {
    const d = getToolDescriptor('mcp__session__call_llm')
    expect(d.isMcp).toBe(true)
    expect(d.isCallLlm).toBe(true)
  })

  it('classifies undefined with all flags false and default icon', () => {
    const d = getToolDescriptor(undefined)
    expect(d.toolName).toBeUndefined()
    expect(d.isMcp).toBe(false)
    expect(d.isCallLlm).toBe(false)
    expect(d.isEditOrWrite).toBe(false)
    expect(d.isRead).toBe(false)
    expect(d.completedIcon).toBe('default')
  })
})

describe('getToolDisplayName', () => {
  it('maps TodoWrite to a friendly name', () => {
    expect(getToolDisplayName('TodoWrite')).toBe('Todo List Updated')
  })

  it('strips the mcp prefix from an mcp tool name', () => {
    expect(getToolDisplayName('mcp__clickup__clickup_search')).toBe('clickup_search')
  })

  it('passes an unknown native tool name through unchanged', () => {
    expect(getToolDisplayName('SomeNativeTool')).toBe('SomeNativeTool')
  })
})

describe('computeEditWriteDiffStats', () => {
  it('counts Write content as additions with no deletions', () => {
    const stats = computeEditWriteDiffStats('Write', { content: 'line one\nline two\nline three\n' })
    expect(stats).not.toBeNull()
    expect(stats!.additions).toBeGreaterThan(0)
    expect(stats!.deletions).toBe(0)
  })

  it('computes stats for a Claude-format Edit', () => {
    const stats = computeEditWriteDiffStats('Edit', {
      file_path: '/tmp/x.ts',
      old_string: 'const a = 1\n',
      new_string: 'const a = 2\nconst b = 3\n',
    })
    expect(stats).not.toBeNull()
    expect(stats!.additions).toBeGreaterThan(0)
  })

  it('returns null for a non-edit tool', () => {
    expect(computeEditWriteDiffStats('Read', { file_path: '/tmp/x.ts' })).toBeNull()
  })

  it('returns null for absent input', () => {
    expect(computeEditWriteDiffStats('Write', undefined)).toBeNull()
  })

  it('returns null for empty Write content', () => {
    expect(computeEditWriteDiffStats('Write', { content: '' })).toBeNull()
  })
})

describe('stripMarkdown', () => {
  it('strips headers, bold, and links and collapses whitespace', () => {
    const sample = '# Title\n\n**Bold** text with a [link](https://example.com) here.'
    const result = stripMarkdown(sample)
    expect(result).toBe('Title Bold text with a link here.')
    expect(result).not.toContain('#')
    expect(result).not.toContain('**')
    expect(result).not.toContain('](')
  })
})
