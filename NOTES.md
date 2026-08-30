# Printed woven textile — design notes

The weave engine exists once, in `engine.js`. The browser app
`loomwright.html` and the command line are two faces of that one file;
`fcexport.py` adapts its op stream to FullControl for the plot view and
printer profiles.

Nothing here has been printed. Every number in this document is computed
(`bun engine.js --check` guards the geometry invariants), but no filament has
been extruded. Read the **Verification status** section
before trusting anything.

---

## 1. What the object is

A single-ply printed textile with a true over-under interlace, produced on an
ordinary FDM machine using explicit toolpaths rather than a slicer.

The difficulty is that a woven thread undulates continuously — over, under,
over — and an FDM nozzle cannot pass beneath material it has already laid. A
continuously undulating warp forms arches roughly 2 mm long with about 0.3 mm of
air beneath them, and a later weft would have to travel under one. The nozzle is
about a millimetre wide that close to the tip. It doesn't fit.

The workaround is to split each thread across two z levels joined by vertical
posts:

```
   z3  ─────────────                ─────────────      high dash (bridges)
              │      ╲            ╱      │
   post       █       ╲          ╱       █             extrude-in-place post
              │        ────────         │
   z1  ───────┴──────                ──┴───────        low dash (on the bed)
              ▲                          ▲
          transition                 transition
```

Warp and weft do this out of phase, so at every interlaced crossing one thread
is high and the other low. That is a genuine over-under interlace.

The crossings are deliberately **not fused**. The high dash bridges over the low
one with an air gap, held in place by the topology of the interlace rather than
by a weld. That is what lets the cloth shear and drape instead of behaving as a
welded grid.

---

## 2. Geometry specification

### 2.1 Lattice

A lattice is a set of families of parallel lines. Each family has a unit normal
`n`, a unit direction `d`, and a phase. Line *k* of a family is the locus of
points where `n · p = (k + phase) × pitch`.

**Biaxial** — two families:

| family | normal | direction | phase | role |
|---|---|---|---|---|
| 0 | (0, 1) | (1, 0) | 0 | weft, index *j* |
| 1 | (1, 0) | (0, 1) | 0 | warp, index *i* |

**Triaxial** — three families at 60°:

| family | normal | direction | phase |
|---|---|---|---|
| 0 | (0, 1) | (1, 0) | 0 |
| 1 | (−√3/2, 1/2) | (1/2, √3/2) | 0 |
| 2 | (−√3/2, −1/2) | (1/2, −√3/2) | **1/2** |

The half-pitch phase on family 2 is load-bearing. Without it, three threads meet
at single points, which would need three z levels (z1/z3/z5) and break the whole
scheme. With offsets *a*, *b*, *c* on families 0, 1, 2, the three lines are
concurrent exactly when `a = b − c`. Since `a, b ∈ pℤ` and `c ∈ pℤ + p/2`, we get
`b − c ≡ p/2 (mod p)` while `a ≡ 0`, so concurrency never occurs. Every crossing
is strictly pairwise.

Note this makes the implemented triaxial a **variant** of the classical one. Dow's
patent describes the warp as sandwiched between both weft sets at every
intersection — i.e. genuine triple points. That structure is not printable in two
levels. The version here is self-consistent and weaves correctly, but it is not
the documented loom weave.

### 2.2 Which thread is on top

**Biaxial** — a lift rule `f(i, j) → bool`, true when warp is over weft:

| pattern | rule | max float |
|---|---|---|
| plain | `(i + j) mod 2 == 0` | 1 |
| 2/2 twill | `(j − i) mod 4 < 2` | 2 |
| crepe | 8×8 lookup table | 3 |
| satin | `(j − 2i) mod 5 ≠ 0` | 4 |
| custom | arbitrary N×N bitmap | — |

The lift rule is *just a lookup*. On a loom, arbitrary per-thread control is what
a jacquard head is for and costs thousands of independently actuated hooks. Here
it costs nothing, which is why the app exposes an editable grid.

