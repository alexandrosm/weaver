# Printed woven textile — design notes

The weave engine exists once, in `engine.js`. The browser app
`index.html` and the command line are two faces of that one file;
`fcexport.py` adapts its op stream to FullControl for the plot view and
printer profiles.

Layered PLA and PP fabrics have now been printed; the PP construction was the
first to release without manual loosening. `bun engine.js --check` still guards
the computed geometry invariants. Read **Verification status** for the exact
boundary between physical evidence and modelling.

---

## 1. What the object is

A single-ply printed textile with a true over-under interlace, produced on an
ordinary FDM machine using explicit toolpaths rather than a slicer.

The difficulty is that a woven thread undulates continuously — over, under,
over — and an FDM nozzle cannot pass beneath material it has already laid. A
continuously undulating warp forms arches roughly 2 mm long with about 0.3 mm of
air beneath them, and a later weft would have to travel under one. The nozzle is
about a millimetre wide that close to the tip. It doesn't fit.

The workaround is to split each thread across two z levels and build every
transition from three fused bands:

```
   z3  ───────●────────                ───────●───────    high dash + top dot
              │                                │
   z2         █                                █          virtual-middle riser
              │                                │
   z1  ───────●────────                ───────●───────    low dash + bottom dot
              ▲                                ▲
          transition                       transition
```

Every dash owns a circular dot at both endpoints in its own deposition layer.
At an internal run boundary, one middle riser connects the low endpoint dot to
the high endpoint dot. The three bands fuse into one cylindrical-type button
without forcing either dash to build a blob across the other dash's z level.

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

**Triaxial** — three separate pair relationships share one two-level stack. The
canonical pairs are A→B, B→C, and C→A; reversing a query complements the result,
so exactly one thread is high at every crossing. With line indices *a* and *b*:

| pattern | canonical-pair rule | float sequence | purpose |
|---|---|---|---|
| cyclic 1/1 | first family always over the next | A/B/C all 1/1 | shortest bridges, most locking points |
| triaxial 2/2 | `(b − a) mod 2 == 0` | A/B/C all 2/2 | balanced drape with about half the risers |
| directional | parity rule differs across AB/BC/CA | A 1/1; B/C 2/2 | one locked axis, oriented with swatch rotation |

Directional uses `a mod 2 == 0` for A→B, `(a + b) mod 2 == 0` for
B→C, and `b mod 2 == 0` for C→A. This is deliberately functional rather than
decorative: it keeps every run at one or two crossings. The obvious mirrored
three-step diamond draft creates three-crossing runs; at viable triaxial pitches
that produces roughly 11 mm bridges, so it is not exposed as a printable mode.

### 2.3 From crossings to dashes

For each line:

1. Intersect with every line of every other family; keep intersections inside
   the swatch. Each carries a boolean: is this line the upper one here?
2. Sort by parameter *t* along the line.
3. Group consecutive crossings with the same state into **runs**. A run is a
   float — a stretch where the thread stays at one level.
4. Emit one **dash** per run, spanning from the midpoint before the run's first
   crossing to the midpoint after its last.
5. Give every dash a circular endpoint dot at both ends, deposited at that
   dash's own low or high z level.
6. Emit one **virtual-middle riser** at each internal boundary between runs.

In biaxial plain weave a dash spans one pitch and carries one crossing; a 2/2
twill dash spans two pitches. Triaxial crossings are `pitch / √3` apart, so its
cyclic dashes span one such interval. Triaxial 2/2 spans two; directional spans
one on family A and two on B/C. Risers remain at run boundaries and never
contend for the same location.

### 2.4 The z stack

With layer height *h*, strand width *w*, button height *H*, button diameter *D*:

```
low strand + dot layer       0 → h       centre h/2
virtual-middle riser         h → H
high strand + dot layer      H → H + h   centre H + h/2
high strand underside        H + h − d_free,  where d_free = √(4wh/π)
vertical gap                 H − d_free
```

`d_free` is the diameter of the free-air strand: a bridge is not squished
against anything, so it comes out round rather than flattened. At w = 0.4,
h = 0.2 that is 0.32 mm, not 0.2. Getting this wrong overstates the gap by
120 µm, which matters because the whole budget is a few hundred microns.

The table above is physical/centreline geometry. **Emitted G-code uses
nozzle-tip coordinates with the tip at the top of each deposited band**:
low dashes and their dots at z = *h*, middle risers ending at z = *H*, and
high dashes and their dots at z = *H* + *h*. The riser never consumes the top
layer; that layer belongs to the high dash. An earlier version emitted
centreline z — half a layer low everywhere — which doubled the first-layer
squish. See §7.10.

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

Two passes, travelling in **opposite directions** along each thread. Every dash
uses the same local grammar: endpoint dot, road, endpoint dot.

- **Pass 1** prints the low dashes and both bottom endpoint dots. When the
  dash owns its travel-end transition, its second dot continues upward only
  through the virtual-middle band, from z1 to z2 = *H*. With offset dashes,
  that rise still traverses the button and preserves the sawtooth return chord.
