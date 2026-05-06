# Craft overlay patches for Hermes

Patches applied on top of upstream `NousResearch/hermes-agent` at bundle time.
Source of truth lives here in the Craft repo, not in a separate fork. The
normal bundle/update path must not use `guilhermexp/hermes-agent` or a sibling
`../hermes-agent` checkout.

| Patch | Purpose |
| --- | --- |
| `01-acp-server.patch` | ACP adapter (`acp_adapter/server.py`, `session.py`) — stores ACP-provided `mcp_servers`, wires `stream_callback` so Hermes streams text to Craft instead of dumping a single final message, and reapplies ACP MCP toolsets after `/model` or ACP `session/set_model` recreates the underlying `AIAgent`. Upstream Hermes owns reasoning-delta routing; do not duplicate that here unless upstream removes it. |
| `02-mcp-tool-craft-naming.patch` | `tools/mcp_tool.py` — keep `craft-session`/`craft-sources` MCP server tools under Craft canonical names (`mcp__session__…`, `mcp__github__…`); other MCP servers stay on Hermes-normal names. |
| `03-web-server-craft-embedded.patch` | `hermes_cli/web_server.py` — `_craft_embedded_update_command()` so the Hermes dashboard's "Update" button delegates to Craft's update script when running embedded inside Craft. |
| `04-acp-tools-json-scope.patch` | `acp_adapter/tools.py` — removes a local `import json` inside `build_tool_start()` that shadows the module import and crashes history replay for polished tool calls with `UnboundLocalError`. |

## Versioning

The Hermes upstream ref the patches target lives in
`apps/electron/scripts/hermes-version.txt`. In development this may be the
floating `upstream/main` ref so Dashboard **Update Hermes** follows upstream
automatically. When upstream evolves and a patch fails to apply, refresh the
affected patch against the cache head. Do not pin back to an old SHA unless the
goal is an explicit rollback or reproducible release build.

## Generation

To refresh after upstream drift, edit the clean cache checkout and capture the
resulting diff back into this directory:

```sh
HERMES_PIN_DIR=apps/electron/scripts/.hermes-cache/source
git -C "$HERMES_PIN_DIR" reset --hard HEAD
# hand-apply the intended Craft bridge/embedding delta, then:
git -C "$HERMES_PIN_DIR" diff -- <files…> > apps/electron/scripts/hermes-patches/NN-name.patch

# verify from a clean upstream checkout before committing
git -C "$HERMES_PIN_DIR" reset --hard HEAD
for p in apps/electron/scripts/hermes-patches/*.patch; do
  git -C "$HERMES_PIN_DIR" apply --check "$PWD/$p"
done
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
