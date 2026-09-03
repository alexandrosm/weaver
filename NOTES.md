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

### Experimental topology compiler

The atlas contains seven **different structural classes**, not seven variants of
one weave. In the strict periodic sense, a weave is made from open threads whose
motif closes only on a thickened torus. A finite knot, a Brunnian link, and a
polycatenane sheet do not acquire textile identity merely because their
projections look woven. The UI and report therefore name the class before the
motif:

| study | structural class | diagram invariant | intended question |
|---|---|---|---|
| sinusoidal | Finite deformed biaxial weave | 6 × 6 open paths, 36 plain-parity crossings | does added centre-line arclength provide recoverable in-plane reserve? |
| annular | Finite annular weave | 4 closed circumferential rings × 8 open radial spokes, 32 alternating crossings | how does a fixed-count radial coupon expose density gradient and shear? |
| Celtic | Repeated closed-knot coupon | four disjoint trefoils, three self-crossings and determinant 3 each | can closed self-crossing components be printed without calling ornament a sheet? |
| figure-eight | Closed-braid knot coupon | closure of `(σ₁σ₂⁻¹)²`, one component, four self-crossings, determinant 5 (Knot Atlas 4_1) | can a braid word and its standard closure become one physical strand? |
| chainmail | Finite polycatenane network | staggered 3–4–3 patch, 10 rings, 12 Hopf-linked pairs, ring words {OUOU: 6, OOUU: 2, OOUOUUOU: 2} | do independently closed rings release as a mobile 4-in-1 network? |
| leno | Finite true-leno weave | 3 doup/skeleton pairs × 4 wefts; 24 warp–weft crossings plus 3 partner crossings per pair | can paired warps grip each pick without a mock-leno substitution? |
| Borromean | Brunnian link coupon | closure of `(σ₁σ₂⁻¹)³`, 3 components, determinant 16, pairwise linking zero, every pair splits (determinant 0) | does collective linkage survive while every two-component sublink remains trivial? |

Every registry entry carries an explicit design contract: structural class,
diagram identity, mechanical hypothesis, print strategy, principal unresolved
risk, one technical source, and machine-checkable facts. The facts cover
open/closed component counts, histograms of self- and pair-crossing counts,
alternation where claimed, pairwise linking-number magnitudes where those
distinguish the object, canonical ring words for chainmail, and Fox-colouring
determinants (`topoDeterminant`, exact BigInt Bareiss elimination on the
colouring matrix) for the whole diagram, per closed component, or per
interacting pair — the Borromean pair determinant of 0 is what certifies the
Brunnian split sublinks. `paths.length === components` is required: a
decorative closure stroke is not allowed to masquerade as part of a physical
component.

`topologyModel()` scales the sampled diagram into the requested coupon, maps
both branches of every crossing to arclength, and compiles **local overpass
windows**. A strand stays on the low plane except around a crossing it owns.
The window is curvature-aware and asymmetric (`topoWindow`). For crossing
angle *θ* the straight-strand estimate

```
c = D/2 + w/2 + 0.10 mm
half-window₀ = max(2w, 0.8 mm, c / max(sin θ, 0.10))
```

is only the starting point. Each side is then widened in 0.05 mm steps until
its transition site clears the under strand's **actual polyline** by *c* (for
a self-crossing, the strand's own road beyond 2·D of arclength). The start
and each side are capped at 38% of the arclength to the nearest other
crossing or open end, so one overpass never swallows the next crossing. A
capped side that still fails is not hidden: the button / road margin metric
below reports it, and the report separately exposes the remaining crossing
interval, so a dense diagram fails visibly rather than silently merging
windows.

Exactly two transition risers bracket each high run. There are **no**
bed-founded, sacrificial, or spacing-driven helper posts. Such a prop would weld
an extra edge from a strand to the bed-founded network and change the topology
being studied. This reverses the earlier generic “maximum support spacing”
scheme. Long unsupported spans now remain honest measurements and warnings.

