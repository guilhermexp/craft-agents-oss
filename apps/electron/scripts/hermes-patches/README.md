# Craft overlay patches for Hermes

Patches applied on top of upstream `NousResearch/hermes-agent` at bundle time.
Source of truth lives here in the Craft repo, not in a separate fork.

| Patch | Purpose |
| --- | --- |
| `01-acp-streaming.patch` | ACP adapter (`acp_adapter/server.py`, `session.py`) — `stream_callback` + `reasoning_callback` wiring so Hermes streams text/reasoning to Craft instead of dumping a single final message. |
| `02-mcp-tool-craft-naming.patch` | `tools/mcp_tool.py` — keep `craft-session`/`craft-sources` MCP server tools under Craft canonical names (`mcp__session__…`, `mcp__github__…`); other MCP servers stay on Hermes-normal names. |
| `03-web-server-craft-embedded.patch` | `hermes_cli/web_server.py` — `_craft_embedded_update_command()` so the Hermes dashboard's "Update" button delegates to Craft's update script when running embedded inside Craft. |

## Versioning

The Hermes upstream commit/tag the patches target lives in
`apps/electron/scripts/hermes-version.txt`. When upstream evolves and a patch
fails to apply, bump that file to the new tag and refresh the affected patch.

## Generation

These were initially extracted with:

```sh
git -C ../hermes-agent diff upstream/main -- <files…> > NN-name.patch
```

To refresh after editing the upstream source locally:

```sh
git -C <upstream-checkout> diff <pinned-tag> -- <files…> > NN-name.patch
```

## Application

`apps/electron/scripts/bundle-hermes.sh` applies these patches in numeric order
to a clean upstream checkout placed in
`~/.craft-agent/hermes-update-cache/hermes-agent`. They are validated with
`git apply --check` before any changes touch disk.
