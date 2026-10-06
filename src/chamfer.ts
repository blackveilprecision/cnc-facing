/**
 * The chamfer: after the facing, in the same file, one lap (or a few) round the
 * block's top edge with the 90° chamfering bit, to take off the sharp edge the
 * facing leaves.
 *
 * Only with the overhang on. Without it the faced area is a rectangle inside a
 * larger surface and has no edge to break.
 *
 * GEOMETRY
 *
 * The tool centre runs the block's outline, 0..W and -H..0, the same box the
 * overhang puts the end mill's centre on, so nothing goes behind or left of
 * X0 Y0 (facing.ts, rule 2). The bit is a 45° cone on a 0.1mm flat tip. With
 * the tip t below the faced top, the cone meets the top face at tipR + t from
 * the edge, so for a chamfer c wide on the top face the tip goes to
 *
 *     t = c - tipR
 *
 * below it. Under the chamfer that leaves a 0.05mm-wide flat at the bottom,
 * the tip's own width: too small to see.
 *
 * The faced top is at Z = -depth, so the tip's final Z is -(depth + t). Z0 is
 * still the stock's original top after the tool change, because M6 re-probes
 * the new bit's length (tested), which is what the PCB jobs'
 * drills rely on too.
 *
 * DIRECTION
 *
 * Clockwise seen from above: along the back edge in +X, then the right edge in
 * -Y, and so on. The block is on the right of the direction of travel all the
 * way round, which for M3 is climb, as facing.ts defines it.
 *
 * The corners come out as proper mitres: the centre path's corners sit exactly
 * on the block's, so each edge's chamfer runs the full length of the edge.
 */

import { g } from "./mkr.ts";
import { splitDepth, SAFE_Z, type Pt } from "./facing.ts";
import type { ChamferProfile } from "./materials.ts";

export interface ChamferPlan {
  readonly profile: ChamferProfile;
  /** Width on the top face, mm. */
  readonly width: number;
  /** Tip depth below the faced top, mm: width - tip radius. */
  readonly tipDepth: number;
  /** Absolute tip Z of each lap, positive mm below Z0, deepest last. */
  readonly laps: number[];
  /** The closed outline the tool centre follows, clockwise from X0 Y0. */
  readonly outline: Pt[];
  readonly cutLength: number;
  readonly seconds: number;
}

export function planChamfer(opts: {
  profile: ChamferProfile;
  width: number;
  /** Block size, mm. */
  w: number;
  h: number;
  /** Facing depth, mm: where the faced top is. */
  faceDepth: number;
}): ChamferPlan {
  const { profile, width, w, h, faceDepth } = opts;
  const tipDepth = width - profile.tool.tipDiameter / 2;
  const laps = splitDepth(tipDepth, profile.maxDepthPerPass).map((d) => faceDepth + d);
  const outline: Pt[] = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: -h },
    { x: 0, y: -h },
    { x: 0, y: 0 },
  ];
  const perimeter = 2 * (w + h);
  const cutLength = perimeter * laps.length;
  // Rapid to the corner and down to safe Z are charged at 1000 mm/min, as
  // facing.ts does; the plunges from SAFE_Z to the first lap and between laps
  // at the plunge feed. The tool change itself takes as long as you do.
  const plunge = SAFE_Z + laps.at(-1)!;
  const minutes = cutLength / profile.feed + plunge / profile.plunge + (SAFE_Z * 2) / 1000;
  return { profile, width, tipDepth, laps, outline, cutLength, seconds: minutes * 60 };
}

/** Python `%.3f`, as facing.ts emits. */
const f3 = (v: number) => (Object.is(v, -0) ? 0 : v).toFixed(3);

/**
 * The chamfer section of the file: stop, change to T2, spin up, then the laps.
 * Starts right after the facing body has lifted to SAFE_Z, and ends down in
 * the cut; gcode.ts's trailer lifts, stops and parks as it always has.
 *
 * `G0 Z5`, `M5`, then `T2 M6` on ONE line: the order used at a
 * bit change and every multi-tool PCB file here has run with.
 */
export function chamferBody(plan: ChamferPlan): string[] {
  const { profile } = plan;
  const lines = [
    `G0 Z${g(SAFE_Z)}`,
    "M5",
    ";@MKR|TOOLPATH_START|toolpath_number=2",
    "",
    `; T2-${profile.tool.name} - CHAMFER`,
    "",
    "T2 M6",
    `G0 Z${g(SAFE_Z)}`,
    `S${profile.rpm} M3`,
    "G4 P1",
    "G0 X0.000 Y0.000",
  ];
  for (const z of plan.laps) {
    lines.push(`G1 Z-${f3(z)} F${profile.plunge}`);
    let at = plan.outline[0]!;
    for (const p of plan.outline.slice(1)) {
      const words = [
        ...(p.x !== at.x ? [`X${f3(p.x)}`] : []),
        ...(p.y !== at.y ? [`Y${f3(p.y)}`] : []),
      ];
      lines.push(`G1 ${words.join(" ")} F${profile.feed}`);
      at = p;
    }
  }
  return lines;
}
