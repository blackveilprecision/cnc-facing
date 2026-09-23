/**
 * A coarse simulation of the stock, for one question: when the file moves a
 * bit, how much material is it actually in?
 *
 * The checker needs that to compare a file with Makera's table honestly.
 * Reading depth per pass off the Z levels gets it wrong in both directions: a
 * helical hole has one flat orbit at the bottom and would read as the whole
 * hole in one pass; a pocket's rapids and plunges inside air it has already
 * cleared would read as cuts. Makera Studio's own sample does the second
 * 25,000 times. So this keeps a height map of the stock top, starting flat at
 * Z0, and every move lowers it by the bit's real profile:
 *
 *   flat     a disk (flat end, corn, drill)
 *   ball     a hemisphere
 *   cone     a V-bit or chamfer: the tip, widening at its half-angle
 *
 * What each move removes, measured before the map is lowered under it, is its
 * engagement: for a lateral move, the depth per pass; for a plunge, the peck.
 *
 * It is the depth reached by a band of new material at least a fifth of the
 * bit's diameter wide -- not simply the deepest cell. A wall-finishing pass at
 * full depth with a 0.1mm radial leave, or an orbit a hundredth off the helix
 * it follows, touches a sliver of uncut stock with its flank, and the deepest
 * cell reports 1.7mm for a hole cut 0.28mm a revolution. So does a finishing
 * pass running through the edge scallops a raster leaves. Nor is it measured
 * under the bit's centre, which in steady cutting arrives over floor its own
 * leading edge has already cleared. A slot, a facing pass at 45% stepover and
 * a helix all clear more than a fifth of the diameter, so their depth
 * comes through whole. And a lateral depth must hold for two positions of the
 * bit in a row: the first contact of a pass started beside an earlier one cuts
 * a crescent across the whole face of the bit, once, and then settles to its
 * real radial engagement. The deepest cell is still returned, for rapids.
 * Cells are 0.03-0.25mm, about a fifteenth of the narrowest bit, which is fine
 * enough to tell a pass from a sliver. Depths themselves are exact: only where
 * the bit is gets rounded to the grid, never how deep it goes.
 */

export interface Pt3 { readonly x: number; readonly y: number; readonly z: number }

export interface Cutter {
  readonly kind: "flat" | "ball" | "cone";
  /** Largest radius the bit can cut at, mm. For a cone, the shank's. */
  readonly radius: number;
  /** Cone only: the tip's radius and the half-angle, degrees. */
  readonly tipRadius?: number;
  readonly halfAngle?: number;
}

export interface Segment {
  readonly tool: number;
  /** Points along the move, the start first. Arcs arrive already chorded. */
  readonly pts: Pt3[];
}

/** Most cells the map may have. 4M floats is 16MB, and plenty for 200 x 200. */
const MAX_CELLS = 4_000_000;

export interface Engagement {
  /** Depth of cut per segment, mm: reached by a band a fifth of the bit wide. */
  readonly depth: Float32Array;
  /** Deepest single cell removed per segment, mm. */
  readonly any: Float32Array;
}

/**
 * Radial engagement below this fraction of the diameter is a sliver, not a
 * cut. 0.2 because the smallest real slivers here are the edge scallops a
 * raster leaves where its passes end -- about 0.17mm on the 3.175 bit, which a
 * rotated finishing pass then runs through at full depth -- while the lightest
 * real cut is a facing pass at 45% stepover.
 */
const MIN_RADIAL = 0.2;

/** Nominal cutting width: a V-bit's at a PCB-ish depth, anything else's diameter. */
const cutWidth = (c: Cutter) => (c.kind === "cone" ? 2 * ((c.tipRadius ?? 0.05) + 0.05) : 2 * c.radius);

