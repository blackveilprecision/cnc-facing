/**
 * The toolpath. Pure: numbers in, geometry and G-code strings out.
 *
 * The default pattern is a port of `surface_spoilboard.py`'s `facing()` from
 * ~/src/ha/esp/garasje/kicad, generalised to multiple depth passes. That script
 * has been run on the machine and its output is the golden fixture in
 * test/fixtures; for a single-pass MDF job this module emits the same motion
 * lines byte for byte, and the test asserts it.
 *
 * Three rules here are machine findings, not style. Do not "simplify" them away:
 *
 *  1. The stepover between passes is `G1`, never `G0`. An early version rapided
 *     sideways with the cutter buried -- 1.43mm of radial engagement at up to
 *     3000 mm/min -- and left a groove the neighbouring passes did not.
 *  2. Y runs NEGATIVE, toward the operator, from a top-left origin. A +Y facing
 *     job drives the gantry away: a 160mm job asked for Y+158.412 and the
 *     controller answered "Soft Endstop Y was exceeded" before cutting anything.
 *     Every job on this machine must sweep the same way from the same datum, or
 *     one origin cannot serve both this and the PCB jobs.
 *  3. The tool CENTRE runs from r to W-r, so the SWEPT area is exactly 0..W.
 *     That is what makes "face 80x60" mean what the user expects.
 *
 * PATTERNS
 *
 * Four, for finding out how this machine faces best. They differ in which axis
 * does the cutting and whether every pass is climb:
 *
 *   serpentine-x  the original. Cuts along X, steps into -Y, alternates climb
 *                 (+X) and conventional (-X).
 *   serpentine-y  the same, rotated: cuts along Y, which is the stiffer axis on
 *                 a gantry machine, steps into +X, alternates again.
 *   oneway-y      cuts along Y, always travelling +Y with the uncut material on
 *                 the right -- climb on every pass. Lifts, rapids back to the
 *                 front edge and plunges again between passes.
 *   spiral        concentric rectangles, clockwise and inward from the edge.
 *                 Climb all the way round with no lifts, and every ring cuts in
 *                 all four directions, so one coupon shows the X-cut and Y-cut
 *                 surfaces side by side.
 *
 * Climb here means for M3 (clockwise from above): material on the right of the
 * direction of travel, which is what G41 compensation assumes.
 *
 * MODES
 *
 * `general` is the original behaviour and the default: one pass of the chosen
 * pattern per depth level. It is what a spoilboard or a fixture plate wants -- a
 * flat reference to tape stock to, where speed matters and the look of it does
 * not.
 *
 * `finish` leaves a thin allowance, then takes it off in one last pass that is
 * rotated 90 degrees and steps about half as far. The rotation is the point: a
 * finishing pass running the same way as the roughing pass rides in its grooves,
 * while one running across them cuts them off. Finish mode is serpentine-x
 * roughing and a serpentine-y finish, always; the pattern choice is general-mode
 * only until the coupons say which pattern a finishing pass should use.
 */

import type { Recipe } from "./materials.ts";

/** Which axis the raster lines run along. `x` is the default sweep. */
export type Axis = "x" | "y";

export type Mode = "general" | "finish";

export type Pattern = "serpentine-x" | "serpentine-y" | "oneway-y" | "spiral";

export const PATTERNS: readonly Pattern[] = ["serpentine-x", "serpentine-y", "oneway-y", "spiral"];

export const DEFAULT_PATTERN: Pattern = "serpentine-x";

export function isPattern(v: unknown): v is Pattern {
  return typeof v === "string" && (PATTERNS as readonly string[]).includes(v);
}

export interface Pt { readonly x: number; readonly y: number }

