# Craft Hermes Seed

Repository-bundled seed knowledge for Hermes when it runs embedded inside Craft Agents Electron.

These files ship with the Electron app under `dist/resources/hermes-seed/` so a fresh user install has a source of truth for Craft-specific Hermes behavior: embedded runtime paths, app-scoped `HERMES_HOME`, native session MCP tools, browser, channels, meetings, and release validation.

In a packaged macOS app, this folder must exist at:

```txt
Craft Agents.app/Contents/Resources/app/dist/resources/hermes-seed/
```

It is intentionally separate from the generated Python runtime, which ships at:

```txt
Craft Agents.app/Contents/Resources/app/vendor/hermes/
```

## Current contents

```txt
skills/craft-embedded-runtime/SKILL.md
```

## Important

This folder being present in app resources is used by Craft's Hermes seed bootstrap (`ensureHermesSeedSkills`) to copy/merge skills into the user's app-scoped Hermes home, for example:

```txt
<electron userData>/hermes/skills/craft/craft-embedded-runtime/SKILL.md
```

Bootstrap rules:

- copy seed skills if missing;
- preserve user edits;
- do not store secrets here;
- version migrations through a manifest before overwriting anything;
- keep native Craft tools session-scoped through ACP `session.mcpServers`, not static global `mcp.json`.
