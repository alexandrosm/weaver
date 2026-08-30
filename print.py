#!/usr/bin/env python3
"""
print.py -- send G-code to a Prusa Buddy printer (Core One, MK4, XL) over
PrusaLink on the local network.

    bun engine.js --printer coreone --gcode swatch.gcode
    python print.py swatch.gcode --physical-printer "Basement Core One"

`--physical-printer` reuses PrusaSlicer's host, username, authorization mode,
and the password it placed in the current Windows user's Credential Manager.
The secret is read directly into memory and is never printed or put on the
command line. `--go` starts the print; omit it to upload only.

Print the NOTES.md phase-0 swatches first: 30 mm, flex in the hand.
"""
from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import sys
import urllib.error
import urllib.request
from getpass import getpass
from pathlib import Path
from urllib.parse import quote


def physical_printer(name: str) -> dict[str, str]:
    """Load one flat PrusaSlicer physical-printer INI without exposing secrets."""
    if Path(name).name != name:
        raise ValueError("physical printer must be a profile name, not a path")
    root = Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming"))
    path = root / "PrusaSlicer" / "physical_printer" / f"{name}.ini"
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        if "=" in raw and not raw.lstrip().startswith(("#", ";")):
            key, value = raw.split("=", 1)
            values[key.strip()] = value.strip()
    if values.get("host_type") != "prusalink":
        raise ValueError(f"{name!r} is not a PrusaLink profile")
    return values


def stored_credential(target: str) -> tuple[str, str] | None:
    """Read a UTF-8 wxSecretStore value from Windows Credential Manager."""
    if os.name != "nt":
        return None
    from ctypes import wintypes

    class CredentialW(ctypes.Structure):
        _fields_ = [
            ("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
            ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
            ("LastWritten", wintypes.FILETIME),
            ("CredentialBlobSize", wintypes.DWORD),
            ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
            ("Persist", wintypes.DWORD), ("AttributeCount", wintypes.DWORD),
            ("Attributes", ctypes.c_void_p), ("TargetAlias", wintypes.LPWSTR),
            ("UserName", wintypes.LPWSTR),
        ]

    pointer = ctypes.POINTER(CredentialW)()
    advapi = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
    advapi.CredReadW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
        ctypes.POINTER(ctypes.POINTER(CredentialW)),
    ]
    advapi.CredReadW.restype = wintypes.BOOL
    advapi.CredFree.argtypes = [ctypes.c_void_p]
    if not advapi.CredReadW(target, 1, 0, ctypes.byref(pointer)):
        error = ctypes.get_last_error()
        if error == 1168:  # ERROR_NOT_FOUND
            return None
        raise OSError(error, ctypes.FormatError(error))
    try:
        cred = pointer.contents
        blob = ctypes.string_at(cred.CredentialBlob, cred.CredentialBlobSize)
        return cred.UserName or "", blob.decode("utf-8")
    finally:
        advapi.CredFree(pointer)


