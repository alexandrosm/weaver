# weaver

## Overview

Parametric generator for 3D-printed woven textiles: a true over-under
interlace built from dashes on two z-levels joined by extrude-in-place posts.
Design rationale, constraints, verification status, and roadmap live in
`NOTES.md` — read it before touching geometry.

- `engine.js` — the single source of truth: geometry, op stream, metrics,
  G-code text, report. DOM-free; runs as a plain browser script and as a
  bun/node CLI.
- `loomwright.html` — the app. UI only; loads `engine.js`; works over
  `file://` with no build step.
- `fcexport.py` — FullControl adapter (interactive plot, printer profiles);
  consumes the engine's op stream. Plain G-code does not need it.

## Build & Test

- Build: none. Open `loomwright.html` in a browser.
- Test: `bun engine.js --check` — geometry invariant suite; must pass.
- Smoke: `bun engine.js --report` and `bun engine.js --gcode out.gcode`.

## Code Style

- `engine.js` stays DOM-free and dual-runtime (browser + bun/node); UI code
  belongs in `loomwright.html`, FullControl code in `fcexport.py`.
- All emitted z values are nozzle-tip heights with the tip at feature top
  (NOTES §2.4). Do not reintroduce centreline z.
- Dash ordering is load-bearing (reverse-sweep z-safety, NOTES §3); do not
  reorder passes without reading it.
- `loomwright.html` loads the engine as `engine.js?v=N`; bump `N` in the same
  commit as any `engine.js` change, or cached HTML can pair with a stale
  engine and break at runtime.

## Security Notes

- Generated G-code drives real hardware. Run `--report` and heed its
  warnings before printing an unfamiliar configuration.