The operation order is deliberately conservative:

1. deposit every low curve and its level-owned endpoint buttons;
2. grow every topology-owned transition riser from the low plane;
3. deposit every local high overpass and its high-level endpoint buttons.

Every disconnected move is one lifted travel op — a `T` carrying `hop`, the
safe height z3 + max(z-hop, layer height, 0.2 mm), above the full z stack.
`gcode()` expands it as retract → lift → XY → lower → prime, the order the
production profiles were verified with, and always retracts a lifted hop
regardless of the retract-minimum distance: every hop crosses deposited
strands. `fcexport.py` expands the same op into lift / cross / lower points.
A pure z change at one XY stays a plain travel. The scheduler does not rely
on the straight lattice's reverse-sweep front. The same `T`, `D`, and `S`
operation grammar feeds browser rendering, plain G-code, and FullControl.

Experimental **post clearance** is the §4.1 quantity with the lattice
removed: the closest spacing between any two transition risers, minus D/2,
minus the nozzle cone half-width at (*H* − *h*) above the tip. The
road-to-riser case of §4.1 cannot occur here — every low road is printed
before any riser exists, and while a riser grows from the low plane the only
things standing proud of the tip are neighbouring finished risers, at most
(*H* − *h*) tall. Riser-to-road contact in plan is a welding question, not a
nozzle-collision one, and belongs to the next metric.

The **button / road margin** (`button_road_margin_mm`, `buttonClear`) is that
weld check. Every transition riser and every open-strand endpoint button is a
D-wide dot on the plane of the road it terminates. The metric is the minimum,
over all of them, of (distance to any road of a foreign strand, or of its own
strand beyond 2·D of arclength) − (D/2 + w/2), and of (distance to any other
button) − D. Negative means contact — the accidental weld the contracts
forbid. Report and app warn below 0.10 mm and flag an error below zero;
`--check` requires at least 0.10 mm at every checked default on the generic,
Core One, and MK4S profiles.

Experimental coupons are **single-ply by contract**. Pitch, overshoot,
offset, selvedge, tack, and ply-gap controls belong to the straight-family
grammar; the app disables them and the engine rejects `plies != 1` instead of
inventing an unvalidated cross-topology stacking rule. A checked atlas default
also applies the reference 0.90 mm button and 0.40 mm strand width; button
height is the larger of 0.45 mm and free-strand diameter + 0.13 mm at the
active layer height, rounded **up** to 0.01 mm (0.45 mm at 0.20 mm layers,
0.61 mm at 0.45 mm layers), and the REFERENCE GEOMETRY warning fires on any
departure beyond 1e-6. This prevents a Core One or MK4S output profile from
silently donating its much larger straight-weave button to an experimental
coupon. The experimental report adds non-crossing road separation, button /
road margin, minimum bend radius, crossing interval, open-path reserve,
reference geometry, and recommended coupon size. Parameter edits remain
allowed, but the report identifies departure from the checked geometry and
evaluates the resulting toolpath on its actual dimensions.