- **Pass 2** prints the high dashes in reverse. When a high dash owns its
  travel-start transition, the nozzle descends onto the bottom dot that pass 1
  already printed, grows the middle riser only to z2, climbs through the top
  layer, deposits its own top dot, then bridges back. At the landing end it
  deposits the second top dot before the optional overshoot.

Because the passes run opposite ways, they claim **disjoint sets of middle
risers**. Every transition gets one bottom dot, one riser, and one top dot;
no separate post pass and no duplicate riser are needed.

The invariant that makes this general: **the middle riser always sits at the
dash's pass-1 travel end**, whichever direction pass 1 happens to run on that
thread. That allows serpentining alternate threads, which cut estimated travel
from 43% to 31% of print time.

Two ordering constraints remain load-bearing. Riser disjointness comes from
per-dash orientation, so it survives reordering — but z-safety does not:
pass-2 travels descend to the low level through the field, and only avoid
printed bridges because the reverse sweep keeps the region ahead of the nozzle
unprinted. Any dash reordering must preserve a clean sweep front or hop above
*H* + *h*.

### Why endpoint buttons are cheap

The nozzle already decelerates to zero at every dash end. Folding a stationary
dot into that stop adds only extrusion dwell, not another
travel-decelerate-dwell-accelerate cycle. FullControl's
`StationaryExtrusion` is the corresponding primitive.

Corner artifacts and pressure-advance overshoot also land inside a feature
whose job is to hold extra material. Square corner velocity can go up and PA
can unload into the button.

### Layered joint — corrected from the PP print

The polypropylene swatch exposed the flaw in treating a node as one supplemental
blob: its two owners arrive at different z levels, and the old pass-2 grow
stretched the same nominal button volume through an extra layer while a landing
bridge supplied no matching top cap. That encourages asymmetric, non-cylindrical
nodes and leaves less same-level area for fusion.

The corrected node does **not** split one post into two equal halves. It assigns
each physical band to its natural owner: the low dash prints the bottom dot, one
owner prints the middle riser, and the high dash prints the top dot. Supplemental
volume is calculated per band after subtracting the road volume already passing
through it. The top landing dot is centred before overshoot, so overshoot still
lays the bridge across the node without pulling the cap off-centre.

This reverses the earlier rejection of split construction. Equal halves meeting
at one z would indeed fail; level-owned caps joined by a separate middle riser
do not require the dashes to arrive at the same z.

---

## 4. The four constraints

### 4.1 Nozzle clearance — usually the binding one

While pass 1 runs, the tip sits at z = *h*, so a middle riser stands only
(*H* − *h*) proud of it. The outer cone at that height is

```
cone_width(H − h) = tip_flat + 2 (H − h) tan(cone_angle / 2)
```

and the requirement is

```
gap ≥ D/2 + cone_width(H − h)/2
```

where `gap` is the shortest distance from a low dash's centreline to a middle
riser that is not one of its own endpoints. In plain biaxial that distance is
**pitch/2**, and the nearest riser belongs to the perpendicular family — which
is why the figure is pattern-independent.

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
selective. Running the bed hot enough to fuse the layered buttons also softens
every z1 strand you want the bridges *not* to weld to. Sweep bed temperature and
button height as a 2D grid, not one at a time.

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
  exactly one high thread per crossing, the declared 1/1 or 2/2 triaxial float
  sequences, riser sites strictly pairwise distinct, exactly two correctly
  placed level-owned endpoint dots per dash, a sane op stream, consistent
  stationary-volume accounting, and finite metrics.
- The feasibility map's analytic model matches full geometry rebuilds to three
  decimals at sampled points.

**Physically observed:**

- The matched 60 mm three-band PLA and PP fabrics both printed very well.
  The PP fabric released without manual loosening; the PLA fabric still needed
  loosening. This validates the bottom-dot / middle-riser / top-dot construction
  and makes PP the current preferred material/process combination.

**Modelled, not measured:**

- Print time, and the button/travel split. The time model assumes rest-to-rest
  triangular or trapezoidal moves at a single scalar acceleration. Endpoint
  dots deliberately move more time into stationary extrusion; confirm the
  estimate with a stopwatch before tuning motion around it.
- Nozzle cone geometry unless the configured tip flat and angle were measured.

**Changed after physical tests, not yet print-verified:**

- The closing corner tie now deposits its deferred endpoint dot over the weld
  before retracting, hiding the closure inside the button rather than on the
  curved road.
- The 192 mm rot90 MK4S PP field has been generated and launched, but its
  finished physical inspection is still pending.

**Still assumed:**

- That the crossings stay free.
- That bridges do not sag into the layer below.
- That the crimp is enough to lock rather than pull flat.
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

At pitch 6.8 mm with a 0.9 × 0.45 mm button and a 34 mm field, the three
printable triaxial modes separate the transition/bridge trade cleanly:

| triaxial mode | stops/cm² | longest bridge | clearance | dashes |
|---|---:|---:|---:|---:|
| cyclic 1/1 | 11.9 | 3.03 mm | +0.42 mm | 156 |
| 2/2 twill | 6.7 | 6.95 mm | +0.42 mm | 96 |
| directional A-lock | 8.5 | 6.95 mm | +0.42 mm | 116 |