**Triaxial** — a cyclic rule instead: A over B, B over C, C over A. This is the
rock-paper-scissors arrangement, impossible for rigid bars but fine for threads
that undulate. It gives every thread a perfect alternating over/under sequence
with no bookkeeping at all.

### 2.3 From crossings to dashes

For each line:

1. Intersect with every line of every other family; keep intersections inside
   the swatch. Each carries a boolean: is this line the upper one here?
2. Sort by parameter *t* along the line.
3. Group consecutive crossings with the same state into **runs**. A run is a
   float — a stretch where the thread stays at one level.
4. Emit one **dash** per run, spanning from the midpoint before the run's first
   crossing to the midpoint after its last.
5. Emit a **post** at each internal boundary between runs.

So a plain-weave dash spans one pitch and carries one crossing; a twill dash
spans two. Posts land midway between crossings, which is why warp posts and weft
posts never contend for the same location.

### 2.4 The z stack

With layer height *h*, strand width *w*, button height *H*, button diameter *D*:

```
low strand centre     h/2
post                  0 → H
high strand centre    H + h/2
high strand underside H + h − d_free,  where d_free = √(4wh/π)
vertical gap          H − d_free
```

`d_free` is the diameter of the free-air strand: a bridge is not squished
against anything, so it comes out round rather than flattened. At w = 0.4,
h = 0.2 that is 0.32 mm, not 0.2. Getting this wrong overstates the gap by
120 µm, which matters because the whole budget is a few hundred microns.

The table above is centreline geometry. **Emitted G-code uses nozzle-tip
coordinates with the tip at the top of each feature**: low dashes at z = *h*,
every post grown to *H*, bridges at *H* + *h*. An earlier
version emitted centreline z — half a layer low everywhere — which doubled the
first-layer squish and made pass-1 posts stand *H* proud of the pass-1 tip
plane instead of the modelled *H* − *h*. See §7.10.

### 2.5 Offset dashes (the stretch mechanism)

Optional. Each dash runs from −*o* to +*o* laterally (`o = 0.4D` by default), so
consecutive dashes meet on **opposite sides** of the post and the chord across
the post becomes the return leg of a sawtooth.

```
      ╲              ╱ ╲              ╱        dash slants one way
  ─────█────────────█───█────────────█─────
        ╲__________╱                           post chord returns
```

Available extension:

```
stretch = (√(L² + 4o²) + 2o) / L − 1
```

where *L* is the mean dash span. At L = 3, D = 1.2 that is about 37%, and **most
of it is the chord, not the slant** — the pure zigzag with no chord is worth
about 8%. An earlier implementation alternated the slant direction so that
consecutive dashes met on the *same* side of the post, which produced a
convincing-looking zigzag that stored almost nothing. If you refactor this, that
is the bug to avoid.

The button ends up doing four jobs at once: mass, shortened bridge span, stored
extension, and — in triaxial — shear compliance. It is the single most
consequential parameter in the design.

---

## 3. Toolpath

Two passes, travelling in **opposite directions** along each thread.

- **Pass 1** prints the low dashes. At each dash's travel-end it grows a post
  from the bed up to z3, moving laterally across the post as it rises (that
  lateral move is the sawtooth chord).
- **Pass 2** prints the high dashes, travelling the other way. At its
  travel-start it descends to the bed and grows its own post upward, then
  bridges back and lands on the post pass 1 already built.

Because the passes run opposite ways, they claim **disjoint sets of posts**.
Every transition gets built exactly once and no separate post pass is needed.

The invariant that makes this general: **the post always sits at the dash's
pass-1 travel end**, whichever direction pass 1 happens to run on that thread.
That is what allows serpentining alternate threads, which cut estimated travel
from 43% to 31% of print time.

