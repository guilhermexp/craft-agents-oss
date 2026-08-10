import type { SourceConnectionStatus } from '../../../shared/types'

export interface SourceStatusPresentation {
  color: string
  pulseColor: string
  label?: string
  description?: string
  labelKey?: string
  descriptionKey?: string
}

export const SOURCE_STATUS_CONFIG: Record<SourceConnectionStatus, SourceStatusPresentation> = {
  connected: {
    color: 'bg-success',
    pulseColor: 'bg-success/80',
    label: 'Connected',
    description: 'Source is connected and working',
  },
  needs_auth: {
    color: 'bg-info',
    pulseColor: 'bg-info/80',
    label: 'Needs Authentication',
    description: 'Source requires authentication to connect',
  },
  failed: {
    color: 'bg-destructive',
    pulseColor: 'bg-destructive/80',
    label: 'Connection Failed',
    description: 'Failed to connect to source',
  },
  unhealthy: {
    color: 'bg-destructive',
    pulseColor: 'bg-destructive/80',
    labelKey: 'sourcesList.statusReadinessFailed',
    descriptionKey: 'sourcesList.statusReadinessFailedDescription',
  },
  disconnected: {
    color: 'bg-warning',
    pulseColor: 'bg-warning/80',
    label: 'Disconnected',
    description: 'Source endpoint responded without a healthy connection',
  },
  error: {
    color: 'bg-destructive',
    pulseColor: 'bg-destructive/80',
    label: 'Connection Error',
    description: 'Source test failed with an error',
  },
  unknown: {
    color: 'bg-foreground/40',
    pulseColor: 'bg-foreground/30',
    label: 'Unknown',
    description: 'Source connection state is not known yet',
  },
  untested: {
    color: 'bg-foreground/40',
    pulseColor: 'bg-foreground/30',
    label: 'Not Tested',
    description: 'Connection has not been tested',
  },
  local_disabled: {
    color: 'bg-foreground/30',
    pulseColor: 'bg-foreground/20',
    label: 'Disabled',
    description: 'Local MCP servers are disabled in Settings',
  },
}

export function getSourceStatusTooltipDescription(
  status: SourceConnectionStatus,
  errorMessage?: string,
  translate: (key: string) => string = (key) => key,
): string {
  const config = SOURCE_STATUS_CONFIG[status]
  const description = config.descriptionKey
    ? translate(config.descriptionKey)
    : config.description ?? ''
  return errorMessage && ['failed', 'unhealthy', 'disconnected', 'error'].includes(status)
    ? `${description}: ${errorMessage}`
    : description
}

export function getSourceStatusLabel(
  status: SourceConnectionStatus,
  translate: (key: string) => string,
): string {
  const config = SOURCE_STATUS_CONFIG[status]
  return config.labelKey ? translate(config.labelKey) : config.label ?? ''
}
