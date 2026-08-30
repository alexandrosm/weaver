#!/usr/bin/env python3
"""
print.py -- send G-code to a Prusa Buddy printer (Core One, MK4, XL) over
PrusaLink on the local network.

    bun engine.js --printer coreone --gcode swatch.gcode
    python print.py swatch.gcode --host 192.168.1.50 --key <PrusaLink key> --go

The key is on the printer: Settings -> Network -> PrusaLink. `--go` starts
the print immediately after upload; omit it to just place the file on the
USB storage. Uses X-Api-Key and falls back to HTTP digest (user "maker").

Print the NOTES.md phase-0 swatches first: 30 mm, flex in the hand.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import quote


def request(host: str, key: str, method: str, path: str,
            data: bytes | None = None, headers: dict | None = None):
    url = f"http://{host}{path}"
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"X-Api-Key": key, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        if e.code == 401:
            # Buddy PrusaLink may insist on digest auth (user "maker")
            mgr = urllib.request.HTTPPasswordMgrWithDefaultRealm()
            mgr.add_password(None, f"http://{host}", "maker", key)
            opener = urllib.request.build_opener(
                urllib.request.HTTPDigestAuthHandler(mgr))
            req2 = urllib.request.Request(url, data=data, method=method,
                                          headers=headers or {})
            with opener.open(req2, timeout=60) as r:
                return r.status, r.read().decode("utf-8", "replace")
        return e.code, e.read().decode("utf-8", "replace")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("gcode", help="G-code file to send")
    p.add_argument("--host", required=True, help="printer IP or hostname")
    p.add_argument("--key", default=os.environ.get("PRUSALINK_API_KEY"),
                   help="PrusaLink API key (or env PRUSALINK_API_KEY)")
    p.add_argument("--name", default=None, help="remote filename (default: local name)")
    p.add_argument("--storage", default="usb", help="target storage (default: usb)")
    p.add_argument("--go", action="store_true", help="start printing after upload")
    a = p.parse_args()
    if not a.key:
        raise SystemExit("no API key: pass --key or set PRUSALINK_API_KEY")

    body = Path(a.gcode).read_bytes()
    name = a.name or Path(a.gcode).name
    if not name.lower().endswith((".gcode", ".bgcode", ".gco", ".g")):
        name += ".gcode"

    try:
        code, text = request(
            a.host, a.key, "PUT",
            f"/api/v1/files/{a.storage}/{quote(name)}", data=body,
            headers={"Content-Type": "application/octet-stream",
                     "Print-After-Upload": "?1" if a.go else "?0",
                     "Overwrite": "?1"})
    except (urllib.error.URLError, OSError) as e:
        raise SystemExit(f"cannot reach {a.host}: {e}")

    if code not in (200, 201, 204):
        raise SystemExit(f"upload failed ({code}): {text.strip()[:300]}")
    print(f"  uploaded {name} ({len(body)/1024:.1f} KB) to {a.storage} on {a.host}"
          + ("  — printing" if a.go else ""))

    try:
        code, text = request(a.host, a.key, "GET", "/api/v1/status")
        if code == 200:
            st = json.loads(text)
            pr = st.get("printer", {})
            print(f"  printer: {pr.get('state', '?')}"
                  f"  nozzle {pr.get('temp_nozzle', '?')}°C"
                  f"  bed {pr.get('temp_bed', '?')}°C")
    except Exception:
        pass  # status is a courtesy, not part of the upload contract


if __name__ == "__main__":
    main()
