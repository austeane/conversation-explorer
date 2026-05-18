"""Capture a full-page screenshot of /conversations for the agent worklog."""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT = Path("/var/folders/st/jfhkbl716ls9tcgmt9n0l0br0000gn/T/conversations-final.png")
URL = "http://localhost:5180/conversations"


def main() -> None:
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
        page = ctx.new_page()
        page.goto(URL, wait_until="networkidle", timeout=120_000)
        # Allow charts to settle.
        page.wait_for_timeout(2_500)
        page.screenshot(path=str(OUT), full_page=True)
        print(f"saved {OUT}")
        ctx.close()
        browser.close()


if __name__ == "__main__":
    sys.exit(main())
