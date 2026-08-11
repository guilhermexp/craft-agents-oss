# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- Inline image previews in the activity timeline — a `Read` step on an image file (PNG, JPG, GIF, WebP, BMP, ICO, AVIF) now renders a compact thumbnail beside the row instead of just the filename.
- **Claude Opus 5 now available** — Anthropic's newest Opus (`claude-opus-5`) is selectable in the model picker and is the new default Opus for Anthropic and Claude Max (Claude Code) connections. 1M-token context, adaptive thinking, and Bedrock routing (US / EU / Global inference profiles) are wired up. Opus 4.8 and 4.7 stay selectable as previous generations; connections still defaulting to Opus 4.8 move to Opus 5, and long-deprecated Opus 4.5/4.6 selections normalize onto it.

## Improvements

- **Bundled Claude Agent SDK uplifted to 0.3.219** — the embedded Claude Code CLI moves from 2.1.215 to 2.1.219, so the runtime itself knows Opus 5 (the `opus` alias, its 1M context window, and its `high` effort default).
- **Auto-compaction now triggers at 700k tokens on 1M models** — the CLI's own trigger is `window − 33k`, so a 1M session ran all the way to 967k before summarizing and every request in that tail paid for ~900k input tokens. Craft now sets `autoCompactWindow`, moving the trigger to 700k. The CLI clamps the setting to each model's real capacity, so 200k models keep their natural 167k trigger.

## Bug Fixes

- **Context badge was stuck near 99 %** — the badge read the *first* entry of the SDK's `modelUsage` map, but the CLI bills its own internal Haiku helper call before the session's model, so every 1M Opus session was measured against Haiku's 200k window. Combined with a `Math.min(99, …)` clamp and a guessed "77.5 % of the window" compaction threshold, any decent session pinned at 99 %. The window now comes from `Query.getContextUsage()` — the budget the CLI actually compacts against — with the model-matched `modelUsage` entry as a fallback, the percentage is a plain share of that window, and a window contradicted by its own token count is discarded instead of rendered.
- **Context badge no longer disappears** — it used to render only above 80 % and hid itself during compaction. It is now always present once a session has consumed context: quiet below 75 %, amber from 75 %, red from 90 %, and legible (no opacity drop) while a turn is in flight. Hovering shows the precise reading — `27.0% · 270.1K / 1.0M context` — plus why clicking will or will not compact.

## Breaking Changes