Two ordering constraints are load-bearing and easy to destroy. Post
disjointness comes from per-dash orientation, so it survives reordering — but
z-safety does not: pass-2 travels descend to bed level through the field, and
they only avoid printed bridges because the reverse sweep keeps the region
ahead of the nozzle unprinted. Any dash reordering (the Phase-2
nearest-neighbour idea) must either preserve a clean sweep front or hop
travels above *H* + *h*, which eats into the savings.

### Why posts are cheap

The nozzle has to decelerate to zero at every dash end anyway. Folding the post
into that stop means its marginal cost is only the dwell, not a full
travel-decelerate-dwell-accelerate cycle. FullControl's `StationaryExtrusion`
does exactly this — the emitted G-code alternates `G1 F300 E0.088` with short
rising moves.

There is a nice second-order benefit: corner artifacts and pressure-advance
overshoot land *inside* a feature whose job is to be a blob. Square corner
velocity can go up and PA can dump into the post.

### Joint asymmetry (unresolved)

Pass 2's posts are the good joints: it descends and grows a post directly on top
of an existing z1 dash end, full footprint, warm substrate. Pass 1's posts are
weaker — pass 2's bridge *terminates* onto them, so a 0.34 mm strand end lands on
a 1.2 mm disc.

The `overshoot` parameter is the cheap mitigation: pass 2 runs past the post
centre so the strand lies across the full disc rather than clipping its edge.

Both post kinds stop at *H*, matching the z stack in §2.4. The bridge leaves
its origin post through a short climb — the tip rising *h* over roughly the
button radius, so the ramp stays local and the span stays level — and lands
on the far post by draping onto its top from *h* above. Overshoot is skipped
at free thread ends — there is nothing to land on there.

A "split post" idea — each pass building half — was considered and **does not
work**. The two halves would have to meet at one z, but the dashes arrive at
different z levels. It is recorded here so nobody re-derives it.

---

## 4. The four constraints

### 4.1 Nozzle clearance — usually the binding one

While pass 1 runs, the tip sits at z = *h*, so a post stands only (*H* − *h*)
proud of it. The outer cone at that height is

```
cone_width(H − h) = tip_flat + 2 (H − h) tan(cone_angle / 2)
```

and the requirement is

```
gap ≥ D/2 + cone_width(H − h)/2
```

where `gap` is the shortest distance from a low dash's centreline to a post that
is not one of its own endpoints. In plain biaxial that distance is **pitch/2**,
and the nearest post belongs to the perpendicular family — which is why the
figure is pattern-independent.

An earlier version measured the cone width at *H* above the **bed** rather than
above the tip. That overstates the cone and flatters the clearance by roughly
0.35 mm. The corrected floor for a 1.2 × 0.6 mm button on the default cone is
**3.4 mm pitch, not 2.8 mm**.

The cone angle is set by thermal mass and crash survival, not by the orifice.
Tecdia's kaika nozzles deliberately use a 120° included outer angle for tip
cushioning and heat capacity even at a 0.1 mm orifice — a fine nozzle is not
automatically a sharp one. Going finer helps because the *z stack* shrinks, so
(*H* − *h*) shrinks, not because the cone narrows. **Measure your nozzle.** The
defaults in the code are a guess.

Because every lattice distance scales linearly with pitch while the nozzle and
button do not, the pitch floor follows directly:

```
min_pitch = pitch × (D/2 + cone_width/2) / gap
```

That relation is what makes the app's feasibility map exact rather than sampled.

### 4.2 Bridge span

```
bridge = float_length × pitch − D
```

Long floats are the problem. Twill's 2-pitch float at 3.6 mm pitch is already
6.3 mm. Satin is dead on arrival at any useful pitch. Note that a bigger button
*shortens* the free span, which is one of the reasons D wants to be large.

### 4.3 Vertical gap

`H − d_free`, as above. Below roughly 0.08 mm expect the bridge to weld to the
strand underneath, which destroys the free-crossing property the whole design
depends on.