Maturity is stated as three separate facts: diagram contract checked, toolpath
invariants checked, physical print pending. The app, report, G-code header,
CLI, and atlas carry the **EXPERIMENTAL** label, and the saved configuration
carries the topology id, until a real coupon has been printed, released, and
inspected. Experimental means a known validation boundary, not missing code
and not evidence of physical success.

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
- `bun engine.js --check` builds all seven experimental studies at their
  checked defaults (generic profile) and asserts, per study:
  - **Diagram contract** — physical path count equals the declared component
    count; open/closed counts; self- and pair-crossing histograms; the
    declared alternating word; pairwise linking-number magnitudes where
    declared; canonical ring words (chainmail `{OUOU: 6, OOUU: 2,
    OOUOUUOU: 2}`); Fox-colouring determinants — braid 5, Borromean 16,
    3 per Celtic component, 2 per Hopf-linked chainmail pair, 0 per Borromean
    pair; the expected crossing count; an `https://` source; finite strands
    and crossings.
  - **Run assignment** — every crossing branch lands on a run of its declared
    low/high level; every high run is bracketed by two distinct
    topology-owned transition risers; transition-site count equals riser
    count equals the risers the toolpath grew.
  - **Op stream** — exactly two pass markers; the stream opens with a travel;
    every op is `T`/`D`/`S` with finite coordinates or positive volume; every
    horizontal travel carries a `hop` at z3 + max(z-hop, layer height,
    0.2 mm); travel and retract counts both equal the number of lifted hops;
    endpoint dots are two per run minus closed-run seams; riser pulses equal
    risers × post-steps; the sum of `S` volumes equals the stationary total;
    all metrics finite.
  - **Bounds at the checked default** — post clearance, unrelated road gap,
    and button / road margin all ≥ 0.10 mm; bend radius ≥ one strand width;
    crossing interval ≥ D + w; free bridge span ≤ 4.5 mm; vertical gap
    ≥ 0.13 mm; the coupon fits the bed margin.
  - **Labels** — the G-code header carries `EXPERIMENTAL — <title>`,
    `class: <contract.kind>`, and the transition-only-risers design line; the
    report opens with `EXPERIMENTAL / <title>`.
  - Multi-ply input is rejected with the single-ply error (asserted once, on
    the first study). A build that throws is a FAIL line, not a crash.
- The same stream, bound, and accounting assertions are repeated with every
  study rebuilt under the Core One PLA and MK4S PP profiles (their layer
  height, speeds, and bed), and the printer G-code is additionally checked for
  the lifted-travel contract: retract → lift → XY → lower → prime, one
  retract and one prime per lifted hop.

One-time manual check, not part of the suite: the feasibility map's analytic
model matched full geometry rebuilds to three decimals at sampled points.

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

- That every experimental crossing releases rather than welding. A correct
  diagram and collision-free commanded path cannot establish physical freedom.
- That each experimental bridge stays above the lower road; the longest is
  now the 2.36 mm sinusoidal overpass.
- That the proposed mechanisms survive handling: sinusoidal reserve may become
  slip, leno buttons may become rigid locks, and chainmail contacts may weld.
- That straight-family crimp is enough to lock rather than pull flat.
- Everything about straight-family two-ply. Experimental topologies reject
  multi-ply outright; they do not inherit this assumption.

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

The experimental defaults below are computational envelopes for the reference
0.90 mm button, 0.40 mm strand, 0.20 mm layer, 0.45 mm button height, and
generic 0.8 mm-flat / 120° nozzle model. They are not successful-print claims.
The atlas preserves the selected output profile's layer height and re-derives
the reference button height for it — the larger of 0.45 mm and free-strand
diameter + 0.13 mm, rounded up to 0.01 mm: 0.45 mm at 0.20 mm layers, 0.61 mm
at the Core One and MK4S profiles' 0.45 mm layers. Large defaults, especially
chainmail, are intentional: shrinking a diagram while holding nozzle and
button dimensions fixed collapses post, road, and button clearance. The
sinusoidal default moved from 30 to 32 mm because at 30 mm the capped
overpass windows left only 0.05 mm of button / road margin.

| study | default size | crossings | risers | longest bridge | post clearance | unrelated road gap | button / road margin | min bend radius |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| sinusoidal | 32 mm | 36 | 72 | 2.36 mm | +0.30 mm | +0.32 mm | +0.10 mm | 3.18 mm |
| annular | 48 mm | 32 | 64 | 0.70 mm | +0.28 mm | +0.38 mm | +0.11 mm | 7.69 mm |
| Celtic trefoils | 24 mm | 12 | 24 | 0.70 mm | +0.31 mm | +0.38 mm | +0.11 mm | 1.84 mm |
| figure-eight braid | 26 mm | 4 | 8 | 0.70 mm | +0.32 mm | +0.36 mm | +0.14 mm | 1.27 mm |
| European 4-in-1 | 96 mm | 24 | 48 | 1.05 mm | +0.27 mm | +0.38 mm | +0.10 mm | 7.02 mm |
| true leno | 28 mm | 33 | 66 | 0.70 mm | +0.29 mm | +0.45 mm | +0.14 mm | 2.32 mm |
| Borromean | 34 mm | 6 | 12 | 0.81 mm | +0.43 mm | +0.46 mm | +0.10 mm | 0.83 mm |

