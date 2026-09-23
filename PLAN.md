# cnc-facing — a facing-job generator for the Makera Z1

**Status: BUILT 2026-09-21.** See `README.md` for what was decided and how to run
it. This file is kept as the record of *why*, and the open questions at the
bottom now carry their answers. Written 2026-09-20 from the hard-won
Z1 knowledge in `~/src/ha/esp/garasje` (`MILLING.md`, `EASYTRACE-Z1.md`,
`TOOLING.md`, `kicad/surface_spoilboard.py`). Read this before writing anything.

## What it is

A small Bun web app. Pick **X**, **Y**, **depth** and **material**; get a `.nc`
file that the Makera Z1 controller will preview, boundary-trace and run. Facing
is the one job needed over and over — spoilboards, fixture plates, stock
flattening — and it is always the same serpentine raster with different numbers.

## Why not just reuse `surface_spoilboard.py`

That script works and every rule in it was learned the hard way, so it is the
reference implementation and should be ported, not redesigned. But it is
MDF-only, single-tool, hardcoded RPM/feed, no multi-pass, no validation, and CLI
only. The new thing adds: material selection (with the tool and feeds that
follow from it), depth stepping, envelope checking, and a UI.

## The non-negotiables — every one of these cost a machine trip

Port these verbatim. None are style preferences.

1. **`;@MKR|` header is mandatory, and its field order is load-bearing.**
   Without it the controller shows no toolpath preview and the laser boundary
   trace walks a zero-size box at X0 Y0 — while cutting the job perfectly, so
   the failure is silent. `TOOL` entries must come **before** `TIME`. Seven
   machine trips to pin down; see `EASYTRACE-Z1.md`.
2. **The stepover between passes must be `G1`, not `G0`.** An early version
   rapided sideways with the cutter buried — 1.43mm of radial engagement at up
   to 3000 mm/min — and left a groove the neighbouring passes did not.
3. **Y must run negative** from a top-left origin. A +Y facing job drives the
   gantry away from the operator; a 160mm job asked for Y+158.412 and the
   controller answered *"Soft Endstop Y was exceeded"* before cutting anything.
   Every job must sweep the same way from the same datum or one origin cannot
   serve both this and the PCB jobs.
4. **`T<n> M6` on ONE line, in that word order.** Split across two lines the
   controller aborts mid-job and loses its levelling heightmap.
5. **CRLF line endings**, matching Makera Studio's own output.
6. **`M331` (vacuum) BEFORE the tool change**, `M332` after `M5`. This is the
   proven order from every file the machine has run. A job that looked like "no
   vacuum" turned out to be the air-assist hose fallen out with suction running
   the whole time — the G-code was never at fault, and a reordering tried as a
   guess was reverted.
7. **`G4 P1` dwell** after spindle start, before the first cut.
8. **`G28` to park**, then `M02`.
9. **Feeds must stay under `MAXFEEDRATE|value=1200`.** Declare it and enforce it.
10. **No arcs needed** — facing is all `G1`. (Makera Studio emits no arcs at all;
    the Z1 does handle G2/G3 including full circles, but there is no reason to
    use them here.)
11. **The cut area equals the requested W×H.** The tool *centre* runs from `r` to
    `W-r`, so the swept area is exactly `0..W`. Keep that convention — it is what
    makes "I want 80×60 faced" mean what the user expects.
12. **Levelling (`G32`) is controller-side**, never embedded in the file. It
    persists across tool changes and files.

## Inputs

| Input | Type | Notes |
|---|---|---|
| Size X | number, mm | the faced area, not the tool path |
| Size Y | number, mm | |
| Depth | number, mm | total; the app splits it into passes |
| Material | select | `mdf`, `aluminium`, `brass` |

Everything else — tool, RPM, feed, plunge, depth per pass, stepover, pass count,
estimated time — is **derived**, shown read-only, and explained. The user should
be able to see *why* a number was chosen, because the whole value here is
encoding knowledge they would otherwise re-derive.

## Material → tool → feeds

From `TOOLING.md`, which transcribes Makera's own speeds-and-feeds table. The
critical thing the table makes obvious:

> **The 3.175mm flat end is a NON-METAL bit.** Makera publishes no aluminium or
> brass figures for it. Metal facing must use the *Single Flute Metal* bits, and
> the widest of those is **2mm**.

