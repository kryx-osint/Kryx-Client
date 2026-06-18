#!/usr/bin/env python3
"""Copy bundled UI assets from a sibling Kryx repo into this standalone client (optional maintenance)."""

from __future__ import annotations

import shutil
from pathlib import Path

CLIENT_ROOT = Path(__file__).resolve().parents[1]
KRYX_ROOT = CLIENT_ROOT.parent

PAIRS = [
    (KRYX_ROOT / "static" / "kryx.css", CLIENT_ROOT / "static" / "kryx.css"),
    (KRYX_ROOT / "static" / "workspace-contextual-live.js", CLIENT_ROOT / "static" / "workspace-contextual-live.js"),
    (KRYX_ROOT / "static" / "workspace-search-tabs.js", CLIENT_ROOT / "static" / "workspace-search-tabs.js"),
    (KRYX_ROOT / "static" / "intelligence-print-page.css", CLIENT_ROOT / "static" / "intelligence-print-page.css"),
    (KRYX_ROOT / "static" / "js" / "kryx-preview-common.js", CLIENT_ROOT / "static" / "js" / "kryx-preview-common.js"),
    (
        KRYX_ROOT / "templates" / "partials" / "dashboard_preview_section.html",
        CLIENT_ROOT / "templates" / "partials" / "dashboard_preview_section.html",
    ),
    (
        KRYX_ROOT / "templates" / "partials" / "search_type_icon.html",
        CLIENT_ROOT / "templates" / "partials" / "search_type_icon.html",
    ),
    (KRYX_ROOT / "user_intel.py", CLIENT_ROOT / "user_intel.py"),
    (KRYX_ROOT / "static" / "hero-dots-interaction.js", CLIENT_ROOT / "static" / "hero-dots-interaction.js"),
]


def main() -> None:
    if not (KRYX_ROOT / "app.py").is_file():
        raise SystemExit(f"Kryx repo not found at {KRYX_ROOT}")
    (CLIENT_ROOT / "static" / "js").mkdir(parents=True, exist_ok=True)
    for src, dst in PAIRS:
        if not src.is_file():
            raise SystemExit(f"Missing source: {src}")
        shutil.copy2(src, dst)
        print(f"Copied {src.name} -> {dst.relative_to(CLIENT_ROOT)}")
    print("Done.")


if __name__ == "__main__":
    main()
