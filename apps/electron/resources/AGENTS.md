# Bundled Resources

This folder contains assets that are bundled with the Electron app. Most legacy assets are synced to the user's `~/.craft-agent/` directory on every launch; Hermes seed assets are bundled as a source of truth for a separate app-scoped `HERMES_HOME` bootstrap/merge.

## How It Works

1. **Build time**: `scripts/copy-assets.ts` copies this folder to `dist/resources/`, excluding the generated Hermes runtime under `resources/vendor/hermes/`
2. **Package time**: electron-builder includes `dist/resources/` in the app bundle and separately injects the generated Hermes runtime through `extraResources` as `app/vendor/hermes`
3. **Runtime**: `getBundledAssetsDir()` resolves paths to these bundled assets
4. **Launch**: Legacy asset types sync to the user's home directory; Hermes seed assets are copy/merged into app-scoped `HERMES_HOME` by `ensureHermesSeedSkills()`

## Asset Types

| Folder/File | Synced To | Sync Behavior |
|-------------|-----------|---------------|
| `docs/` | `~/.craft-agent/docs/` | Always overwrite on launch |
| `themes/` | `~/.craft-agent/themes/` | Always overwrite on launch |
| `permissions/` | `~/.craft-agent/permissions/` | Always overwrite on launch |
| `tool-icons/` | `~/.craft-agent/tool-icons/` | Always overwrite on launch |
| `config-defaults.json` | `~/.craft-agent/config-defaults.json` | Always overwrite on launch |
| `hermes-seed/` | `<Electron userData>/hermes/skills/...` | Copy if missing; preserve user edits; version migrations only through manifest |
| `vendor/hermes/` | Packaged `.app` `Contents/Resources/app/vendor/hermes` | Generated runtime copied by electron-builder `extraResources`; not copied into `dist/resources` |

## Why Sync on Every Launch?

- Ensures users always have the latest defaults/docs when the app updates
- Consistent behavior between debug and release builds
- No stale configuration causing confusion

## Other Files (Not Synced)

These files are used by electron-builder or the app directly, not synced to user home:

| File | Purpose |
|------|---------|
| `icon.*` | App icons (icns, ico, png, svg) |
| `Assets.car` | macOS compiled asset catalog |
| `dmg-background.*` | DMG installer background |
| `craft-logos/` | Branding assets |
| `source.png` | Default source icon |
| `generate-icons.sh` | Icon generation script |
| `hermes-seed/` | Repository-bundled seed skills/instructions for embedded Hermes; bootstrapped into app-scoped `HERMES_HOME` with copy-if-missing semantics |
| `vendor/hermes/` | Generated embedded Hermes runtime; excluded from `dist/resources` and shipped through `extraResources` as `app/vendor/hermes` |
| `bridge-mcp-server/` | Bundled MCP server for Codex/Copilot API source bridge |
| `session-mcp-server/` | Bundled MCP server for session tools |

## Single Source of Truth

The files in this folder are the **source of truth** for bundled defaults:
- Edit `config-defaults.json` here to change default settings
- Edit files in `docs/` to update documentation
- Edit files in `themes/` to update bundled themes

There is no TypeScript fallback - if the bundled JSON file is missing, the app will fail with a clear error.
