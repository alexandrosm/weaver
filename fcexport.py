#!/usr/bin/env python3
"""
fcexport.py -- FullControl adapter for the weaver engine.

All weave logic lives once, in engine.js. This adapter asks the engine for
its op stream and converts it to FullControl steps -- wanted only for the
interactive plot and FullControl's printer profiles. Plain printable G-code
needs no Python at all:

    bun engine.js --gcode swatch.gcode

Usage:
    python fcexport.py [config.json] [--out NAME] [--plot] [--printer NAME]
                       [-- <engine flags>]

    python fcexport.py --plot                        # defaults, plot view
    python fcexport.py loomwright_config.json --out swatch
    python fcexport.py --out tri -- --lattice triaxial --pitch 6.8

Requires: pip install fullcontrol, and bun or node on PATH.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE = HERE / "engine.js"


def engine_ops(config: str | None, extra: list[str]) -> dict:
    runtime = shutil.which("bun") or shutil.which("node")
    if not runtime:
        raise SystemExit("fcexport.py needs bun or node on PATH")
    cmd = [runtime, str(ENGINE)]
    if config:
        cmd += ["--config", config]
    cmd += extra + ["--ops", "-"]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(out.stderr.strip() or f"engine exited {out.returncode}")
    return json.loads(out.stdout)


def build_steps(payload: dict):
    """Op stream -> FullControl steps. The only FullControl-aware code."""
    import fullcontrol as fc

    prm = payload["params"]
    bx, by = prm["bed"]
    steps = [
        fc.Printer(print_speed=prm["ps"], travel_speed=prm["ts"]),
        fc.ExtrusionGeometry(width=prm["sw"], height=prm["sh"]),
        fc.Extruder(on=False),
    ]
    last_f = None
    for op in payload["ops"]:
        kind = op["o"]
        if kind == "T":
            steps.append(fc.Extruder(on=False))
            steps.append(fc.Point(x=op["x"] + bx, y=op["y"] + by, z=op["z"]))
            steps.append(fc.Extruder(on=True))
        elif kind == "D":
            if op["f"] != last_f:
                steps.append(fc.Printer(print_speed=op["f"]))
                last_f = op["f"]
            steps.append(fc.Point(x=op["x"] + bx, y=op["y"] + by, z=op["z"]))
        else:
            steps.append(fc.StationaryExtrusion(volume=op["v"], speed=prm["pspd"]))
    steps.append(fc.Extruder(on=False))
    return steps


def main() -> None:
    argv = sys.argv[1:]
    extra: list[str] = []
    if "--" in argv:
        cut = argv.index("--")
        argv, extra = argv[:cut], argv[cut + 1:]

    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("config", nargs="?", default=None,
                   help="parameter JSON from the app's Export config button")
    p.add_argument("--out", default=None, help="G-code name (FullControl emission)")
    p.add_argument("--plot", action="store_true", help="interactive plot view")
    p.add_argument("--printer", default="generic", help="FullControl printer profile")
    a = p.parse_args(argv)
    if not (a.out or a.plot):
        p.error("nothing to do: pass --out and/or --plot")

    payload = engine_ops(a.config, extra)

    try:
        import fullcontrol as fc
    except ImportError:
        raise SystemExit("fullcontrol not found -- pip install fullcontrol")

    steps = build_steps(payload)
    prm = payload["params"]
    init = {"extrusion_width": prm["sw"], "extrusion_height": prm["sh"],
            "nozzle_temp": prm["ht"], "bed_temp": prm["bt"],
            "fan_percent": prm["fan"], "print_speed": prm["ps"],
            "travel_speed": prm["ts"]}

    if a.out:
        name = a.out[:-6] if a.out.endswith(".gcode") else a.out
        fc.transform(steps, "gcode",
                     fc.GcodeControls(printer_name=a.printer, save_as=name,
                                      include_date=False,
                                      initialization_data=init))
        print(f"  wrote {name}.gcode  ({len(steps)} steps)")

    if a.plot:
        fc.transform(steps, "plot",
                     fc.PlotControls(color_type="print_sequence"))


if __name__ == "__main__":
    main()
