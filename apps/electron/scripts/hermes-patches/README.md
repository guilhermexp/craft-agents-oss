# Craft overlay patches for Hermes

Patches applied on top of upstream `NousResearch/hermes-agent` at bundle time.
Source of truth lives here in the Craft repo, not in a separate fork. The
normal bundle/update path must not use `guilhermexp/hermes-agent` or a sibling
`../hermes-agent` checkout.

| Patch | Purpose |
| --- | --- |
| `01-acp-server.patch` | ACP adapter (`acp_adapter/server.py`, `session.py`) — stores ACP-provided `mcp_servers`, wires one streaming path (`stream_callback`) so Hermes streams text to Craft without duplicating deltas across profile-local sessions, and reapplies ACP MCP toolsets after `/model` or ACP `session/set_model` recreates the underlying `AIAgent`. Upstream Hermes owns reasoning-delta routing; do not duplicate that here unless upstream removes it. |
| `02-mcp-tool-craft-naming.patch` | `tools/mcp_tool.py` — keep `craft-session`/`craft-sources` MCP server tools under Craft canonical names (`mcp__session__…`, `mcp__github__…`); other MCP servers stay on Hermes-normal names. |
| `03-web-server-craft-embedded.patch` | `hermes_cli/web_server.py` — `_craft_embedded_update_command()` so the Hermes dashboard's "Update" button delegates to Craft's update script when running embedded inside Craft. |
| `05-google-meet-localized-join.patch` | `plugins/google_meet/meet_bot.py` — extends the join-button matcher with localized labels (`Participar agora`, `Entrar agora`, `Unirse ahora`, `Pedir para participar`, …) so the bot joins meetings whose UI is not in English. |
| `06-google-meet-debug-and-robust-click.patch` | `plugins/google_meet/meet_bot.py` — adds structured launch/auth logging plus per-step page screenshots and falls back to Playwright role-based clicks when text matching misses, so toolbar invitations can surface why a join failed instead of timing out silently. |
| `08-codex-none-output-fallback.patch` | `agent/codex_runtime.py` + `agent/auxiliary_client.py` — the ChatGPT Codex backend sends Response events/objects with `output=None`; openai 2.24.0's `responses.stream()` helper and the `output_text` property both do `for output in response.output` with no None guard, raising `TypeError: 'NoneType' object is not iterable`. (1) `run_codex_stream()` and the auxiliary Codex client catch that TypeError and recover via the raw `create(stream=True)` path that skips the typed accumulate/parse helper. (2) All three backfill sites treat `output is None` like an empty list and never leave `output` as None, so the downstream `output_text` read can't crash. Without this every `openai-codex/gpt-5.x` Hermes turn aborted as a non-retryable client error (main chat + title generation). |
| `09-meet-playwright-on-demand.patch` | `plugins/google_meet/tools.py` + new `plugins/google_meet/_craft_playwright.py` — Craft stops vendoring the Playwright driver (~128 MB). `handle_meet_join` provisions Playwright (+ `websockets`) and Chromium **on demand** on the first local Meet join, into an app-scoped writable dir (`$HERMES_HOME/runtime-deps/google-meet`), registers it on `sys.path`/`PYTHONPATH` so the spawned `meet_bot` subprocess resolves it, points `PLAYWRIGHT_BROWSERS_PATH` there, streams progress to stderr (not stdout — that carries ACP), and fails with a clear error when offline. The signed venv is never mutated. Pairs with the `bundle-hermes.*` change that installs only `websockets`. |

## Versioning

The Hermes upstream ref the patches target lives in
`apps/electron/scripts/hermes-version.txt`. Keep day-to-day/dashboard updates
pinned to a concrete tag or SHA so the `(pin + patches)` pair is reproducible
and the dashboard does not break whenever upstream `main` moves. Use a floating
ref such as `upstream/main` only during an explicit Hermes bump/overlay-refresh
session, then persist the resolved known-good tag/SHA before returning to normal
development.

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