These are computed comparisons, not print validation. The shared three-band
button construction has printed successfully, but no complete triaxial mode has
been physically validated; all three require small swatches.

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
   boundary high run on a bed-fed layered node.)
6. **Split construction cannot work because the levels differ.** Equal halves
   cannot; level-owned endpoint caps plus a separate middle riser can. The PP
   swatch forced this correction; see §3.
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

1. **Does the layered node bond?** Print 30 mm swatches, pull a thread, and
   inspect whether all three bands remain fused. If the nodes do not hold, the
   design fails and no parameter tuning saves it.
2. **Do the crossings stay free?** Same swatches at 1×, 1.5×, 2× button height.
   Flex in the hand. This is the cheapest test in the project.
3. **Dwell or travel?** Time a swatch, then time the identical G-code with the
   `StationaryExtrusion` lines stripped (buttons will be undersized; that is
   acceptable for this timing control). The delta settles whether motion tuning
   is worth attention.

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
- Material. PLA validates geometry; polypropylene is the real candidate —
  every layered node is a living hinge and PP is the living-hinge material,
  with chain orientation running the right way for free from the extrusion
  direction. The bed-above-Tg bonding argument does **not** transfer to PP
  (Tg is subzero; bonding needs melt near 165 °C).
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
  The open chain-start dot is now deferred until its closing corner tie reaches
  that endpoint. The tie terminates at the endpoint centre, then stationary dot
  extrusion buries the closure weld inside the button instead of leaving it on
  the curved road; dot count and endpoint volume remain unchanged.
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

- Does a bond-contrast ratio exist — layered nodes fusing reliably while
  crossings stay free — or is there no temperature window that gives both?
- Is the crimp deep enough to lock, or does the fabric just pull flat under
  tension with the layered nodes carrying everything?
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
printBounds()                  rotation-aware bed fit and probe margin
families(), liftRule()         lattice and biaxial pattern definition
triaxialPairHigh(), highAt()   triaxial pair rules and crossing ownership
buildLines(), crossings()      lattice construction
dashesForLine()                runs → dashes; sets the serpentine direction
dashPts(), postC()             plan-space geometry incl. the sawtooth offset
endpointDotVol(), riserVol()   volume-complete three-band button construction
toolpath()                     two-pass op stream + per-ply pass boundaries
metrics(), report()            geometry, bed, flow and time constraints
gcode()                        profiles + flow/fan/travel controls → G-code
runCheck()                     geometry and printer-profile invariant suite
```

```bash
bun engine.js --report
bun engine.js --pattern plain --pitch 3.6 --gcode swatch.gcode
bun engine.js --lattice triaxial --triaxial-pattern directional --report
bun engine.js --draft figured.json --gcode figured.gcode   # custom lift plan
bun engine.js --json                                       # metrics for scripts
bun engine.js --check                                      # invariant suite
```

### `index.html`

The app: UI only, engine loaded via `<script src="engine.js">`; works over
`file://`, no build step, no dependencies beyond a webfont. Live 3D preview —
fabric mode renders the deposited result under a volume-conservation
deposition model — flat w × h roads on support, round Ø√(4wh/π) strands in
free air, layered cylindrical buttons, profile-aware shading, and cast shadows
— with contact-anchored drawing so exaggerated z never opens fake gaps at the
joints; toolpath mode shows the commanded tip
path — plus the feasibility map, constraint gauges, editable biaxial lift plan,
three pairwise triaxial lift tiles, and complete print controls. The named
biaxial and triaxial pattern selectors are both always visible; the inactive
family is dimmed, and choosing any pattern activates its matching lattice.
Their independent settings persist without overloading semantics. The app
exposes square size, rotation, selected-bed fit, weave and
node dimensions, nozzle geometry, speeds, hop/retraction and its travel
threshold, global model flow, per-pass fan, temperature, and volumetric limit.
Generic, Core One PLA, and the physically successful MK4S PP profile are
selectable. It outputs G-code or the complete parameter JSON consumed by the
CLI and `fcexport.py`.

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
"maker"), optional print-after-upload. The engine owns two matching Buddy
profiles. `coreone` targets the device-authoritative 0.6 mm nozzle and PLA;
`mk4spp` targets the device-authoritative 0.5 mm nozzle and the successful
Fiberlogy PP envelope. Both centre the field, compute area-limited M555 probing
from the rotated square plus a two-pitch margin, and emit their own verified
startup/purge/shutdown sequence.

```bash
bun engine.js --printer coreone --gcode pla.gcode
bun engine.js --printer mk4spp --size 192 --rotate 90 --gcode pp.gcode
python print.py pp.gcode --host <printer-ip> --key <key> --go
```

### Where to extend

- **A new biaxial weave** is one function returning a boolean in `liftRule`,
  plus a biaxial selector entry — or just draw it: custom drafts are first-class
  (`--draft` / the Custom pattern).
- **A new triaxial weave** is a bounded pair rule in `triaxialPairHigh()`, a
  triaxial selector entry, and an asserted per-family float sequence in
  `runCheck()`.
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