> **~~The 3.175mm flat end is a NON-METAL bit.~~ Wrong — corrected 2026-09-21.**
> True of the 3.175×25mm and ×42mm long bits, but the Extended set also carries a
> **3.175×12mm in the *Metal* series** (`TOOLING.md`, "The actual inventory", row
> 1), ×2, and Makera publishes aluminium and brass figures for it. The table
> below is superseded by the one after it, which is what `src/materials.ts`
> implements.

| ~~Material~~ | ~~Tool~~ | ~~RPM~~ | ~~Feed~~ | ~~Plunge~~ | ~~Max depth/pass~~ |
|---|---|---|---|---|---|
| ~~MDF~~ | ~~3.175mm flat end~~ | ~~10000~~ | ~~1000~~ | ~~300~~ | ~~1.0~~ |
| ~~Aluminium~~ | ~~2×8mm flat end (metal)~~ | ~~12000~~ | ~~500~~ | ~~200~~ | ~~0.15~~ |
| ~~Brass~~ | ~~2×8mm flat end (metal)~~ | ~~12000~~ | ~~300~~ | ~~100~~ | ~~0.10~~ |

**As built** — one bit for all three, the widest with published figures for each:

| Material | Tool | RPM | Feed | Plunge | Max depth/pass |
|---|---|---|---|---|---|
| MDF | 3.175×12mm flat end (metal series) | 10000 | 1000 | 300 | 1.0 (hardwood row; 2.0 for softwood) |
| Aluminium | 3.175×12mm flat end (metal series) | 12000 | 500 | 200 | 0.20 |
| Brass | 3.175×12mm flat end (metal series) | 12000 | 300 | 100 | 0.10 |

> **The fly-cutter line below is wrong, or at least unsupported — checked
> 2026-09-21.** The Carvera Community's *CNC A-to-Z* cutters chapter says "So far
> I have not seen any attempts to use a fly cutter on the Carvera line of
> machines", and the Z1's 150 W spindle, 1/4in maximum collet and need for full
> tool-diameter clearance all argue against one. A small **face mill** is the
> plausible version of the idea. See README, "Fly cutters".

**Warn loudly about metal facing time.** A 2mm bit at 0.45 stepover clearing
100×100mm at 0.15mm/pass is roughly 110 passes per depth step at 500 mm/min.
The app should show the estimate prominently and let the user reconsider rather
than discover it at the machine. A fly cutter would be the right tool and is not
on the shelf — worth stating in the UI, not hiding.

Stepover: `surface_spoilboard.py` uses **0.45 × tool diameter**, chosen
conservatively for MDF's ragged fibres. Keep that as the default; consider
exposing it as an advanced field rather than guessing a different value per
material without evidence.

## Output

- **Filename**: `facing-<material>-<X>x<Y>-<depth>mm-<YYYYMMDD>.nc`, matching the
  garasje project's `<what>-<size>-<date>` habit.
- **Browser download**, plus — because the Z1 is driven from a Windows laptop
  over scp — print the suggested `latest-facing.nc` symlink command, or let the
  app write into a configured directory. Decide in the dev session.
- **A summary** next to the download: passes, stepover, pass depths, estimated
  minutes, and the declared stock — so it can be sanity-checked before it moves.

## Validation — refuse, don't warn

The generator should be a gate, the way `fix_gcode.py --stock` is. Refuse with
the offending value named, rather than emitting a file that fails at the machine:

- Feed above `MAXFEEDRATE` (1200).
- Size beyond the Z1's work envelope. ~~Open question — the envelope is not
  recorded anywhere in the garasje repo.~~ **Resolved 2026-09-21: it is, twice.**
  `MILLING.md` gives *"the machine's 200 x 200 envelope"* and *"A 150 × 200 sheet
  is the machine's entire work area (200 × 200)"*. XY is checked against that. Z
  travel genuinely is unrecorded and is still not guessed — depth is bounded by
  flute length and by the declared stock instead.
- Depth greater than the tool's flute length.
- Size smaller than the tool diameter (no room for a single pass).
- Non-positive numbers, NaN.

## Shape of the code

Keep it small. One generator module, pure functions, no framework needed:

```
src/
  materials.ts     the table above, as data with a source comment per row
  facing.ts        serpentine path -> G1 lines. Pure: numbers in, strings out.
  mkr.ts           the ;@MKR| header. Field ORDER is part of the contract.
  gcode.ts         assembles header + preamble + body + trailer, CRLF
  validate.ts      the refusals above
  index.html       the form
  server.ts        Bun.serve; POST params -> .nc
test/
```