export interface FacingSpec {
  /** Faced area in X, mm. The swept area, not the tool path. */
  readonly width: number;
  /** Faced area in Y, mm. */
  readonly height: number;
  /** Total depth to remove, mm. Split across passes by the tool's max DOC. */
  readonly depth: number;
  /** The resolved material + tool: feeds, DOC and the tool itself. */
  readonly material: Recipe;
  /** Fraction of tool diameter. Defaults to the profile's value at the call site. */
  readonly stepover: number;
  readonly mode: Mode;
  /** General mode only. Omitted means serpentine-x. */
  readonly pattern?: Pattern;
}

/** A raster level's lines, for the patterns that have them. */
export interface Raster {
  /** Which axis the cutting moves run along. The other one takes the stepover. */
  readonly axis: Axis;
  /**
   * Position of each raster line on the STEPPING axis, in travel order.
   * For axis `x` these are Y coordinates and are all <= 0; for axis `y` they
   * are X coordinates and are all >= 0.
   */
  readonly lines: number[];
  /** The two ends of the sweep on the CUTTING axis. */
  readonly from: number;
  readonly to: number;
}

/** One depth level. */
export interface Level {
  /** Cumulative depth below Z0, positive mm. Emitted as `G1 Z-<z>`. */
  readonly z: number;
  readonly pattern: Pattern;
  /**
   * The motion, as continuous G1 polylines at this depth. The tool plunges at
   * the first point of each stroke and lifts after the last; everything in
   * between is cut. A serpentine or a spiral is one stroke; one-way is one per
   * pass. gcodeBody(), the time estimate and the preview all read this, so the
   * three cannot disagree.
   */
  readonly strokes: Pt[][];
  /** Passes in this level: raster lines, or rings for the spiral. */
  readonly passes: number;
  /** The raster lines, for the patterns that have them; null for the spiral. */
  readonly raster: Raster | null;
  /** The last pass in `finish` mode: thin, finer stepover, usually rotated. */
  readonly isFinish: boolean;
}

export interface FacingPath {
  readonly spec: FacingSpec;
  readonly pattern: Pattern;
  /** Tool radius, mm. */
  readonly r: number;
  /** Lateral step between raster lines, mm. */
  readonly step: number;
  readonly xLo: number;
  readonly xHi: number;
  readonly levels: Level[];
  /** Passes in one roughing level. */
  readonly passesPerLevel: number;
  /** Every cutting pass in the job, roughing and finishing together. */
  readonly totalPasses: number;
  readonly mode: Mode;
  /** Depth of each pass, cumulative, mm -- what the summary shows. */
  readonly passDepths: number[];
  /** Total distance the tool travels while cutting, mm. */
  readonly cutLength: number;
  /** Estimate for `;@MKR|TIME|seconds=`. See estimateSeconds(). */
  readonly seconds: number;
}

/** Safe Z for rapids above the work. Matches surface_spoilboard.py and the CAM. */
export const SAFE_Z = 5.0;

/**
 * Lift height between the passes of a one-way level, mm above Z0.
 *
 * Everything under the rapid is at or below Z0 -- the uncut column is the stock
 * top, the cut ones are deeper -- so 1mm clears it, and plunging 1.2mm at the
 * plunge feed instead of 5.2mm is most of a second saved on every pass. Moving
 * between LEVELS still goes up to SAFE_Z, as it always has.
 */
export const CLEAR_Z = 1.0;

/** Rapids are charged at this rate in the time estimate, as fix_gcode.py does. */
const RAPID_FEED = 1000;

/**
 * Split a total depth into passes no deeper than `maxPerPass`.
 *
 * Passes are EQUAL rather than "max, max, ..., remainder": a 0.25mm remainder
 * after two 1.0mm bites is a spring pass that loads the tool differently from
 * the ones before it, and an even split costs nothing since the pass count is
 * the same either way.
 */
export function splitDepth(depth: number, maxPerPass: number): number[] {
  const n = Math.max(1, Math.ceil(depth / maxPerPass - 1e-9));
  const each = depth / n;
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? depth : each * (i + 1)));
}