This couples to bed temperature in a way that is worth watching: bed heat is not
selective. Running the bed above Tg to help the posts weld also softens every z1
strand you want the bridges *not* to weld to. Sweep bed temperature and post
height as a 2D grid, not one at a time.

### 4.4 Stop count

Stops scale as **1/pitch²**. Going from 3.6 mm to 1.8 mm quadruples them. This is
the reason density is expensive and the reason stacking a second ply (2× cost for
the same coverage) beats halving the pitch (4× cost).

---

## 5. Verification status

**Verified by computation:**

- One engine serves the browser, the CLI, and FullControl export, so the
  browser G-code and the FullControl G-code describe the same toolpath by
  construction (the streams differ only in header lines and in FullControl
  omitting unchanged axes; both use the rectangle area model,
  `area = w × h`, `E = volume / (π × (1.75/2)²)`).
- `bun engine.js --check` verifies, across a sweep of configurations:
  exactly one high thread per crossing, post sites strictly pairwise
  distinct, a sane op stream, and finite metrics.
- The feasibility map's analytic model matches full geometry rebuilds to three
  decimals at sampled points.

**Modelled, not measured:**

- Print time, and the post/travel split. The time model assumes rest-to-rest
  triangular or trapezoidal moves at a single scalar acceleration. It says the
  print is travel-bound (27–35%) rather than dwell-bound (14–21%), which
  contradicts the initial expectation that buttons would dominate. Worth
  confirming with a stopwatch before acting on it.
- Nozzle cone geometry. Default is a guess.

**Assumed, with no evidence at all:**

- That the post bonds to the cold dash ends beneath it. **This is the entire load
  path.** If it fails, nothing else matters.
- That the crossings stay free.
- That bridges don't sag into the layer below.
- That a 0.44 mm crimp on a 3 mm pitch is enough interlace to lock rather than
  pull flat.
- Everything about two-ply. Ply 2's low dashes bridge over ply 1's structure
  rather than sitting on the bed, and the metrics only describe a single ply.

---

## 6. Reference numbers

Default nozzle (0.8 mm flat, 120° cone), 0.4 × 0.2 mm strand, 24 mm swatch.

| config | pitch | button | stops/cm² | bridge | clearance | min pitch |
|---|---|---|---|---|---|---|
| plain | 3.6 | 1.2 × 0.6 | 14.6 | 2.40 | +0.11 | 3.39 |
| 2/2 twill | 3.6 | 1.2 × 0.6 | 7.3 | 6.30 | +0.11 | 3.39 |
| 2/2 twill | 3.6 | 0.9 × 0.45 | 7.3 | 6.30 | +0.52 | 2.57 |
| crepe | 3.6 | 1.2 × 0.6 | 8.9 | 9.60 | +0.11 | 3.39 |
| triaxial | 5.4 | 1.2 × 0.6 | 14.9 | 1.92 | **−0.34** | 6.77 |

Triaxial has by far the shortest bridges and by far the worst clearance, because
transitions come every 0.577 × pitch along each thread and there are three
families. At matched areal coverage triaxial wants 1.5× the biaxial pitch but
*needs* 2×, which partly cancels its advantage.

---

## 7. Positions that were reversed during design

Recorded so they aren't re-derived. Each of these was believed and then found
wrong.

1. **Tall narrow posts beat wide flat ones.** True while the post sat at the
   crimp hinge. False once the post became the rigid node in the rotation
   mechanism — then wide wins on stored length, bridge span, mass, and stiffness
   contrast simultaneously.
2. **Long floats reduce stop count, so use twill or satin.** Half right. Floats
   cut transitions but lengthen bridges proportionally, and bridging is the
   tighter constraint. Plain is the default; twill is the considered trade.
3. **3/1 twill is a reasonable option.** It is strictly dominated by 2/2 twill:
   identical stop count, same total bridge length per unit area (4p either way),
   but concentrated into one risky 3-pitch span instead of two safe 2-pitch ones.
