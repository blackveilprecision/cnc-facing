# cnc-facing

A facing-job generator for the **Makera Z1**. Pick X, Y, depth and material; get
a `.nc` the controller will preview, boundary-trace and run.

```sh
bun install
bun run dev          # http://localhost:3117
bun test
bun run typecheck
```

## Network

It listens on `0.0.0.0` so the laptop next to the machine can reach it, and
answers **only the workshop subnet**:

```
cnc-facing 0.3.0 listening on 0.0.0.0:3117
  reachable from: 127.0.0.0/8, ::1/128, 172.16.123.0/24
  http://127.0.0.1:3117
  http://172.16.123.15:3117
```

The wide listener and the narrow allowlist are a pair. This box is also on
172.30.150.0/24, two 10.100.x nets, 10.11.12.0/24 and Tailscale, so binding
everywhere without a filter would put a no-login G-code generator on all of
them. Anything not in the allowlist gets a bare 403.

| Variable | Default | |
|---|---|---|
| `PORT` | `3117` | |
| `HOST` | `0.0.0.0` | set to `127.0.0.1` to go back to localhost-only |
| `CNC_FACING_ALLOW` | `127.0.0.0/8,::1/128,172.16.123.0/24` | comma-separated CIDRs; `0.0.0.0/0,::/0` turns the filter off |
| `CNC_FACING_SCP_TARGET` | unset | when set, the summary prints the `latest-facing.nc` symlink and scp commands |

This is not authentication — it is "do not answer strangers". Anything needing
real access control needs a reverse proxy in front. `test/server.test.ts` starts
the real server and checks every route refuses from outside the allowlist,
including the one that serves the form, because Bun matches `routes` before the
`fetch` fallback and so the check cannot be middleware.

## What it is a port of

`~/src/ha/esp/garasje/kicad/surface_spoilboard.py`, which has been run on the
machine. Its 80 × 60 × 0.3 MDF output is committed at
`test/fixtures/surface_spoilboard-80x60x0.3.nc`, and `test/golden.test.ts`
asserts that this app's motion for the same job is **byte-identical** to it once
the script's repeated G words are dropped (this app writes modal motion; see
"Modal motion"). That
one test pins the path, the coordinate convention, the feed words and the
G1-not-G0 stepover at once. The header differs on purpose (different CAM id, a
real time estimate, a thumbnail the script never emitted); its structural
properties are asserted separately.

`PLAN.md` lists twelve non-negotiables, each of which cost a machine trip. They
are ported verbatim and each is commented at the line that implements it. The
tests for the four that failed silently are in `test/mkr.test.ts`,
`test/facing.test.ts` and `test/gcode.test.ts`.

## Chamfer

Tick **Chamfer edges** (it needs Overhang) and the file carries a second
operation after the facing: it stops for **T2, the 90° chamfering bit**
(`0.1mm*90° Chamfering`; five on the shelf), re-probes Z, and runs the block's
top edge. The default width is 0.2mm, and 0.1–1mm is allowed.

- **Path:** the tool centre runs the block's outline, clockwise from X0 Y0,
  which is climb. It never goes behind or left of the origin. The corners come
  out as mitres.
- **Depth:** the tip goes (width − 0.05mm tip radius) below the faced top, in
  laps no deeper than Makera's figure for the bit (0.2mm aluminium, 0.1mm
  brass, 1mm MDF). Feeds are Makera's chamfer row per material.
- **The tool change** is the same `G0 Z5` / `M5` / `T2 M6` sequence every
  multi-bit PCB file here has run with. The header gets the second `TOOL` line
  in the V-bit form those files use (`type=Engraving`, `halfAngle=45`).
- **Accuracy:** an X0 Y0 error of 0.1mm makes one side's chamfer 0.1mm wider
  than the opposite one, and a Z error changes the width by the same amount.
- **Run on the machine 2026-09-24: perfect.** Aluminium, 45 × 45, fine finish
  with overhang and a 0.2mm chamfer, from a 3D-probed corner. The `T2 M6`
  stop, the Z re-probe and the two-tool header all worked as they do on the
  PCB jobs.