The longest experimental bridge is now the 2.36 mm sinusoidal overpass. The
braid and Borromean diagrams were rebuilt with full-step cosine strand swaps
(steeper crossings, slots at ±0.26) and closure lanes of straight runs plus
concentric constant-radius arcs (innermost radius 0.10, lane spacing 0.06 in
diagram units), which removed their long shallow overpasses and their
sub-strand-width bend radii.

Unrelated road gap is the closest plan approach between two road segments
minus one strand width. It skips the intentional projection overlap around a
crossing while its owning branch is physically high, and it skips two segments
of the same strand whose arclength intervals are less than max(2D, 4w) apart
— an interval test, so a tight bend is never counted as a self-approach.
Minimum bend radius covers those excluded local neighbours. Transition risers
and open-strand endpoint buttons are not roads; their plan separation from
roads and from each other is the button / road margin column.

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
11. **Every atlas card can share one “experimental weave” story.** False.
    Sinusoidal and annular coupons are finite weaves; trefoils and the
    figure-eight are knots; Borromean is a Brunnian link; chainmail is a
    polycatenane network. Structural class and invariant now precede styling.
12. **Long high runs can be made printable with generic bed-founded supports.**
    Printable, perhaps; topology-preserving, no. Every such prop adds a welded
    connection to the bed-founded network. High geometry is now localized at
    the crossing angle and receives transition risers only; excessive spans
    remain warnings.
13. **A braid path plus separately drawn closure curves is a closed braid.**
    False in the emitted object. Coincident endpoints produced duplicate seam
    material while the physical path list still contained disconnected
    strokes. Standard closure lanes are now merged into the actual component
    cycles before crossings or runs are computed.
14. **The straight-family ply and pitch controls generalize automatically.**
    False. Pitch became an undocumented support-spacing knob and stacked
    topology coupons had no defined component relation. Those controls are
    disabled in the experimental UI, and the engine rejects experimental
    multi-ply input.

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
warnings()                     dispatches to the straight or topology warning list
gcode()                        profiles + flow/fan/travel controls → G-code; expands `hop` travels
topologyStudies()              seven sourced diagrams + design/verification contracts
topoDiagramFacts()             component, crossing, alternation, linking, and ring-word profiles
topoDeterminant()              Fox-colouring determinant of a path subset (BigInt Bareiss)
topoPolylineDistance()         point-to-strand distance with an own-arclength exclusion
topoWindow()                   curvature-aware asymmetric overpass window for one crossing
topologyModel()                local overpass windows + transition-only risers
topoGeometryQuality()          road gap, button / road margin, bend radius, crossing interval, path reserve
topologyToolpath()             conservative low / transition / high op scheduler; one `hop` op per travel
topologyMetrics(), topologyReport() experimental constraints and design dossier
topologyWarnings()             experimental warning block (EXPERIMENTAL, scale, reference, clearances, flow)
runCheck()                     production + seven-topology + printer-profile suite
```

```bash
bun engine.js --report
bun engine.js --pattern plain --pitch 3.6 --gcode swatch.gcode
bun engine.js --lattice triaxial --triaxial-pattern directional --report
bun engine.js --topology chainmail --size 96 --report
bun engine.js --topology borromean --size 34 --gcode borromean.gcode
bun engine.js --draft figured.json --gcode figured.gcode   # custom lift plan
bun engine.js --json                                       # metrics for scripts
bun engine.js --check                                      # invariant suite
```

CLI flags are parsed first and applied in a fixed order: printer profile →
`--config` → the checked atlas default for an experimental `--topology` (only
the keys nothing else set) → explicit flags. `--printer` may therefore appear
anywhere on the line; flag order never matters. `--gcode` and `--ops` without
`--report` still print the warning block to stderr. Validation exits via
`die()`: size must be positive, plies an integer ≥ 1 (and exactly 1 for an
experimental topology), post-steps an integer ≥ 1, every speed and the
acceleration positive; a build error is reported as a message, not a stack
trace.

### `index.html`

The app: UI only, engine loaded via `<script src="engine.js?v=N">`; works over
`file://`, no build step, no dependencies beyond a webfont. The workspace uses
a general slicer split: the left rail owns weave structure, dimensions,
mechanisms, lift plan, and design space; the centre owns the live fabric or
toolpath preview; the right rail owns the output profile, build plate, nozzle
and bead, material, motion, printability, and generated G-code.