4. **Triaxial kills drape.** Wrong twice over. Drape is bending, not in-plane
   shear — triaxial hangs fine; what it limits is conformance to *double*
   curvature. And the "no inextensional mode" result assumes inextensible
   threads, which these are not. With the offset-dash mechanism, shear costs
   thread strain rather than being forbidden: ±15° of shear needs about 13% and
   the budget is around 37–47%.
5. **The fabric needs a selvedge frame or threads will slide out.** Probably not.
   For a thread to translate along its own axis, its z-transitions would have to
   pass through the crossing threads' transitions, which puts two highs at one
   crossing — geometrically impossible. That's an energy barrier, not a free
   slide. What survives is smaller: the outermost threads have crimp on one side
   only. (Their final dashes used to end free; edge grounding now anchors every
   boundary high run on a bed-fed post.)
6. **Split posts give a better joint.** Doesn't work; see §3.
7. **Nozzle clearance measured from the bed.** Wrong reference; see §4.1.
8. **Coverage is scale-invariant, so this can only ever be a scrim.** True
   in-plane, but stacking plies adds coverage in z, which the argument doesn't
   touch. Two plies offset by half a pitch take projected coverage from ~25% to
   ~45% at 2× cost, where halving the pitch would cost 4×.
9. **A fine nozzle is a sharp nozzle.** No; see §4.1.
10. **The two-engine cross-check proves the numbers are right.** It proves
    port fidelity, nothing more: both engines shared a half-layer z-emission
    offset (tip coordinates emitted at strand centreline instead of feature
    top) and matched each other to four decimals the whole time. Conventions
    must be checked against the physical machine, not against a second copy
    of the same assumption.
    (The second engine has since been removed; the check that remains,
    `--check`, asserts invariants rather than agreement.)

---

## 8. Roadmap

Ordered so each phase unblocks the next. Do not skip phase 0.

### Phase 0 — three swatches, about an hour

Everything downstream is conditional on these.

1. **Does the post bond?** Print 30 mm swatches, pull a thread. If the posts
   don't hold, the design fails and no parameter tuning saves it.
2. **Do the crossings stay free?** Same swatches at 1×, 1.5×, 2× button height.
   Flex in the hand. This is the cheapest test in the project.
3. **Dwell or travel?** Time a swatch, then time the identical G-code with the
   `StationaryExtrusion` lines stripped (posts will be undersized; doesn't
   matter). The delta tells you what fraction is dwell and settles whether motion
   tuning is worth attention.

### Phase 1 — calibrate the model against reality

- Measure the nozzle's tip flat and outer cone; put the real numbers into the
  app. Everything about the density ceiling depends on them.
- Bed temperature × post height as a 2D grid, not one at a time — the two push in
  opposite directions.
- Bridge speed against sag. High feedrate should keep bridges taut; find where it
  stops working. Feed the measured sag coefficient back into the preview's
  deposition model — the preview deliberately renders bridges straight until
  there is a number.

### Phase 2 — mechanisms

- Offset dashes: measure actual extension against the predicted ~37%.
- Material. PLA to validate geometry; then polypropylene, which is the real
  candidate — every post is now a living hinge and PP is the living-hinge
  material, with chain orientation running the right way for free from the
  extrusion direction. Note the bed-above-Tg bonding argument does **not**
  transfer to PP (Tg is subzero; bonding needs melt near 165 °C).
- Toolpath ordering. Travel is the largest single time component. Serpentine
  already helped; a nearest-neighbour or greedy tour over dash start points
  should help more. Constraint: reordering breaks the reverse-sweep z-safety
  (§3) unless travels hop above *H* + *h*.

### Phase 3 — structures

