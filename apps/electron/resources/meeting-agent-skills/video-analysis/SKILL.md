---
name: video-analysis
description: Analyze any video, screen recording, WhatsApp video, meeting recording, demo, or mobile/tablet footage by extracting contact sheets, key frames, audio, and optional transcript before summarizing or diagnosing what happened.
---

# Video Analysis

Use when the user attaches a video or screen recording and asks to understand, summarize, verify, inspect, diagnose, or extract decisions/action items from it.

## Workflow

1. Run the helper outside the repo:
   ```bash
   python3 ~/.agents/skills/video-analysis/scripts/video_evidence.py "/absolute/path/video.mp4"
   ```
2. Inspect `contact-sheet.jpg` first to identify the timeline and key moments.
3. Open 4-8 relevant `frames/frame-*.jpg` with `view_image`.
4. Read `transcript.txt` if generated. Treat it as supporting evidence, not as the only source.
5. Cross-check speech against frames:
   - What did the speaker/tester say?
   - What screen/control was visible at that timestamp?
   - Is it a meeting decision, workflow explanation, visual issue, bug report, demo step, or unclear moment?
6. Report the result with timestamps and evidence. If the user asked to fix an app issue, then inspect the code and validate the fix with real browser/app interaction.

## Rules

- Do not infer from one blurry frame when audio or adjacent frames clarify the issue.
- If text is too small in the contact sheet, extract a larger frame around that timestamp.
- Keep generated artifacts in `/tmp` unless the user explicitly asks to save them in the repo.
- Prefer concrete language: "at 00:24 the toast says..." or "at 00:31 the speaker asks..." instead of "it seems".
- For production app bugs, validate the final fix in the deployed URL when relevant.
