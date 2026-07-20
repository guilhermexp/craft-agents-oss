/**
 * useProjects
 *
 * Loads workspace-scoped projects and keeps them in sync via the
 * `projects:changed` broadcast. Mirrors the lightweight half of `useAutomations`.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useSetAtom } from 'jotai'
import { projectsAtom } from '@/atoms/projects'
import type { LoadedProject } from '@craft-agent/shared/projects/types'

export interface UseProjectsResult {
  projects: LoadedProject[]
  refresh: () => Promise<void>
}

export function shouldApplyProjectsResult(
  requestGeneration: number,
  currentGeneration: number,
  requestedWorkspaceId: string,
  currentWorkspaceId: string | null | undefined,
): boolean {
  return requestGeneration === currentGeneration && requestedWorkspaceId === currentWorkspaceId
}

export function useProjects(activeWorkspaceId: string | null | undefined): UseProjectsResult {
  const [projects, setProjects] = useState<LoadedProject[]>([])
  const setProjectsAtom = useSetAtom(projectsAtom)
  const requestStateRef = useRef({
    generation: 0,
    workspaceId: activeWorkspaceId,
  })

  const refresh = useCallback(async () => {
    const requestGeneration = ++requestStateRef.current.generation
    if (!activeWorkspaceId) {
      setProjects([])
      setProjectsAtom([])
      return
    }
    try {
      const result = await window.electronAPI.getProjects(activeWorkspaceId)
      if (!shouldApplyProjectsResult(
        requestGeneration,
        requestStateRef.current.generation,
        activeWorkspaceId,
        requestStateRef.current.workspaceId,
      )) return
      const list = Array.isArray(result) ? (result as LoadedProject[]) : []
      setProjects(list)
      setProjectsAtom(list)
    } catch (err) {
      if (!shouldApplyProjectsResult(
        requestGeneration,
        requestStateRef.current.generation,
        activeWorkspaceId,
        requestStateRef.current.workspaceId,
      )) return
      console.error('[useProjects] Failed to load projects:', err)
      setProjects([])
      setProjectsAtom([])
    }
  }, [activeWorkspaceId, setProjectsAtom])

  useEffect(() => {
    requestStateRef.current.workspaceId = activeWorkspaceId
    void refresh()
    return () => {
      requestStateRef.current.generation += 1
    }
  }, [activeWorkspaceId, refresh])

  useEffect(() => {
    if (!activeWorkspaceId) return
    const off = window.electronAPI.onProjectsChanged((wsId: string, list: unknown) => {
      if (wsId !== activeWorkspaceId) return
      requestStateRef.current.generation += 1
      const projects = Array.isArray(list) ? (list as LoadedProject[]) : []
      setProjects(projects)
      setProjectsAtom(projects)
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [activeWorkspaceId, setProjectsAtom])

  return { projects, refresh }
}