- **Selvedge U-turns.** Done, both halves (each default on). Edge grounding
  puts the "extra transition just inside each edge" on every boundary high
  run — a post at the run's existing end, fed by a ~step/4 low stub on the
  bed. Thread joining then draws the pass-1 inter-line hop on the bed
  instead of travelling it, as a half-circle arc bulging outward between
  adjacent free ends (sampled into short straight draws), so each family's
  low skeleton is one continuous thread and the fringe closes into a round
  woven selvedge. Corner ties finish the job: at each family transition the
  new chain's start is tied to the nearest loose chain endpoint, and the
  final end ties back to the last one — when the corners line up (they do
  for biaxial), the whole perimeter closes into a loop with no loose ends.
  The fold-in order means no neighbouring post exists yet
  when an arc is drawn, and the clearance envelope is untouched. O(n) extra
  posts against O(n²) in the field, as predicted.
- **Pile loops.** An arch springing from two posts and rising above the fabric.
  Cheapest route to bulk and softness, doesn't touch the in-plane structure.
  Terry, velvet and corduroy are all this.
- **Two-ply.** Half-pitch offset so ply 2 sits in ply 1's gaps. Tack spacing
  decides everything: welded everywhere gives stiffness ∝ (2t)³ ≈ 8×, free to
  slide gives 2t³ ≈ 2×. That factor of four is the difference between cloth and
  board.
- **Leno lanes.** Paired warps twisting around each other, locking the weft in a
  closed twist. Costs transitions, so use a few lanes every 10–15 threads rather
  than everywhere.

### Phase 4 — push density

- Fine nozzle. The floor scales with the z stack, roughly linearly, so a 0.1 mm
  nozzle with proportionally scaled buttons lands near 1 mm pitch — about 27
  threads/inch, canvas territory. Watch residence time: at 0.1 mm the filament
  sits in the melt zone for minutes rather than seconds, which makes material
  choice critical and a geared extruder essential.
- Crepe for resonance. Regular weaves make the head oscillate at v/pitch — around
  60 Hz at 1 mm pitch and 60 mm/s, right in most printers' resonance band, and a
  sustained periodic excitation is exactly what input shaping is worst at. A
  crepe's irregular float lengths spread that across a band. Speculative, but
  cheap insurance.
- Kalico per-axis acceleration. `limited_cartesian` / `limited_corexy` with
  `scale_xy_accel` on; without it `max_accel` still caps you. Optimal rotation is
  where `tan θ = a_y / a_x`, so 45° only when the axes match. Reverses for CoreXY.

---

## 9. Open questions

Things no amount of modelling will settle.

- Does a bond-contrast ratio actually exist — posts welding reliably while
  crossings stay free — or is there no temperature window that gives both?
- Is the crimp deep enough to lock, or does the fabric just pull flat under
  tension with the posts carrying everything?
- What does it feel like? Every argument here is about geometry and print time.
  Nothing predicts hand, drape, or sound.
- Does the unfused interlace survive handling, or do threads walk out over time
  despite the topological barrier?
- Is "densest true interlace, single extruder, no support" actually true? It
  looks defensible against DefeXtiles (finer periodicity but not a true
  interlace) and printed chainmail (fast, but ordinary sparse layers). Worth
  checking against current work rather than assuming.

---

## 10. Code map

### `engine.js`

The single source of truth — geometry, op stream, metrics, G-code text and
the report. DOM-free; runs as a plain browser script and as a CLI under bun
or node.

```
P                              all parameters (the app mutates this object live)
families(), liftRule()         lattice and pattern definition
highAt()                       who is on top at a crossing
buildLines(), crossings()      lattice construction
dashesForLine()                runs → dashes; sets the serpentine direction
dashPts(), postC()             plan-space geometry incl. the sawtooth offset
toolpath()                     the two-pass op stream ("T"/"D"/"S") + preview segs
metrics(), report()            the four constraints and the time model
gcode()                        op stream → printable G-code text
runCheck()                     geometry invariant suite (--check)
```