`facing.ts` and `mkr.ts` must be pure and separately testable — they are where
the machine knowledge lives, and they are what a regression would silently break.

## Testing

**Decide the framework at the start of the dev session** rather than scaffolding
something arbitrary. `bun test` is the obvious default for a Bun project.

What is worth testing, roughly in order of value:

1. **Golden-file test against a known-good output.** `surface_spoilboard.py`'s
   output for 80×60×0.3 in MDF has been run on the machine successfully. Port
   the script, generate the same job, and diff. That single test pins down the
   header, the ordering, the line endings and the path all at once.
2. **`;@MKR|` field order** — assert `TOOL` precedes `TIME`, since that is the
   one that failed silently.
3. **No `G0` while the tool is down** — assert directly, it is finding #2.
4. **All Y coordinates ≤ 0** — finding #3.
5. **CRLF throughout**; `T<n> M6` never split.
6. Pass arithmetic: depth split, pass count, cut area equals requested W×H.
7. Validation refusals.

## Versioning

`package.json` gets a version from the start; bump per semver on changes that
ship behaviour, per the global rules.

## Open questions — answered 2026-09-21

1. ~~**Z1 work envelope.**~~ **200 × 200 × 100 mm.** XY was recorded twice in
   `MILLING.md` all along; Makera's published figure confirms it and supplies the
   Z travel too (checked 2026-09-21). XY is enforced. Z is not, because it cannot
   bind — facing depth hits the 12mm flute length and the declared stock first.
2. ~~**Thumbnail** — worth it, or leave the job list blank?~~ **Built.**
   `src/png.ts` is a dependency-free indexed-PNG encoder (`fix_gcode.py` shells
   out to ImageMagick, which is not acceptable in a request path), and
   `src/thumbnail.ts` emits Makera's three-line base64 trailer. ~1.6 KB, so the
   whole `.nc` stays under 5 KB. The browser shows the same picture as SVG,
   built from the same `Scene` so the two cannot drift. Not a plain rectangle:
   it draws the real swept area, which makes the corner fillets and any raster
   gap visible.
3. ~~**Climb vs conventional.**~~ **Serpentine, both directions.** Now with a
   reason rather than a cost argument: on a facing job the floor is cut by the
   tool's end face, so cut direction governs the stepover ridge and not the
   surface, and spindle tram dominates either way. One-direction climb also
   doubles the finishing pass and leaves a row of plunge marks along the start
   edge. Revisit if a test coupon shows the alternation.
4. ~~**Where does the file land?**~~ **Browser download**, plus the
   `latest-facing.nc` symlink and scp commands printed in the summary when
   `CNC_FACING_SCP_TARGET` is set. No server-side writes.
5. ~~**Does `surface_spoilboard.py` get retired?**~~ **It stays**, as the
   reference. Its 80 × 60 × 0.3 output is the golden fixture, so drift between
   the two is a failing test rather than a surprise at the machine.

## Found while building

- **The corner fillets are real.** The tool centre stops at `r`, so a faced
  rectangle has corners of radius `r` (1.588mm). Irrelevant for a spoilboard,
  decisive if the faced area is the bottom of a pocket. The preview draws them
  and the summary says so, rather than letting the picture promise a sharp
  corner the machine cannot cut.
- **Two modes, added 2026-09-21.** `general` is the original serpentine, for a
  spoilboard or fixture plate you tape stock to. `finish` roughs to an allowance
  (0.05mm in metals) and takes it off in one pass rotated 90 degrees at about
  half the stepover, so the last pass cuts across the roughing grooves instead
  of riding in them. Makera publishes feeds, not finishing strategies, so the
  allowance and the finishing stepover are this project's choices and the UI
  says so. Still serpentine, not unidirectional — see open question 3.
