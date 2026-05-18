"""Wider screenshot of /conversations with multiple sections at full resolution."""
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

OUT_DIR = Path("/var/folders/st/jfhkbl716ls9tcgmt9n0l0br0000gn/T")


def main() -> None:
    URL = "http://localhost:5180/conversations"
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(viewport={"width": 1600, "height": 1000}, device_scale_factor=2)
        page = ctx.new_page()
        page.goto(URL, wait_until="networkidle", timeout=120_000)
        page.wait_for_timeout(2_500)
        # Section 01 + 02 viewport
        page.screenshot(path=str(OUT_DIR / "conversations-top.png"), clip={"x": 0, "y": 0, "width": 1600, "height": 1500})
        # Sections 03/04
        page.evaluate("window.scrollTo(0, 1500)")
        page.wait_for_timeout(800)
        page.screenshot(path=str(OUT_DIR / "conversations-mid.png"))
        page.evaluate("window.scrollTo(0, 3000)")
        page.wait_for_timeout(800)
        page.screenshot(path=str(OUT_DIR / "conversations-mid2.png"))
        # Bottom
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(1_500)
        page.screenshot(path=str(OUT_DIR / "conversations-bottom.png"))
        ctx.close()
        browser.close()
        print("done")


if __name__ == "__main__":
    sys.exit(main())