```bash
bun engine.js --report
bun engine.js --pattern plain --pitch 3.6 --gcode swatch.gcode
bun engine.js --draft figured.json --gcode figured.gcode   # custom lift plan
bun engine.js --json                                       # metrics for scripts
bun engine.js --check                                      # invariant suite
```

### `loomwright.html`

The app: UI only, engine loaded via `<script src="engine.js">`; works over
`file://`, no build step, no dependencies beyond a webfont. Live 3D preview —
fabric mode renders the deposited result under a volume-conservation
deposition model — flat w × h roads on support, round Ø√(4wh/π) strands in
free air, blob posts with base spread, profile-aware shading, cast shadows —
with contact-anchored drawing so exaggerated z never opens fake gaps at the
joints; toolpath mode shows the commanded tip
path — plus the feasibility map, constraint gauges, an editable lift plan,
and two outputs: G-code generated in-browser, or a parameter JSON
(`Export config`) that feeds the CLI and `fcexport.py`.

### `fcexport.py`

FullControl adapter: asks the engine for its op stream (via bun/node) and
converts it to FullControl steps for the interactive plot and printer
profiles. Plain G-code does not need it.

```bash
python fcexport.py --plot
python fcexport.py loomwright_config.json --out swatch
python fcexport.py --out tri -- --lattice triaxial --pitch 6.8
```

### `print.py`

PrusaLink uploader for Buddy printers (Core One, MK4, XL): PUT to
`/api/v1/files/<storage>/<name>` with X-Api-Key (digest fallback, user
"maker"), optional print-after-upload. The engine's `coreone` printer
profile emits the matching Buddy start sequence — model check, G28,
area-limited G29 via an M555 computed from the actual swatch bbox, purge
line — and centres the swatch on the Core One bed (125, 110).

```bash
bun engine.js --printer coreone --gcode swatch.gcode
python print.py swatch.gcode --host <printer-ip> --key <key> --go
```

### Where to extend

- **A new weave** is one function returning a boolean in `liftRule`, plus a
  pattern-selector entry — or just draw it: custom drafts are first-class
  (`--draft` / the Custom pattern).
- **A new lattice** is an entry in `families()` plus a branch in `highAt()`.
  Anything expressible as families of parallel lines with a pairwise
  over/under rule will work unmodified downstream.
- **Pile** would be a third pass emitting arcs between chosen post pairs. It
  doesn't touch the in-plane geometry at all.
- **Stuffer threads** (Bedford cord) would be a family that never lifts, with the
  crossing threads forced to float over its lane. A non-interlacing thread is the
  cheapest material in the system: one continuous straight extrusion, no
  transitions, no bridges, full speed.

---

## 11. Prior art and references

- **FullControl** — Andy Gleadall. The G-code library this targets.
  `StationaryExtrusion(volume, speed)` is the extrude-in-place primitive the
  posts are built from.
- **DefeXtiles** — Jack Forman, MIT Media Lab. Under-extrusion textiles; finer
  periodicity than this, but not a true over-under interlace.
- **Printed chainmail** — the speed baseline to beat. Fast precisely because it is
  ordinary sparse layers and needs none of this machinery.
- **Triaxial weaving** — N. F. Dow, 1969; commercialised by Barber-Colman, and
  produced today by Sakase Adtech and Gentex (Triax). Three yarn sets at 60°;
  around 50% the area density of a comparable biaxial fabric, ~33% porosity, and
  essentially no bias direction.
- **Kalico** — Klipper fork with `limited_cartesian` / `limited_corexy`
  kinematics providing per-axis acceleration limits.
- **kaika / kaikaFIN nozzles** — Tecdia. Orifices to 0.1 mm; note the deliberately
  blunt outer cone.
- **Weave structures generally** — leno, Bedford cord, honeycomb, huckaback,
  crepe, damask, lampas, and 3D orthogonal preforms were all considered. See §7
  and §8 for which survived contact with the constraints.
