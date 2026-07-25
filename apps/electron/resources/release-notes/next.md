# Pending Release Notes

This file accumulates release notes for the next unreleased version. PRs that add user-visible behavior should append a bullet to the relevant section here. Versioned files (`X.Y.Z.md`) are owned by the release skill — never create them in feature commits.

## Features

- Inline image previews in the activity timeline — a `Read` step on an image file (PNG, JPG, GIF, WebP, BMP, ICO, AVIF) now renders a compact thumbnail beside the row instead of just the filename.
- **Claude Opus 5 now available** — Anthropic's newest Opus (`claude-opus-5`) is selectable in the model picker and is the new default Opus for Anthropic and Claude Max (Claude Code) connections. 1M-token context, adaptive thinking, and Bedrock routing (US / EU / Global inference profiles) are wired up. Opus 4.8 and 4.7 stay selectable as previous generations; connections still defaulting to Opus 4.8 move to Opus 5, and long-deprecated Opus 4.5/4.6 selections normalize onto it.

## Improvements

- **Bundled Claude Agent SDK uplifted to 0.3.219** — the embedded Claude Code CLI moves from 2.1.215 to 2.1.219, so the runtime itself knows Opus 5 (the `opus` alias, its 1M context window, and its `high` effort default).

## Bug Fixes

## Breaking Changes
