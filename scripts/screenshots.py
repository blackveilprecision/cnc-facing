#!/usr/bin/env python3
"""Regenerate docs/*.png. Needs `pip install playwright` and a Chromium.

    PORT=3199 bun run src/server.ts &
    python3 scripts/screenshots.py [chromium-path]
"""
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:3199"
exe = sys.argv[1] if len(sys.argv) > 1 else None

with sync_playwright() as p:
    b = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    pg = b.new_page(viewport={"width": 1280, "height": 1000}, color_scheme="dark")
    pg.goto(BASE + "/")
    pg.fill("[name=width]", "100")
    pg.fill("[name=height]", "80")
    pg.fill("[name=depth]", "0.3")
    pg.wait_for_timeout(1500)
    pg.screenshot(path="docs/facing.png", full_page=True)
    pg.goto(BASE + "/#check")
    pg.set_input_files("#file", "test/fixtures/easytrace-B-back-RAW.cnc")
    pg.wait_for_timeout(2500)
    pg.screenshot(path="docs/check.png", full_page=True)
    b.close()