/**
 * Evenly stepped positions from `lo` to `hi`, both included.
 *
 * The far end is always added explicitly so the last pass finishes flush with
 * it rather than leaving a sliver of the stepover unswept.
 */
function stepped(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  let v = lo;
  while (v < hi - 1e-9) {
    out.push(v);
    v += step;
  }
  out.push(hi);
  return out;
}

const same = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-9;

/** One continuous serpentine: cut, step (G1), cut back, step... */
function serpentineStroke(r: Raster, startsForward: boolean): Pt[] {
  const at = (cut: number, line: number): Pt =>
    r.axis === "x" ? { x: cut, y: line } : { x: line, y: cut };
  const pts: Pt[] = [at(startsForward ? r.from : r.to, r.lines[0]!)];
  let forward = startsForward;
  r.lines.forEach((v, i) => {
    if (i) pts.push(at(forward ? r.from : r.to, v));
    pts.push(at(forward ? r.to : r.from, v));
    forward = !forward;
  });
  return pts;
}

/**
 * The spiral: rings of tool-centre offset o from every edge, o = r, r+step, ...
 * up to half the short side, where the last ring collapses to a line (or a
 * point, for a square).
 *
 * Each ring is walked clockwise from its back-left corner and CLOSED before the
 * stepover, which is a short diagonal G1 to the next ring's corner. Closing it
 * costs one stepover's worth of recut per ring; not closing it leaves a sliver
 * at the back-left corner of the first ring, outside the reach of both the ring
 * before and the step after.
 */
function spiralStroke(w: number, h: number, r: number, step: number): { pts: Pt[]; rings: number } {
  const offsets = stepped(r, Math.min(w, h) / 2, step);
  const pts: Pt[] = [];
  const push = (p: Pt) => { if (!pts.length || !same(pts.at(-1)!, p)) pts.push(p); };
  for (const o of offsets) {
    const ring: Pt[] = [
      { x: o, y: -o },
      { x: w - o, y: -o },
      { x: w - o, y: -(h - o) },
      { x: o, y: -(h - o) },
      { x: o, y: -o },
    ];
    // A collapsed ring is a line walked out and back; out is enough.
    const flat = w - 2 * o < 1e-9 || h - 2 * o < 1e-9;
    for (const p of flat ? ring.slice(0, 3) : ring) push(p);
  }
  return { pts, rings: offsets.length };
}

interface Frame {
  readonly w: number;
  readonly h: number;
  readonly r: number;
  readonly step: number;
}

/**
 * Plan one level of `pattern` at depth z. `flip` reverses a raster's line
 * order, which is how a serpentine's even levels sweep back the way the odd
 * ones came and so need no repositioning move to step down.
 */
function planLevel(f: Frame, pattern: Pattern, z: number, flip: boolean, startsForward: boolean): Level {
  const { w, h, r, step } = f;
  if (pattern === "spiral") {
    const { pts, rings } = spiralStroke(w, h, r, step);
    return { z, pattern, strokes: [pts], passes: rings, raster: null, isFinish: false };
  }

  // Raster lines. Along X they are Ys, negated because the job sweeps toward
  // the operator -- rule 2 in the header. Along Y they are Xs.
  const axis: Axis = pattern === "serpentine-x" ? "x" : "y";
  const base = axis === "x"
    ? stepped(r, h - r, step).map((v) => -v)
    : stepped(r, w - r, step);
  const lines = flip ? [...base].reverse() : base;
  const raster: Raster = axis === "x"
    ? { axis, lines, from: r, to: w - r }
    : { axis, lines, from: -r, to: -(h - r) };

  if (pattern === "oneway-y") {
    // Front to back, every pass: travelling +Y with the uncut columns at +X,
    // which is on the right -- climb. The plunge is at the front edge, which is
    // where its dwell mark lands; stock faced oversize puts it outside the part.
    const strokes = raster.lines.map((x) => [{ x, y: raster.to }, { x, y: raster.from }]);
    return { z, pattern, strokes, passes: lines.length, raster, isFinish: false };
  }

  return {
    z,
    pattern,
    strokes: [serpentineStroke(raster, startsForward)],
    passes: lines.length,
    raster,
    isFinish: false,
  };
}

