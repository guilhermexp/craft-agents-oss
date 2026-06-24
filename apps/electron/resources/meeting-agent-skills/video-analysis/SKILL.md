---
name: video-analysis
description: Analyze a recorded meeting by interpreting the pre-extracted visual evidence (contact sheet, key frames) together with the Deepgram transcript before summarizing or diagnosing what happened.
---

# Video Analysis

Use when interpreting a recorded meeting. Craft has already extracted the visual
evidence and attached it to this turn — you do NOT run any helper script or shell
command. The contact sheet and representative frames are provided as image
attachments, and the transcript is included in the prompt.

## Workflow

1. Inspect the attached `contact-sheet` first to read the timeline and locate key moments.
2. Study the attached `frame-*` images for the moments that matter.
3. Read the transcript in the prompt. Treat it as supporting evidence, not as the only source.
4. Cross-check speech against frames:
   - What did the speaker/tester say?
   - What screen/control was visible at that timestamp?
   - Is it a meeting decision, workflow explanation, visual issue, bug report, demo step, or unclear moment?
5. Report the result with timestamps and concrete evidence.

## Rules

- Do not infer from one blurry frame when the transcript or adjacent frames clarify the moment.
- If a frame's text is too small to read, say so explicitly rather than guessing.
- Prefer concrete language: "at 00:24 the toast says..." or "at 00:31 the speaker asks..." instead of "it seems".
- Cite which timestamp/frame/contact-sheet observation supports each important claim.