Picking a material also sets the depth to one facing pass at Makera's depth of
cut: 0.3mm MDF, 0.2mm aluminium, 0.1mm brass.

## Preview and thumbnail

Two separate mechanisms that fail independently — which is what made the
original investigation confusing.

| | Drives | Comes from |
|---|---|---|
| **Preview + laser boundary trace** | the controller's preview pane | the `;@MKR|` header block, `src/mkr.ts` |
| **Job-list tile** | the picture beside the filename | the base64 PNG trailer, `src/thumbnail.ts` |

A file with a thumbnail and no `;@MKR|` block renders its tile perfectly and
still previews blank while the trace walks a zero-size box at X0 Y0. Both are
emitted here, and the browser shows the same picture as SVG before you download,
built from the same `Scene` so they cannot drift.

The PNG is encoded in pure TypeScript (`src/png.ts`, palette + Up filter, no
ImageMagick): about 1.6 KB for a typical job, so the whole `.nc` stays under 5 KB.

The preview draws the **real swept area** — each segment stroked at the tool's
diameter with round ends — not a filled rectangle. So the four corner fillets of
radius *r* that a round cutter necessarily leaves are visible rather than painted
over, and any gap in the raster shows up as the stock tint coming through. The
tests assert exactly that: zero stock-coloured pixels except within *r* of a
corner, with a negative control so "never painted" cannot pass for "covered".

(The fillets do not bite in practice: stock in the vice gets faced a few mm
oversize, which puts them outside the part. They are drawn because the one case
where they matter — the faced area *being* the part — should not be a surprise.)

## Reach check

Every job says to confirm the far corner is reachable before starting, because
the one time that was skipped the job found the soft endstop after it had already
begun. Jogging there is 10mm a press with a wait between, so the app emits the
walk as **MDI lines instead** — one move per corner:

```
G90 G21
G0 Z5
G0 X0 Y0
G0 X90 Y0
G0 X90 Y-70      <-- the far corner, the one that fails first
G0 X0 Y-70
G0 X0 Y0
```

They appear in the UI with a click-to-copy on each line, and as a comment block
near the top of the `.nc` itself, so the file carries its own instructions for
checking it. It walks the **stock** corners, not the toolpath extents, because
they are the larger box. It is **not** the box the laser boundary trace follows;
see the next section.

## The laser trace and the overhang

**The controller's laser boundary trace follows the tool centre, not the edge
of the cut.** With no overhang the tool centre runs a tool radius (1.59mm) in
from every edge, so the laser box is 1.59mm inside the block on all four sides.
**That is correct.** The cutter still reaches exactly to the edges. This README
said the opposite until 0.9.0. The evidence was already there: the first 120 ×
160 trace, in garasje's `MILLING.md`, went to `X1.587 Y158.412`, which is the
tool centre, not the corner.

It surfaced on 2026-09-23. A 45.2 × 45.2 block got a 45 × 45 job whose laser box
sat visibly inside it, so the size was nudged up a millimetre at a time to 49 ×
49 until the laser reached the edge. The cut then ran about 1.9mm past every
edge. That is harmless in air, but it isn't the job that was asked for.

**So: enter the block's measured size, and tick Overhang to face the whole
block.** It is a checkbox, not a value:

| Overhang | Tool centre runs | Laser box | Edges and corners | For |
|---|---|---|---|---|
| off (default) | r..W−r | r inside the block | burrs, small bites where passes end, r-radius corners | part of a larger surface |
| on | 0..W, the block's outline | **on the block's outline** | clean, square corners | the whole block |

With it off the cutter only just reaches the edge, and it didn't in practice
(2026-09-24, a 45.26 × 45.0 block, 3D-probed corner): the left and back edges
came out burred and not quite clean. An end mill cutting a few hundredths
under nominal, runout and probe error are enough, because there is no margin.
With it on there is a tool radius of margin all round.

**The corners come out square with it on.** A round bit can't cut a square
*inside* corner, but a block's corners are *outside* ones. With the tool centre
passing over the corner point, the cutter covers it.