export function planFacing(spec: FacingSpec): FacingPath {
  const d = spec.material.tool.diameter;
  const r = d / 2;
  const step = d * spec.stepover;
  const frame: Frame = { w: spec.width, h: spec.height, r, step };
  // Finish mode's strategy is fixed; the pattern is a general-mode choice.
  const pattern = spec.mode === "finish" ? DEFAULT_PATTERN : spec.pattern ?? DEFAULT_PATTERN;

  const allowance = spec.mode === "finish" ? spec.material.finishAllowance : 0;
  const roughDepth = spec.depth - allowance;
  const roughDepths = roughDepth > 1e-9
    ? splitDepth(roughDepth, spec.material.maxDepthPerPass)
    : [];

  // A serpentine is one continuous path through all its levels: each sweeps
  // back the way the last one came, so stepping down never needs a
  // repositioning move across the surface just cut. The other patterns start
  // every level from the same corner, and pay a lift and a rapid for it.
  const serpentine = pattern === "serpentine-x" || pattern === "serpentine-y";
  let forward = true;
  const levels: Level[] = roughDepths.map((z, i) => {
    const level = planLevel(frame, pattern, z, serpentine && i % 2 === 1, forward);
    if (serpentine && level.passes % 2 === 1) forward = !forward;
    return level;
  });

  if (spec.mode === "finish") {
    // Rotated 90 degrees: raster lines at constant X, cutting along Y. Every Y
    // it emits is still negative, and the swept area is still exactly the
    // requested rectangle -- the r..W-r convention just applies to the other
    // axis. The finer stepover is what makes it a finishing pass.
    const fine = { ...frame, step: d * spec.material.finishStepover };
    levels.push({ ...planLevel(fine, "serpentine-y", spec.depth, false, true), isFinish: true });
  }

  const cutLength = levels.reduce((sum, level) =>
    sum + level.strokes.reduce((s, pts) =>
      s + pts.slice(1).reduce((a, p, i) => a + Math.hypot(p.x - pts[i]!.x, p.y - pts[i]!.y), 0), 0), 0);

  return {
    spec,
    pattern,
    r,
    step,
    xLo: r,
    xHi: spec.width - r,
    levels,
    passesPerLevel: planLevel(frame, pattern, 0, false, true).passes,
    totalPasses: levels.reduce((n, l) => n + l.passes, 0),
    mode: spec.mode,
    passDepths: levels.map((l) => l.z),
    cutLength,
    seconds: estimateSeconds(levels, spec),
  };
}

/** Where the tool sits at the start of a level, in (x, y). */
export function levelStart(level: Level): Pt {
  return level.strokes[0]![0]!;
}

/** Where the tool ends up after a level. */
export function levelEnd(level: Level): Pt {
  return level.strokes.at(-1)!.at(-1)!;
}

/**
 * Every move in the body, in order. gcodeBody() prints these and
 * estimateSeconds() times them, so the estimate is of the file, not of a model
 * of it.
 */
type Op =
  | { readonly op: "rapid"; readonly to: Pt }
  | { readonly op: "lift"; readonly z: number }
  | { readonly op: "plunge"; readonly z: number }
  | { readonly op: "cut"; readonly to: Pt };