Fabric mode renders the deposited result under a volume-conservation model —
flat w × h roads on support, round Ø√(4wh/π) strands in free air, layered
cylindrical buttons, profile-aware shading, and cast shadows — with
contact-anchored drawing so exaggerated z never opens fake gaps at the joints.
Toolpath mode shows the commanded tip path. Knot atlas mode compares and
selects seven engine-owned experimental geometries: sinusoidal biaxial,
annular, repeated Celtic trefoils, a figure-eight braid closure, European
four-in-one chainmail, true leno, and Borromean rings. The atlas explicitly
separates finite weaves, knots, and links. Each card exposes its invariant,
mechanical hypothesis, print strategy, risk, technical source, physical
component boundary, and computationally checked default size.

Selecting a card applies that study's checked single-ply size, 0.90 mm button,
0.40 mm strand, and layer-height-adapted button height, then rebuilds the
complete op stream. Entering the atlas snapshots the straight design (button
diameter and height, strand width, size, plies); choosing a biaxial/triaxial
structure or pattern restores it, while a production preset replaces it and
drops the snapshot. The left rail replaces the inapplicable lift-plan and
straight design-space panels with the same source-grounded dossier; pitch,
overshoot, offset, selvedge, tack, and ply controls are disabled rather than
repurposed. Reference strings come from the engine's `TOPOLOGY_REFERENCE`.
The report rail adds topology-specific post-clearance, nonlocal road-gap,
button / road margin, curvature, crossing-interval, reserve, and reference
geometry facts; each gauge's colour bands use the same thresholds as its flag
(amber below 0.10 mm, red below zero). Fabric, Toolpath, Generate, Download,
configuration, CLI, and FullControl routes remain available, the download
filename carries `EXPERIMENTAL_`, and the EXPERIMENTAL badge and
physical-validation warning remain visible. Choosing a biaxial/triaxial
structure or production preset returns to the straight-family engine and
restores those controls.

Output profiles now identify printer, filament, and nozzle separately in the
right rail. Generic, the verified Core One 0.6 / Prusament PLA setup, and the
physically successful MK4S 0.5 / Fiberlogy PP setup remain the supported
bundles. Selecting an output profile applies its bed, bead, nozzle, material,
and process settings without replacing the weave's lattice, pattern, pitch,
button geometry, mechanisms, size, or rotation — except that an experimental
coupon sitting at the reference button height gets that height re-derived for
the new layer height. Generic leaves the process values editable for a custom
machine. The app outputs G-code or the complete parameter JSON consumed by the
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
`mk4spp` targets the device-authoritative 0.5 mm nozzle and the physically
successful Fiberlogy PP envelope. Production weaves centre the field, which
is a square of `size` or, with `sizeY` > 0 (`--size-y`, the app's Depth
control), a `size × sizeY` rectangle; the M555 probe window is the rotated
field's bounding box plus a two-pitch margin, and bed fit is checked per axis.
The app's *Fill selected bed* action sets rotation 0 and the largest
rectangle the margin allows (250 × 210 mm MK4S at pitch 3.75 mm → 235 × 195).
Experimental topology coupons stay square and use a button-envelope margin.
Each profile emits its verified startup/purge/shutdown sequence.

