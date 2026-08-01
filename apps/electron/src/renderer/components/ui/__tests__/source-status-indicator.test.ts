import { describe, expect, test } from 'bun:test'

import { SOURCE_CONNECTION_STATUSES } from '@craft-agent/shared/sources/types'
import {
  SOURCE_STATUS_CONFIG,
  getSourceStatusTooltipDescription,
} from '../source-status'

describe('source status presentation', () => {
  test('renders every status accepted by the shared config validator', () => {
    for (const status of SOURCE_CONNECTION_STATUSES) {
      expect(SOURCE_STATUS_CONFIG[status]).toBeDefined()
    }
  })

  test('uses readiness-specific copy and preserves the redacted error tooltip', () => {
    expect(SOURCE_STATUS_CONFIG.unhealthy.label).toBe('Readiness Failed')
    expect(SOURCE_STATUS_CONFIG.unhealthy.description).toContain('expected tools')
    expect(getSourceStatusTooltipDescription('unhealthy', 'missing-tools')).toContain('missing-tools')
  })
})