function program(levels: Level[]): Op[] {
  const ops: Op[] = [];
  let at: Pt | null = null;
  for (const level of levels) {
    for (const [si, pts] of level.strokes.entries()) {
      const start = pts[0]!;
      if (!at) {
        ops.push({ op: "rapid", to: start });
      } else if (!same(start, at)) {
        // Lift clear FIRST: a rapid across the work at cutting depth is the
        // groove-cutting mistake this file exists to avoid. Within a one-way
        // level the lift is to CLEAR_Z; between levels -- the rotated
        // finishing pass, or a spiral going back to its corner -- to SAFE_Z.
        ops.push({ op: "lift", z: si > 0 ? CLEAR_Z : SAFE_Z });
        ops.push({ op: "rapid", to: start });
      }
      // Every stroke starts with a plunge. A step down from the previous level
      // at the same spot is only that: no lift, no traverse.
      ops.push({ op: "plunge", z: level.z });
      for (const p of pts.slice(1)) ops.push({ op: "cut", to: p });
      at = pts.at(-1)!;
    }
  }
  return ops;
}

/**
 * Rough cut time for `;@MKR|TIME|seconds=`.
 *
 * Makera's own files always carry the field, so ours does too. It is advisory --
 * the controller does not gate on it -- but it is also the number the UI shows
 * the user to talk them out of a 4-hour brass job, so it times every move the
 * body makes rather than using surface_spoilboard.py's cutting-length-only
 * approximation, plus the final retract gcode.ts adds after it.
 */
function estimateSeconds(levels: Level[], spec: FacingSpec): number {
  const { feed, plunge } = spec.material;
  let pos: Pt = { x: 0, y: 0 };
  let z = SAFE_Z;
  let minutes = 0;
  for (const o of program(levels)) {
    if (o.op === "rapid" || o.op === "cut") {
      minutes += Math.hypot(o.to.x - pos.x, o.to.y - pos.y) / (o.op === "rapid" ? RAPID_FEED : feed);
      pos = o.to;
    } else if (o.op === "lift") {
      minutes += (o.z - z) / RAPID_FEED;
      z = o.z;
    } else {
      minutes += (z + o.z) / plunge;
      z = -o.z;
    }
  }
  minutes += (SAFE_Z - z) / RAPID_FEED;
  return minutes * 60;
}

/** Python `%g` for the Z words, matching what gcode.ts emits elsewhere. */
function g0(v: number): string {
  return Number(v.toPrecision(6)).toString();
}

/** Python `%.3f`, which is what the reference emits and the machine has seen. */
function f3(v: number): string {
  // -0 would print as "-0.000"; the reference never produces it, but a width
  // exactly equal to the tool diameter could, and "0.000" is what it means.
  return (Object.is(v, -0) ? 0 : v).toFixed(3);
}

/**
 * The motion body: everything between the spindle-start dwell and the retract.
 *
 * For a single-level `general` serpentine-x job this is byte-identical to
 * surface_spoilboard.py's output, which is what the golden test pins down. A
 * cutting move names only the axes that change, which is what the reference
 * does and what makes a spiral's ring stepover the only two-axis G1.
 */
export function gcodeBody(path: FacingPath): string[] {
  const { feed, plunge } = path.spec.material;
  const lines: string[] = [];
  let at = { x: f3(0), y: f3(0) };
  for (const o of program(path.levels)) {
    if (o.op === "rapid") {
      at = { x: f3(o.to.x), y: f3(o.to.y) };
      lines.push(`G0 X${at.x} Y${at.y}`);
    } else if (o.op === "lift") {
      lines.push(`G0 Z${g0(o.z)}`);
    } else if (o.op === "plunge") {
      lines.push(`G1 Z-${f3(o.z)} F${plunge}`);
    } else {
      // The stepover is one of these too. G1, not G0 -- rule 1 in the header.
      const next = { x: f3(o.to.x), y: f3(o.to.y) };
      const words = [
        ...(next.x !== at.x ? [`X${next.x}`] : []),
        ...(next.y !== at.y ? [`Y${next.y}`] : []),
      ];
      if (words.length) lines.push(`G1 ${words.join(" ")} F${feed}`);
      at = next;
    }
  }
  return lines;
}
