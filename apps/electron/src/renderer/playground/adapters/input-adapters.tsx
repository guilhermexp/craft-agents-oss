/**
 * Playground Adapters for Input Components
 *
 * Provides mock data generators and wrapper components that allow
 * the main app's input components to work in the playground context.
 */

import type { AdminApprovalRequestData } from '@/components/app-shell/input/structured/AdminApprovalRequest'

// ============================================================================
// Mock Data Generators
// ============================================================================

/**
 * Generate mock AdminApprovalRequest data for playground
 */
export function mockAdminApprovalRequest(overrides?: Partial<AdminApprovalRequestData>): AdminApprovalRequestData {
  return {
    appName: 'Docker Desktop',
    reason: 'Homebrew needs admin access to complete post-install steps.',
    command: 'brew install --cask docker',
    impact: 'May install files in /Applications and system-managed directories.',
    requiresSystemPrompt: true,
    rememberForMinutes: 10,
    ...overrides,
  }
}


// ============================================================================
// Playground Wrapper Props
// ============================================================================

/**
 * Props for PermissionRequest in playground context
 */
export interface PermissionRequestPlaygroundProps {
  toolName?: string
  description?: string
  command?: string
  onAction?: () => void
  unstyled?: boolean
}

/**
 * Props for AdminApprovalRequest in playground context
 */
export interface AdminApprovalRequestPlaygroundProps {
  appName?: string
  reason?: string
  command?: string
  impact?: string
  requiresSystemPrompt?: boolean
  rememberForMinutes?: number
  onAction?: () => void
  unstyled?: boolean
}


// ============================================================================
// Adapter Functions
// ============================================================================

