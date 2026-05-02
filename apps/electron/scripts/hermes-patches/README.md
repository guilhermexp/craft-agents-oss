# Craft overlay patches for Hermes

Patches applied on top of upstream `NousResearch/hermes-agent` at bundle time.
Source of truth lives here in the Craft repo, not in a separate fork. The
normal bundle/update path must not use `guilhermexp/hermes-agent` or a sibling
`../hermes-agent` checkout.

| Patch | Purpose |
| --- | --- |
| `01-acp-server.patch` | ACP adapter (`acp_adapter/server.py`, `session.py`) — `stream_callback` + `reasoning_callback` wiring so Hermes streams text/reasoning to Craft instead of dumping a single final message, plus ACP MCP toolset reapply after model/source changes. |
| `02-mcp-tool-craft-naming.patch` | `tools/mcp_tool.py` — keep `craft-session`/`craft-sources` MCP server tools under Craft canonical names (`mcp__session__…`, `mcp__github__…`); other MCP servers stay on Hermes-normal names. |
| `03-web-server-craft-embedded.patch` | `hermes_cli/web_server.py` — `_craft_embedded_update_command()` so the Hermes dashboard's "Update" button delegates to Craft's update script when running embedded inside Craft. |

## Versioning

The Hermes upstream commit/tag the patches target lives in
`apps/electron/scripts/hermes-version.txt`. When upstream evolves and a patch
fails to apply, bump that file to the new tag and refresh the affected patch.

## Generation

To refresh after a pin bump, edit the patched cache checkout and capture the
resulting diff back into this directory:

```sh
HERMES_PIN_DIR=apps/electron/scripts/.hermes-cache/source
git -C "$HERMES_PIN_DIR" diff -- <files…> > apps/electron/scripts/hermes-patches/NN-name.patch
```

For active Hermes development only, you may use an explicit local checkout via
`HERMES_SRC=/path/to/hermes-agent`. This is a temporary override that skips the
cache + patch overlay. Unset it before validating dashboard Update, bundle
reproducibility, or release packaging.

## Application

`apps/electron/scripts/bundle-hermes.sh` applies these patches in numeric order
to the clean upstream checkout placed in
`apps/electron/scripts/.hermes-cache/source`. They are validated with
`git apply --check` before `git apply` mutates the cache checkout.