/** Engagement per segment. Zero means the move went through air. */
export function simulate(
  segments: readonly Segment[],
  cutters: ReadonlyMap<number, Cutter>,
  box: { x0: number; x1: number; y0: number; y1: number },
): Engagement {
  const depth = new Float32Array(segments.length);
  const any = new Float32Array(segments.length);
  if (!segments.length) return { depth, any };
  const radii = [...cutters.values()];
  const rMax = Math.max(0.5, ...radii.map((c) => c.radius));
  const wMin = Math.min(...radii.map(cutWidth), 2);
  const x0 = box.x0 - rMax;
  const y0 = box.y0 - rMax;
  const w = box.x1 - box.x0 + 2 * rMax;
  const h = box.y1 - box.y0 + 2 * rMax;
  // Fine enough that a band a fifth of the narrowest bit wide spans several
  // cells, or a sliver and a pass cannot be told apart.
  let cell = Math.min(0.25, Math.max(0.03, wMin / 15));
  if ((w / cell) * (h / cell) > MAX_CELLS) cell = Math.sqrt((w * h) / MAX_CELLS);
  const nx = Math.ceil(w / cell) + 1;
  const ny = Math.ceil(h / cell) + 1;
  // The stock top, Z0 everywhere to begin with.
  const surf = new Float32Array(nx * ny);

  const fallback: Cutter = { kind: "flat", radius: 0.5 };

  // The k deepest removals of the current stamp, deepest first.
  const top = new Float32Array(1024);
  let kept = 0;
  let want = 1;
  let hitAny = 0;
  const keep = (v: number) => {
    if (kept === want && v <= top[kept - 1]!) return;
    let i = kept < want ? kept++ : kept - 1;
    while (i > 0 && top[i - 1]! < v) { top[i] = top[i - 1]!; i--; }
    top[i] = v;
  };
  /** Lower the map under one position of the bit, noting what it removed. */
  const stamp = (c: Cutter, p: Pt3, step: number): number => {
    kept = 0;
    hitAny = 0;
    if (p.z >= 0) return 0;
    // Only as wide as the profile reaches below the highest possible surface (Z0).
    let reach = c.radius;
    if (c.kind === "cone") {
      const tan = Math.tan(((c.halfAngle ?? 15) * Math.PI) / 180);
      reach = Math.min(c.radius, (c.tipRadius ?? 0) + -p.z * tan);
    }
    // The cells a band MIN_RADIAL of the width in use covers over one step. A
    // V-bit's width is what it cuts at this depth, not its shank.
    want = Math.min(top.length, Math.max(1, Math.round((MIN_RADIAL * 2 * reach * step) / (cell * cell))));
    const ci = Math.round((p.x - x0) / cell);
    const cj = Math.round((p.y - y0) / cell);
    const span = Math.ceil(reach / cell);
    const tan = c.kind === "cone" ? Math.tan(((c.halfAngle ?? 15) * Math.PI) / 180) : 0;
    for (let j = Math.max(0, cj - span); j <= Math.min(ny - 1, cj + span); j++) {
      const dy = y0 + j * cell - p.y;
      for (let i = Math.max(0, ci - span); i <= Math.min(nx - 1, ci + span); i++) {
        const dx = x0 + i * cell - p.x;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > reach) continue;
        let z = p.z;
        if (c.kind === "ball") z += c.radius - Math.sqrt(Math.max(0, c.radius * c.radius - d * d));
        else if (c.kind === "cone") z += Math.max(0, d - (c.tipRadius ?? 0)) / tan;
        const k = j * nx + i;
        const cut = surf[k]! - z;
        if (cut > 0) {
          if (cut > hitAny) hitAny = cut;
          keep(cut);
          surf[k] = z;
        }
      }
    }
    return kept === want ? top[want - 1]! : 0;
  };

  // The last lateral stamp's depth, for the two-in-a-row rule. Carried across
  // segments that join end to start, because a curve arrives as many short
  // chords; reset by anything else (a new tool, a lift and move elsewhere).
  let prev = 0;
  let prevTool = Number.NaN;
  let last: Pt3 | null = null;
  segments.forEach((s, idx) => {
    const c = cutters.get(s.tool) ?? fallback;
    const start = s.pts[0]!;
    const joined = last !== null && Math.abs(last.x - start.x) < 1e-6 && Math.abs(last.y - start.y) < 1e-6 && Math.abs(last.z - start.z) < 1e-6;
    if (s.tool !== prevTool || !joined) prev = 0;
    prevTool = s.tool;
    last = s.pts.at(-1)!;
    // Positions a quarter of the working radius apart overlap enough that the
    // removal between them is measured, and no closer than a cell.
    const step = Math.max(cell, cutWidth(c) / 8);
    let deep = 0;
    let deepAny = 0;
    for (let k = 1; k < s.pts.length; k++) {
      const a = s.pts[k - 1]!;
      const b = s.pts[k]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      // A plunge has no lateral length: one stamp at the bottom measures the peck.
      const n = Math.max(1, Math.ceil(len / step));
      for (let t = 1; t <= n; t++) {
        const f = t / n;
        const e = stamp(c, { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f }, step);
        // A plunge has one stamp and is its own measure; a lateral move needs two.
        const held = len > 0 ? Math.min(e, prev) : e;
        if (len > 0) prev = e;
        if (held > deep) deep = held;
        if (hitAny > deepAny) deepAny = hitAny;
      }
    }
    depth[idx] = deep;
    any[idx] = deepAny;
  });
  return { depth, any };
}