- **Climb-milling advice for the Z1 is written about WALLS, not floors.** The
  guidance that circulates ("climb for both passes, the single biggest factor in
  removing tool marks") comes with tables of radial stock allowance and wall
  height, and talks about pocket floors as the thing to avoid dragging across. A
  facing floor is cut by the tool's END FACE, so cut direction governs only the
  stepover ridge; tram dominates. The depth-of-cut figures in that guidance
  (0.2-0.3 aluminium, 0.1-0.15 brass per layer) do transfer, and Makera's
  published 0.2 / 0.1 sit at the shallow end of them. Answers open question 3
  with a reason rather than a shrug.
- **Makera publishes feeds on the PRODUCT page that are not on the wiki.** The
  6mm rows were derived for about an hour until the product page turned up a
  Tool Parameters table for `6mm*17mm /25mm /30mm Flat End(Metal)`. Worth
  checking the product page for any future bit before reasoning from chipload.
- **A 6mm single flute was added and then dropped the same day.** Kept as a
  note because the facts cost some digging: Makera sell one, DLC-coated, and its
  published feeds are IDENTICAL to the 3.175 row material for material, so the
  only gains were stepover and stiffness. Not worth a second collet and a second
  set of numbers. `Material.tools` stays an array so re-adding is a table entry.
- **The app is on the LAN, deliberately narrowly.** It binds `0.0.0.0` so the
  laptop at the machine can reach it, and answers only `172.16.123.0/24` plus
  loopback (`CNC_FACING_ALLOW`). This box is on five subnets and Tailscale, so
  the wide listener needs the narrow allowlist to mean what was asked for.
- **The jog control is the bottleneck for the reach check this app keeps asking
  for.** 10mm per press with a wait between makes walking a 150mm perimeter a
  minute of clicking, which is how the check gets skipped. MDI takes a single
  absolute move, so `src/reach.ts` emits the walk as seven lines — in the UI
  with click-to-copy, and as a comment block in the `.nc` so the file carries
  its own instructions. It walks the stock corners, which is what the laser
  boundary trace follows.
- **Corner fillets are a non-issue in practice**, confirmed 2026-09-21: stock in
  the vice gets faced a few mm oversize, putting them outside the part. Still
  drawn, and mentioned once in the summary, for the case where the faced area is
  the part.
- **The `.nc` is kept pure ASCII**, asserted by a test. An em-dash typed into a
  comment block is easy to do and there is no upside to putting multi-byte
  punctuation in front of an embedded byte parser.
- **`stroke-linecap` applies to the ends of an SVG subpath, not to the vertices
  inside one.** A single `<polyline>` for the toolpath left the outer
  half-tool-width of every row unpainted — a visible uncovered strip down both
  edges. Drawn as one subpath per segment now. Worth knowing for any future
  toolpath preview.

- **CRLF was never the cause of the blank preview** (checked 2026-09-23). The
  story that a \r\n-splitting parser reads an LF file as one line, and so shows
  no preview, predates the finding that fixed it: `EASYTRACE-Z1.md` lists LF vs
  CRLF among the six hypotheses tested on the machine that all FAILED, and the
  cause was the header's field order. "Modal motion" is on the same list. The
  files still get CRLF (matching Makera costs nothing), but the uploaded-file
  checker reports LF as a note and bare coordinate lines as a warning, and
  `test/check.test.ts` pins both so the old story cannot come back as a rule.
- **A checker for files this app did not write** (0.8.0, 2026-09-23). The
  "Check a file" tab reads any `.nc` and reports against everything above, and
  against Makera's own speeds and feeds for each bit it identifies. Depth per
  pass has to come from a simulated stock (`src/stock.ts`), not the Z levels:
  those read a helical hole as one 1.7mm pass and Makera's own pocket moves
  through cleared air as plunges. Measured that way, Makera's sample lands
  exactly on Makera's table for all four of its bits. See README, "Checking a
  file from somewhere else".
- **Both origin conventions are valid.** Front-left files from before the
  back-left convention (the garage opener) cut correctly; a header whose
  ORIGIN is on the other edge from its coordinates is a note, not a fault.

## Prior art to read first

- `~/src/ha/esp/garasje/kicad/surface_spoilboard.py` — the working generator.
  Its comments explain *why* for most of the rules above.
- `~/src/ha/esp/garasje/kicad/fix_gcode.py` — `mkr_header()` and `thumbnail()`.
- `~/src/ha/esp/garasje/EASYTRACE-Z1.md` — the `;@MKR|` investigation.
- `~/src/ha/esp/garasje/TOOLING.md` — the speeds-and-feeds table.
- `~/src/ha/esp/garasje/MILLING.md` — machine behaviour, G32/M6/G28 semantics.

## Immediate use

The first real job is a spoilboard facing for the flip-gauge coupon parked in
`~/src/ha/esp/garasje/STATUS.md`: that job plunges to **−5.7mm**, 4.0mm below
the board, so the backing must be thick *and* flat. Until this app exists,
`surface_spoilboard.py` already does exactly that job for MDF.