**It isn't shifted.** X0 Y0 still goes on the block's back-left corner, where
the 3D probe finds it. The cutter reaches the same distance past all four
edges, and the tool centre never goes behind or left of X0 Y0. That direction
is where the soft endstop is (see `PLAN.md`'s rule about Y running negative),
and it is why the overhang is exactly a tool radius and no more. Any further
would only cut air.

`STOCK` in the header stays the block, so the controller's preview shows the
cutter going past its edges. The filename gets `-overhang` so two jobs that
differ only in overhang don't overwrite each other.

**Run on the machine 2026-09-24:** the controller is fine with a toolpath past
its declared stock. The laser traced the block's outline, and the edges and
corners came out clean.

The block also carries a relative-hop example for getting the head out of the
way. It moves in Z and X only, on purpose: Y is the axis with no slack, and
`G91` is modal, so it ends with `G90`.

The `.nc` is pure ASCII and free of trailing whitespace, both asserted — the
controller is a byte parser reading off a USB stick and there is nothing to gain
from feeding it multi-byte punctuation.

## Decisions taken in the dev session

`PLAN.md` left five questions open. What was decided, and why:

1. **Work envelope: 200 × 200 mm.** Not an invention — `MILLING.md` records it
   twice. Z travel is *not* recorded anywhere and is deliberately not guessed;
   depth is bounded by flute length instead. The
   envelope check is a ceiling, not a promise: the UI still says to jog to the
   far corner and confirm reach, because a 200mm job only fits with its origin
   on the exact corner of travel.
2. **Thumbnail: yes**, as above.
3. **Climb vs conventional: serpentine, both directions.** One-direction-only
   doubles the air time on a job that is already the slow part of metal facing.
   Revisit with evidence, not by guessing.
4. **Output: browser download**, plus the scp/symlink hint when
   `CNC_FACING_SCP_TARGET` is set. No server-side writes.
5. **`surface_spoilboard.py` stays** as the reference implementation. The golden
   fixture is its output, so drift between the two is a test failure rather than
   a surprise at the machine.

## One correction to PLAN.md

The plan says metal facing must drop to the 2 × 8mm bit because *"the 3.175mm
flat end is a NON-METAL bit"*. **The distinction is the series, not the
diameter** — the shelf has 3.175mm flat ends in both, all the same 3.175mm
cutting diameter. The 25mm and 42mm ones are the non-metal series, wood and
plastics only, with no aluminium or brass column at all. The 12mm one is the
Metal series (`TOOLING.md`, "The actual inventory", row 1), two of them, and
Makera publishes Aluminum `12000 / 500 / 200 / 0.2` and Brass
`12000 / 300 / 100 / 0.1` for it. Picking by diameter gets you the wrong bit.

Scraping the table in full (2026-09-21) also fills in the two Single Flute Metal
rows `TOOLING.md` skipped as not-on-the-shelf — `1.5*6mm` and `2.5*12mm`, both
*smaller*. Worth folding back into `TOOLING.md` if that file is ever revised, as
is the fact that nothing 4mm or wider appears anywhere in the tables.

So all three materials use that one bit: a 1.43mm stepover instead of 0.90mm and
0.2mm per pass instead of 0.15 in aluminium — roughly twice as fast, with a
vendor number behind every figure. `src/materials.ts` cites the table row per row.

## The bit

One bit: the **3.175 × 12mm single flute, Metal series**. Makera's published
figures, the bit `surface_spoilboard.py` declares, and what every faced board on
this machine has used.

A 6mm single flute was carried here briefly and dropped. Worth recording why, in
case it comes back: Makera sell one (DLC-coated, "Face cleaning" among its
applications) and publish a Tool Parameters table for it **on the product page**,
not on the wiki speeds-and-feeds page — whose tables contain no tool 4mm or
wider. Those product-page figures are *identical to the 3.175 row*, material for
material, so the only gains were stepover and stiffness, which did not justify a
second collet and a second set of numbers. `Material.tools` is still an array, so
re-adding a bit is a table entry rather than a refactor.

**Check the product page before reasoning from chipload** — that is the lesson
that outlasts the bit.

## Test coupons

Before trusting either metal, cut a small one. Suggested first jobs, both in
**general** mode with the default stepover:

| | Aluminium | Brass |
|---|---|---|
| Size | 40 × 30 | 40 × 30 |
| Depth | 0.2mm (one pass) | 0.1mm (one pass) |
| Feeds | 12000 / 500 / 200 | 12000 / 300 / 100 |
| Passes / time | 20, 1.6 min | 20, 2.6 min |

Then the same coupons in **fine finish** mode — aluminium at 0.15mm (74 passes,
4.5 min), brass at 0.1mm (74 passes, 7.5 min) — and compare the pairs side by
side under a light. The filenames differ by a `-finish` suffix, so downloading
both does not overwrite one with the other.

What you are looking for:

- **Arc-shaped marks across each pass** → spindle tram, not feeds. No change to
  the numbers will fix it; it is the dominant term in how a faced surface looks.
- **A smeared or cloudy grey rather than bright** → built-up edge. Aluminium at
  120 m/min surface speed is on the low side, so this is the plausible failure.
  Try a lighter depth before anything else.
- **Ridges you can feel at the stepover spacing** → tram again, or deflection.
  Halve the stepover in Advanced and see whether it changes.
- **Chatter marks** → too deep. Both metal rows are already at Makera's figure,
  so go down, not up.

Brass 360 chips cleanly and should be the easier of the two to read; aluminium
will show built-up edge more readily. Running both tells you whether a poor
result is the machine or the material.

## Two modes

**General** is the original behaviour and the default: one pass of the chosen
pattern (below) per depth level, serpentine along Y unless told otherwise
(along X before 0.9.0; the coupons below moved it). It is
what a spoilboard or fixture plate wants — a flat reference to tape PCBs and stock
to, where speed matters and the look does not.

**Fine finish** roughs to within an allowance, then takes it off in one last pass
that runs at **90° to the roughing passes** with about half the stepover:

```
levels: x@0.175  x@0.350  y@0.400
                          ^ the finishing pass, rotated
```

The rotation is the point. A finishing pass running the same way as the roughing
passes rides in their grooves; one running across them cuts them off.

| | |
|---|---|
| Allowance | 0.05mm metals, 0.2mm MDF |
| Finishing stepover | ~0.7mm absolute on every bit, about half the roughing step |
| Direction | 90°, still serpentine |

**The feeds are Makera's; the strategy is not.** They publish speeds and feeds,
not a finishing recipe, so the allowance and the finishing stepover are choices
made here — the summary says so in as many words.

### On the climb-milling advice

Guides for a shiny finish on the Z1 lead with *"use climb milling for both the
rough and the finish pass — the single biggest factor in removing tool marks"*.
That advice is sound and **it is about walls**, which is a different operation
from this one. Read the tables it comes with: *radial* stock allowance, *wall*
leave, "up to 3mm total wall height", "the shiniest **wall** surface finish",
"don't drag across the floor of your **pocket**". Facing is the floor.

Three consequences:

1. **A facing floor is cut by the tool's end face, not its periphery.** Climb
   versus conventional describes how the periphery engages, so it governs the
   little ridge at the stepover overlap, not the surface itself. Spindle tram
   dominates that, by a lot.
2. **The 0.1mm radial wall allowance has no facing equivalent.** Its analogue
   here is an *axial* allowance, which is what finish mode's 0.05mm is.
3. **A serpentine alternates** climb and conventional: the stepover always runs
   into −Y, so +X passes are climb and −X passes are conventional. Making them
   all climb means going one direction only — lift, rapid back, plunge, per
   pass. That roughly doubles the finishing pass and leaves a row of plunge
   entry marks along the starting edge, which is only harmless because stock in
   the vice gets faced a few mm oversize. Not done; offered if a test coupon
   says the alternation is visible.

What *does* transfer, and is already here: the depth-of-cut figures (0.2–0.3mm
aluminium, 0.1–0.15mm brass per layer — Makera's published 0.2 and 0.1 sit at
the shallow end of both, which is where a 150 W spindle wants to be), and
lifting clear before any traverse so the tool never drags over a finished
surface, which `gcodeBody` does for the rotated pass and a test enforces.

The finishing pass **still serpentines** rather than going one direction only.
Unidirectional is the classic answer for a uniform finish, but here it would
roughly double the time and add a plunge mark per pass, and there is no evidence
from this machine that it is worth either. Same reasoning as PLAN.md's open
question 3.

Rotating moves the raster onto the other axis, which is exactly where "Y must be
negative" and "the swept area is the requested rectangle" would quietly stop
holding — so `test/finish.test.ts` re-asserts both against the rotated pass
specifically, along with the retract-before-traverse when the finishing pass
starts at a different corner from where roughing ended. (When they coincide, no
traverse is emitted at all, and that is tested too.)

## Patterns — finding out how this machine faces best

Added 2026-09-22, prompted by a Carvera forum thread: a part faced in concentric
squares came out rougher where the cut ran along X than where it ran along Y, and
the answer given was that a gantry machine is stiffer in Y. General mode now
offers four patterns so that can be tested on this machine with the bits on the
shelf, before buying anything.

| Pattern | Cuts along | Climb? | Between passes |
|---|---|---|---|
| **Serpentine X** (default before 0.9.0) | X | alternates: +X climb, −X conventional | G1 stepover into −Y |
| **Serpentine Y** (default) | Y, the stiffer axis | alternates: +Y climb, −Y conventional | G1 stepover into +X |
| **One-way Y** | Y, front to back | every pass | lift 1mm, rapid to the front edge, plunge |
| **Spiral** | all four directions | every pass, clockwise inward | short diagonal G1 to the next ring |

Climb means for M3: the uncut material on the right of the direction of travel,
as G41 assumes. `test/patterns.test.ts` checks that against the emitted G-code,
not against the plan.

**The spiral is the diagnostic.** Every ring cuts in all four directions, so the
coupon's top and bottom triangles are the X-cut surface and its left and right
triangles the Y-cut one — same tool, same stock, same run. If X is visibly worse
there, it is the axis, and Serpentine Y against One-way Y then separates *axis*
from *climb versus conventional*.

What each one costs:

- **One-way Y** plunges once per pass, at the front edge, and each plunge leaves a
  small dwell mark there. It lifts only to `CLEAR_Z` (1mm) between passes:
  everything under that rapid is at or below Z0. Between depth levels it still
  goes to `SAFE_Z`.
- **The spiral** slows the machine at every corner. Each ring is closed before it
  steps in: leaving it open leaves an uncut sliver at the first ring's back-left
  corner. With more than one depth level it retracts at the centre and goes back
  to the corner, so every level is climb.
- **Edge scallops** on the raster patterns. Where passes *end* at an edge, the
  edge between two pass ends is a row of tool-radius arcs, about 0.17mm deep at
  the default stepover. The X serpentine has always had this on its left and
  right edges; the Y patterns have it on the front and back edges. The spiral
  has none. It is one more reason to face stock a few mm oversize.

Fine finish keeps its fixed strategy (rough along X, finish along Y) and refuses
any other pattern. That finishing pass already runs along Y, so it is on the
stiffer axis either way. Once the coupons show which pattern wins, the finishing
pass is the place to use it.

### The coupon run

All general mode, 40 × 30, default stepover. The filename carries the pattern, so
four downloads never overwrite each other:

| Pattern | Aluminium, 0.2mm | Brass, 0.1mm |
|---|---|---|
| Serpentine X | 20 passes, 1.6 min | 20 passes, 2.6 min |
| Serpentine Y | 27 passes, 1.6 min | 27 passes, 2.6 min |
| One-way Y | 27 passes, 2.4 min | 27 passes, 3.5 min |
| Spiral | 11 rings, 1.6 min | 11 rings, 2.7 min |

Then fine finish, to see how good the best of them can get.

### Results so far

**2026-09-22, spiral, aluminium, 0.2mm, 45%.** Y is by far the better axis:

| Triangle | Travel | Result |
|---|---|---|
| Left | +Y | looks and feels completely flat |
| Right | −Y | looks and feels completely flat |
| Top (back) | +X | visibly worse than Y, stepped between rings |
| Bottom (front) | −X | the worst, with burrs along the ring steps |

Every ring was climb, so the difference is the axis, not the cut direction. The
likely reading, not yet proven: the end face is not square to the table front to
back, from spindle tram or the head tipping in Y under load. Across an X pass
that tilt slopes each floor, so neighbouring passes meet in a step. Along a Y
pass it lies in the feed direction and the floor stays flat. That the two X sides
*differ* (the burrs are on one side only) points at a fixed tilt more than at
flex.

**2026-09-23, One-way Y, aluminium, 0.2mm, 45%, 100 × 100.** Very good. The
stepover lines show plainly under light, but they cannot be felt with a
fingertip and barely with a fingernail. So the lines are mostly optical — the
light catching the pass boundaries and the end-face swirl inside each pass —
rather than height. That fits the spiral: along Y the floor stays flat, and
whatever small left-right tilt is left only shows up as a line at each overlap.

**2026-09-23, Serpentine Y, aluminium, 0.2mm, 45%.** The alternation shows:
every other band looks different, bright and fine-textured next to darker with
coarser end-face scallops, which are the climb (+Y) and conventional (−Y)
passes. It **feels the same as One-way Y**, though. So the conventional passes
change how the surface looks, not how flat it is. For a spoilboard or fixture
plate that is a pass, and Serpentine Y is as fast as the original.

**2026-09-23, fine finish, aluminium.** It **feels the best of all of them**. The
finishing pass leaves visibly finer, closer lines (about 0.7mm apart, against
1.43mm) with the same scallop texture inside each one. No change needed: its
finishing pass already runs along Y.

**Where that leaves it:** along Y wins, conventional versus climb only changes
how it looks, and fine finish is the one to use when the surface matters. So
from 0.9.0 **Serpentine Y is the general-mode default**. Fine finish keeps
roughing along X, so that its rotated finishing pass is the one on Y. A plain
filename still means Serpentine X, as it did for every earlier job, and
`-serpentine-y` is spelled out.

**Still to cut:**

1. *Optional:* the spiral again at **0.1mm**. It halves the load but not the
   stepover, so if the X triangles clear up it is flex, and if they do not it is
   tram, which no feed or depth will fix.

### On a three-flute

Not on the shelf, and deliberately not bought yet. The reasoning, for when the
coupons are in: at the same 500 mm/min a three-flute takes 0.014mm per tooth,
which is low enough to rub and cause built-up edge. It wants 1000–1200 mm/min
(still under `MAXFEEDRATE`). Power is not the limit: 0.2 × 1.43 × 1200 is about
340 mm³/min, a few watts. The real gain would be stiffness, from a bigger core
and three small hits per revolution instead of one. Makera publishes no figures
for one, so it would go in as a `derived` row. If the spiral says X is clearly
worse, that is deflection, and the three-flute becomes worth buying.

## Fly cutters

`PLAN.md` says *"a fly cutter would be the right tool and is not on the shelf"*.
Looked into it 2026-09-21; the honest answer is **nobody has tried one on this
machine line, and the specification argues against it.**

- The Carvera Community's own *CNC A-to-Z* guide, in its cutters chapter, says
  flatly: *"So far I have not seen any attempts to use a fly cutter on the
  Carvera line of machines."* That is the community's reference document, so the
  absence is meaningful rather than a gap in searching.
- The same page does cover **face mills** — *"a fly cutter with multiple cutting
  edges"* — and links a demonstration on a Carvera. That is the nearer-term
  option if the 3.175mm bit ever proves too slow.
- It also explicitly warns off **router-style surfacing bits**, which is the
  other thing one reaches for.

Against the Z1's published numbers, a fly cutter is a poor fit:

| | |
|---|---|
| Spindle | **150 W**, 0–13,000 rpm |
| Collets | 1/8" standard; 1/4", 6mm, 4mm, 3mm optional — **no 8mm** |
| Work volume | 200 × 200 × 100 mm |

A fly cutter earns its finish from a wide swing at *low* rpm, which is the
opposite of what a 150 W high-speed spindle is good at: at the few-thousand rpm a
25mm swing wants, there is very little torque left, and a single-point tool takes
one shock load per revolution on a desktop gantry. The 1/4" collet ceiling caps
the shank, and the tool needs clearance of its full diameter beyond the part on
every side — a real cost inside 200 × 200.

So: not ordered and not modelled. **The objection does not transfer to a bigger
endmill**, which is the important part — a fly cutter fails because it wants
*low* rpm where a 150 W high-speed spindle has no torque, plus one shock load per
revolution. A 6mm endmill wants the same 12000 rpm you already use and simply
takes more per pass. So if facing ever needs to be faster, a bigger endmill is
the direction to look, not a fly cutter.

**Also confirmed while looking:** the Z1's work volume is **200 × 200 × 100 mm**,
which matches the 200 × 200 that `MILLING.md` had recorded independently, and
answers the Z travel that `PLAN.md` refused to guess. Z is still not checked —
facing depth hits the 12mm flute length long before it runs out of 100mm of Z.

**Stock thickness is not an input** (dropped 2026-09-22). The only thing it
changed was how tall the controller draws its preview box, via
`;@MKR|STOCK|height=` and the `ORIGIN` z, plus a refusal for facing deeper than
the stock, which never comes up on a skim. The header now always declares 12mm,
the value in the `surface_spoilboard.py` file this machine has run.

## Modal motion

Since 0.10.0 every file is **modal**: a motion line carries a G word only where
the motion mode changes, the way EasyTrace writes its files (`G1 X10 F500`
followed by `Y-45 F500`). Makera Studio, `surface_spoilboard.py` and every file
before this put one on every line.

**Settled on the machine 2026-09-24.** Bare lines were once blamed for the blank
preview and the zero-size boundary trace, but that was only tested while the
`;@MKR|` header had `TIME` before `TOOL`, which was the real cause. A 45 × 45
aluminium job with overhang and chamfer, correct header and 69 bare lines was
loaded next to the same file with a G word on every line. Both previewed and
both traced the real outline.

F stays on every feed move. The first move after each `M6` is written in full,
because the tool-change macro runs its own moves and probes and leaves the
controller in a motion mode the file never set. The golden test compares the
motion with `surface_spoilboard.py`'s once its repeated G words are dropped, and
nothing else may differ. The geometry tests read the lines through
`test/explicit.ts`, which puts the G words back.

## Checking a file from somewhere else

The **Check a file** tab (`/#check`) takes any `.nc` (from Makera Studio,
EasyTrace5000, FlatCAM or a hand edit) and reports on it against what this
machine has taught, without storing it. `src/check.ts` is pure (text in, report
out) and every rule cites where it was learned. It keeps four levels apart:

| Level | Means | Examples |
|---|---|---|
| **Fail** | aborts, damages a bit or the work, or breaks a limit this app enforces | `T1` and `M6` on separate lines; feed above `MAXFEEDRATE`; cutting with the spindle off; more than 200mm of travel; a non-metal bit in metal |
| **Silent** | runs, but the preview, boundary trace or extraction quietly does not happen | no `;@MKR|` block; `TIME` before `TOOL`; `M30`; `M7`/`M9` with no `M331` |
| **Warning** | differs from what is known to work, or looks like a known mistake | over Makera's feed, plunge, depth per pass or chip load for the bit; `S1200`; a new spindle speed with no `M6`; deeper than the bit's flutes; a rapid through uncut stock; `.cnc`; bare coordinate lines; `G32` or canned cycles |
| **Note** | worth knowing, including what is still untested | a recorded deviation from Makera's table; an `ORIGIN` on the other edge from the coordinates; LF line endings; no thumbnail |

It also draws the toolpath against the declared stock and gives the same MDI
reach walk as the generator, around the stock (or, with none declared, around
the material removed).

**Two old stories are deliberately not failures.** CRLF line endings and bare
coordinate lines were both blamed for the blank preview, and both are among
the six hypotheses `EASYTRACE-Z1.md` records as tested on the machine and
ruled out. The cause was the header's field order. So both are notes, and
`test/check.test.ts` pins both. Modal motion has since been tested on its own
and is fine (see "Modal motion" above). This app still writes
CRLF, because matching Makera costs nothing.

**Both origin conventions are valid.** Files from before the back-left
convention (the garage opener) declare the front-left form over a −Y job and
cut fine, so a header whose `ORIGIN` is on the other edge from its coordinates
is a note: at most the controller draws its preview box on the other side.

### Bits against Makera's table

Every bit in use here is an official one, so each header `TOOL` is identified
against Makera's table (`src/catalogue.ts`, transcribed from `TOOLING.md`) from
its name, in Makera Studio's style (`3.175*2*8mm Flat End(Metal)`),
`fix_gcode.py`'s (`3.175*0.3mm*30deg Engraving - ISOLATION`) or this app's. The
material comes from the header's `MATERIAL` line (FR4 reads as PCB, MDF as
Hardwood) and can be overridden in the tab. Then what the file actually does
with each bit is set against Makera's row for it:

| | Reported when |
|---|---|
| Feed, plunge | over Makera's figure, counting only moves that are in material |
| Depth per pass | over Makera's figure; for a drill, the peck |
| Speed | a slower spindle at the same feed is a heavier chip than Makera's: a warning. A faster one is a lighter chip: a note |
| No row | Makera publishes nothing for that bit in that material; a fail for a non-metal bit in metal |

Makera's figures are ceilings, so being under one is never reported. A
deliberate departure recorded in `TOOLING.md` is a note, not a warning: the
0.3mm V-bit's 0.12mm isolation depth is the one so far (`DEVIATIONS`).

**Depth per pass comes from a simulation, not the Z levels.** `src/stock.ts`
keeps a height map of the stock and lowers it by each bit's real profile (disk,
ball, or V-cone). Each move's depth is how deep a band of new material at least a
fifth of the bit wide goes, held over two positions of the bit. Reading it off
the Z levels was tried first and was wrong both ways:

- a helical hole has one flat orbit at the bottom, and read as 1.7mm in one pass
  when the helix is 0.28mm a revolution;
- a finishing pass along a wall at full depth read as a 1.2mm pass when it was
  taking a 0.1mm skim;
- Makera's own pockets rapid and plunge through air they have already cleared,
  25,000 times, and read as plunges at F1000.

