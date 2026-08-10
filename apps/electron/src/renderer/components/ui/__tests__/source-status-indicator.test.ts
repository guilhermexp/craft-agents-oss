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
    expect(SOURCE_STATUS_CONFIG.unhealthy).toMatchObject({
      labelKey: 'sourcesList.statusReadinessFailed',
      descriptionKey: 'sourcesList.statusReadinessFailedDescription',
    })
    expect(SOURCE_STATUS_CONFIG.unhealthy).not.toHaveProperty('label')
    expect(SOURCE_STATUS_CONFIG.unhealthy).not.toHaveProperty('description')
    expect(getSourceStatusTooltipDescription(
      'unhealthy',
      'missing-tools',
      (key) => key,
    )).toBe('sourcesList.statusReadinessFailedDescription: missing-tools')
  })
})
