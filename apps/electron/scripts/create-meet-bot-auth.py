#!/usr/bin/env python3
"""Create a dedicated Playwright storage state for the Hermes Google Meet bot.

Run with the Hermes vendor venv so Playwright is available. The browser opens in
headed mode. Log in with a *dedicated bot Google account*, not the meeting
organizer account, then press Enter in the terminal to save the storage state.
"""

from __future__ import annotations

import os
from pathlib import Path

from playwright.sync_api import sync_playwright


DEFAULT_HERMES_HOME = Path.home() / "Library/Application Support/@craft-agent/electron/hermes"
HERMES_HOME = Path(os.environ.get("HERMES_HOME") or DEFAULT_HERMES_HOME).expanduser()
OUT_PATH = HERMES_HOME / "workspace" / "meetings" / "bot-auth.json"
USER_DATA_DIR = HERMES_HOME / "workspace" / "meetings" / "bot-auth-profile"


def main() -> int:
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    USER_DATA_DIR.mkdir(parents=True, exist_ok=True)

    print("Opening Chromium for Hermes Meet bot auth...")
    print("Use a dedicated bot Google account, not the organizer/host account.")
    print(f"Storage state will be saved to: {OUT_PATH}")

    with sync_playwright() as p:
        context = p.chromium.launch_persistent_context(
            user_data_dir=str(USER_DATA_DIR),
            headless=False,
            viewport={"width": 1280, "height": 900},
            args=[
                "--use-fake-ui-for-media-stream",
                "--use-fake-device-for-media-stream",
            ],
        )
        page = context.pages[0] if context.pages else context.new_page()
        page.goto("https://accounts.google.com/", wait_until="domcontentloaded")
        print("\n1. Log in to the dedicated Hermes/bot Google account in the Chromium window.")
        print("2. Optionally open https://meet.google.com/ once to confirm the account is active.")
        input("3. Press Enter here after login is complete to save bot-auth.json... ")
        context.storage_state(path=str(OUT_PATH))
        context.close()

    os.chmod(OUT_PATH, 0o600)
    print(f"OK: saved {OUT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