The test for it is Makera's own sample, checked against Makera's own table: all
four bits come out exactly on their published figures (0.2, 0.15 and 0.1mm per
pass, a 0.2mm peck at F100). A rapid through uncut stock is a warning; one
through air already cleared is not reported.

The flute check uses the identified bit's flute length, and is a warning rather
than a failure: `flip-gauge-A-front` (v2) declares T3 as the 2mm corn bit and
cuts to −9.7, but was cut with a 3.175 × 12mm bit. A header can name the wrong
bit, and then the controller's tool list is wrong too.

**Calibrated on real files.** Makera Studio's own 3.2MB sample, the
post-processed PCB files and this app's output all come back with no failures.
The raw EasyTrace export (`test/fixtures/easytrace-B-back-RAW.cnc`, next to the
`-FIXED.nc` that ran) shows every fault `fix_gcode.py` exists to fix. The one
table finding across the garasje files: `car-remote` isolates at −0.15, over
both Makera's 0.1 and the recorded 0.12.

Every job the generator can produce is checked in the tests too, so the two
halves of the app cannot drift apart on what the machine wants.

## Shape

```
src/materials.ts   the speeds-and-feeds table, one source citation per row
    facing.ts      the four patterns -> G1 lines. Pure.
    mkr.ts         the ;@MKR| header. Field ORDER is the contract.
    validate.ts    the refusals
    summary.ts     the derived numbers, and the warnings that do not refuse
    reach.ts       the MDI corner walk, for the UI and for the .nc
    check.ts       the checker for uploaded files. Pure.
    catalogue.ts   Makera's bits and published speeds and feeds
    stock.ts       the stock simulation behind depth per pass
    checksvg.ts    its toolpath picture
    net.ts         the CIDR allowlist
    preview.ts     the Scene, and its SVG rendering
    png.ts         a minimal indexed PNG encoder
    thumbnail.ts   the Scene as Makera's base64 trailer
    gcode.ts       header + preamble + body + trailer, CRLF
    server.ts      Bun.serve
    index.html     the form
```

`facing.ts` and `mkr.ts` are pure and separately testable. They are where the
machine knowledge lives and what a regression would silently break.