def request(host: str, secret: str, auth_type: str, user: str, method: str,
            path: str, data: bytes | None = None,
            headers: dict[str, str] | None = None):
    url = f"http://{host}{path}"
    request_headers = dict(headers or {})

    def digest():
        manager = urllib.request.HTTPPasswordMgrWithDefaultRealm()
        manager.add_password(None, f"http://{host}", user, secret)
        opener = urllib.request.build_opener(
            urllib.request.HTTPDigestAuthHandler(manager))
        req = urllib.request.Request(url, data=data, method=method,
                                     headers=request_headers)
        try:
            with opener.open(req, timeout=60) as response:
                return response.status, response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode("utf-8", "replace")

    if auth_type == "user":
        return digest()

    request_headers["X-Api-Key"] = secret
    req = urllib.request.Request(url, data=data, method=method,
                                 headers=request_headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        if error.code == 401:
            return digest()  # compatibility with old --key-as-password usage
        return error.code, error.read().decode("utf-8", "replace")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("gcode", help="G-code file to send")
    p.add_argument("--physical-printer",
                   help="PrusaSlicer physical-printer profile name")
    p.add_argument("--host", help="printer IP or hostname")
    p.add_argument("--key", default=os.environ.get("PRUSALINK_API_KEY"),
                   help="PrusaLink API key (or env PRUSALINK_API_KEY)")
    p.add_argument("--password", default=os.environ.get("PRUSALINK_PASSWORD"),
                   help="digest password (or env PRUSALINK_PASSWORD)")
    p.add_argument("--user", help="digest username (default: profile or maker)")
    p.add_argument("--name", default=None,
                   help="remote filename (default: local name)")
    p.add_argument("--storage", default="usb",
                   help="target storage (default: usb)")
    p.add_argument("--go", action="store_true",
                   help="start printing after upload")
    a = p.parse_args()
    if a.key and a.password:
        raise SystemExit("choose either --key or --password")

    profile: dict[str, str] = {}
    if a.physical_printer:
        try:
            profile = physical_printer(a.physical_printer)
        except (OSError, ValueError) as error:
            raise SystemExit(f"cannot load physical printer: {error}")

    host = a.host or profile.get("print_host")
    if not host:
        raise SystemExit("no host: pass --host or --physical-printer")
    user = a.user or profile.get("printhost_user") or "maker"

    if a.password:
        secret, auth_type = a.password, "user"
    elif a.key:
        secret, auth_type = a.key, "key"
    elif profile:
        auth_type = ("user" if
                     profile.get("printhost_authorization_type") == "user"
                     else "key")
        field = "printhost_password" if auth_type == "user" else "printhost_apikey"
        secret = profile.get(field, "")
        if secret == "stored":
            target = (f"PrusaSlicer/PhysicalPrinter/{a.physical_printer}/"
                      f"{field}")
            try:
                saved = stored_credential(target)
            except OSError as error:
                raise SystemExit(f"cannot read stored credential: {error}")
            if saved:
                saved_user, secret = saved
                user = a.user or profile.get("printhost_user") or saved_user or "maker"
            else:
                secret = ""
    else:
        secret, auth_type = "", "user"

    if not secret and sys.stdin.isatty():
        secret = getpass(f"PrusaLink password for {user}@{host}: ")
        auth_type = "user"
    if not secret:
        raise SystemExit("no credential: configure the physical printer, pass "
                         "--key/--password, or set PRUSALINK_API_KEY/"
                         "PRUSALINK_PASSWORD")

    body = Path(a.gcode).read_bytes()
    expected_match = re.search(rb"(?m)^M862\.1\s+P([0-9]+(?:\.[0-9]+)?)", body)
    try:
        code, text = request(host, secret, auth_type, user,
                             "GET", "/api/version")
    except (urllib.error.URLError, OSError) as error:
        raise SystemExit(f"cannot preflight {host}: {error}")
    if code != 200:
        raise SystemExit(f"printer preflight failed ({code}): "
                         f"{text.strip()[:300]}")
    try:
        device = json.loads(text)
        actual_nozzle = float(device["nozzle_diameter"])
    except (json.JSONDecodeError, KeyError, TypeError, ValueError):
        actual_nozzle = None
    if expected_match and actual_nozzle is not None:
        expected_nozzle = float(expected_match.group(1))
        if abs(expected_nozzle - actual_nozzle) > 0.001:
            raise SystemExit(
                f"refusing upload: G-code requires a {expected_nozzle:g} mm "
                f"nozzle, but {host} reports {actual_nozzle:g} mm")
        print(f"  preflight: {actual_nozzle:g} mm nozzle matches G-code")
    name = a.name or Path(a.gcode).name
    if not name.lower().endswith((".gcode", ".bgcode", ".gco", ".g")):
        name += ".gcode"
    remote_path = f"/api/v1/files/{a.storage}/{quote(name)}"

    try:
        code, text = request(
            host, secret, auth_type, user, "PUT", remote_path, data=body,
            headers={"Content-Type": "application/octet-stream",
                     "Print-After-Upload": "?1" if a.go else "?0",
                     "Overwrite": "?1"})
    except (urllib.error.URLError, OSError) as error:
        raise SystemExit(f"cannot reach {host}: {error}")
    if code not in (200, 201, 204):
        raise SystemExit(f"upload failed ({code}): {text.strip()[:300]}")
    print(f"  uploaded {name} ({len(body)/1024:.1f} KB) to {a.storage} on {host}"
          + ("  — printing" if a.go else ""))

    code, text = request(host, secret, auth_type, user, "GET", remote_path)
    if code != 200:
        raise SystemExit(f"upload accepted but verification failed ({code}): "
                         f"{text.strip()[:300]}")
    print(f"  verified {a.storage}/{name} on printer")

    try:
        code, text = request(host, secret, auth_type, user,
                             "GET", "/api/v1/status")
        if code == 200:
            status = json.loads(text).get("printer", {})
            print(f"  printer: {status.get('state', '?')}"
                  f"  nozzle {status.get('temp_nozzle', '?')}°C"
                  f"  bed {status.get('temp_bed', '?')}°C")
    except (json.JSONDecodeError, urllib.error.URLError, OSError):
        pass  # status is a courtesy, not part of the upload contract


if __name__ == "__main__":
    main()
