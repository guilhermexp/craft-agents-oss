## 1. Contract and tests

- [x] 1.1 Add RED tests proving Groq remains rejected by Meetings config/start.
- [x] 1.2 Add RED tests proving follow-up instructions reach the post-meeting summary prompt.

## 2. Implementation

- [x] 2.1 Keep `MeetingTranscriptionProvider` Deepgram-only.
- [x] 2.2 Thread `followUpOnEnd` into `generateMeetingSummaryMarkdown`.
- [x] 2.3 Keep Deepgram behavior and storage semantics unchanged.
- [x] 2.4 Simplify the result UI to rich Markdown plus recording video preview.
- [x] 2.5 Require video tracks for Craft-native WebM recording.

## 3. Verification

- [x] 3.1 Run focused Meetings tests.
- [x] 3.2 Run `bun run typecheck:electron`.
- [x] 3.3 Run `git diff --check`.
- [x] 3.4 Update this task list with completed checks.