```bash
bun engine.js --printer coreone --gcode pla.gcode
bun engine.js --printer mk4spp --size 192 --rotate 90 --gcode pp.gcode
bun engine.js --printer mk4spp --size 235 --size-y 195 --rotate 0 --gcode pp_full.gcode
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
- **A new curved/link topology** belongs in `topologyStudies()`. It needs
  sampled open or closed physical components, robust intersections, explicit
  branch ownership, `paths.length === components`, a recommended safe coupon
  size, and a complete contract (`kind`, `identity`, `mechanism`, `strategy`,
  `risk`, `source`, `verify`). `verify` must assert the component boundary and
  crossing histograms; add alternation, pairwise linking profiles, ring
  `words`, and `determinant` / `componentDeterminant` / `pairDeterminant`
  whenever they are part of the claimed identity. The generic local-overpass
  compiler, transition-only scheduler, quality metrics, browser, CLI, G-code,
  and FullControl routes then apply. Do not add foundation props or infer
  multi-ply.
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
- **Periodic-weave taxonomy** — Sonia Mahmoudi, *On the classification of
  periodic weaves and universal cover of links in thickened surfaces*,
  <https://arxiv.org/html/2009.13896>. The open-thread/thickened-torus
  definition is why knot and link coupons are not labelled periodic weaves.
- **Textile topology and mechanics** — Dresselhaus et al., *Textiles: from
  twisted yarn to topology and mechanics*,
  <https://arxiv.org/html/2604.09005v1>. Grounds centre-curve, curvature,
  topology-under-smooth-deformation, crimp, and shear language.
- **Annular weaving** — Chen and Guo, analysis of shear deformation in annular
  woven fabrics, <https://doi.org/10.4028/www.scientific.net/AMR.331.198>.
  Production annular cloth uses unequal picks and shear; this fixed-count
  coupon deliberately exposes rather than solves the density gradient.
- **Figure-eight knot** — Knot Atlas, *4_1*, <https://katlas.org/wiki/4_1>.
  Source of the braid coupon: minimum braid `BR(3,{-1,2,-1,2})`, determinant
  5. The engine's generator convention is the mirror of Rolfsen's tutorial
  (*Tutorial on the braid groups*, <https://arxiv.org/html/1010.4051>), which
  is harmless because both shipped words are amphichiral; Rolfsen's standard
  closure — connecting braid endpoints without new braid interactions — is
  still the closure construction, realised as straight runs plus concentric
  constant-radius arcs.
- **Celtic and alternating knots** — University of Edinburgh, *Celtic Knot
  Theory* (Connor and Ward),
  <https://webhomes.maths.ed.ac.uk/~v1ranick/knots/celtic.pdf>. Used to keep
  ornamental alternating knot claims separate from textile-sheet claims.
- **European 4-in-1 geometry** — Alexander R. Klotz, *Geometric considerations
  for energy minimization of topological links and chainmail networks*,
  <https://arxiv.org/html/2507.20903#S4>. Grounds the staggered square network,
  row-alternating ring tilt, valence four, and sub-two-radius spacing.
- **True leno geometry** — US10023981B2,
  <https://patents.google.com/patent/US10023981B2/en>. Used only for the
  doup/skeleton pair wrapping a weft and resisting slip; it is not evidence for
  the printed locking force.
- **Borromean braid representation** — Jozef H. Przytycki, *From 3-moves to
  Lagrangian tangles and cubic skein modules*,
  <https://arxiv.org/abs/math/0405248>. Supplies the
  `(σ₁σ₂⁻¹)³` three-component closure representation; the engine separately
  asserts zero pairwise linking.
