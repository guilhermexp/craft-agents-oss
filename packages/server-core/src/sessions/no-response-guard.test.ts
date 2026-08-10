import { describe, expect, it } from 'bun:test'
import { shouldReportMissingAssistantResponse } from './SessionManager.ts'

// A turn that ends with no assistant message now always lands on a visible
// message (fix-tool-block-turn-continuation). That is right for a silent
// failure and wrong for a turn the user ended on purpose: Stop already renders
// "Response interrupted", and a mid-stream send already promises a replay, so
// the extra red "No Response" card with a retry button is a false positive.
//
// `cancelProcessing` deliberately leaves `isProcessing` true so the event loop
// drains, which means the `complete` event reaches this branch with
// `stopRequested`/`wasInterrupted` still set — the early returns above it only
// cover auth retry and explicit handoffs.
describe('shouldReportMissingAssistantResponse', () => {
  it('reports a turn that went silent on its own', () => {
    expect(shouldReportMissingAssistantResponse({ queuedMessageCount: 0 })).toBe(true)
  })

  it('stays quiet after an explicit Stop', () => {
    expect(
      shouldReportMissingAssistantResponse({
        stopRequested: true,
        wasInterrupted: true,
        queuedMessageCount: 0,
      }),
    ).toBe(false)
  })

  it('stays quiet while only stopRequested is set', () => {
    expect(
      shouldReportMissingAssistantResponse({ stopRequested: true, queuedMessageCount: 0 }),
    ).toBe(false)
  })

  it('stays quiet after a redirect interrupted the turn', () => {
    // forceAbort(AbortReason.Redirect): the backend could not steer, so the
    // message was queued and the turn was cut short on purpose.
    expect(
      shouldReportMissingAssistantResponse({ wasInterrupted: true, queuedMessageCount: 1 }),
    ).toBe(false)
  })

  it('stays quiet when a queued message will be replayed as the next turn', () => {
    expect(shouldReportMissingAssistantResponse({ queuedMessageCount: 1 })).toBe(false)
  })
})
