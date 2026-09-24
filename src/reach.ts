/**
 * The reach check, as MDI lines you can paste one at a time.
 *
 * Every job this app produces carries the warning that its origin has to sit far
 * enough back in the travel -- MILLING.md's facing job found that out from a
 * soft endstop mid-trace, after the file had already started. The check is to
 * drive the head to each corner first and watch it get there.
 *
 * Doing that by jogging is the annoying part: the jog control moves at most 10mm
 * per press and wants ~2s between presses, so walking a 150mm job's perimeter is
 * sixty-odd presses and a minute of waiting. One MDI line per corner does the
 * same thing in four moves.
 *
 * The corners traced are the STOCK corners (0..W, -H..0), not the toolpath
 * extents (r-o..W-(r-o)). They are the larger of the two -- the overhang is
 * capped at the tool radius, so the tool centre never leaves the block -- and
 * a walk that reaches them clears the toolpath as well.
 *
 * It is NOT what the controller's laser boundary trace walks. That was said
 * here until 2026-09-23 and was wrong: the trace follows the tool centre, so it
 * sits r-o inside the block. MILLING.md's first trace went to X1.587 Y158.412
 * for a 120 x 160 job, and a 45mm job on a 45.2mm block traced visibly inside it.
 */

import type { JobRequest } from "./validate.ts";
import { g } from "./mkr.ts";
import { SAFE_Z } from "./facing.ts";

export interface ReachStep {
  /** The MDI line, bare -- no trailing comment, in case the parser dislikes one. */
  readonly code: string;
  readonly why: string;
  /** The corner that fails first on a job that is too far forward. */
  readonly critical?: boolean;
}

export function reachCheck(req: Pick<JobRequest, "width" | "height">): ReachStep[] {
  const x = g(req.width);
  const y = g(-req.height);
  return [
    {
      code: "G90 G21",
      why: "Absolute mm (jogging can leave G91 set).",
    },
    { code: `G0 Z${g(SAFE_Z)}`, why: "Lift. After zeroing Z." },
    { code: "G0 X0 Y0", why: "Origin." },
    { code: `G0 X${x} Y0`, why: "Back right." },
    { code: `G0 X${x} Y${y}`, why: "Front right: the one that hits the endstop.", critical: true },
    { code: `G0 X0 Y${y}`, why: "Front left." },
    { code: "G0 X0 Y0", why: "Origin, ready." },
  ];
}

/**
 * The same walk for a file this app did not write: round any box, from either
 * origin corner. `yNear` is the Y edge on the origin's side and `yFar` the other,
 * so a +Y job from a front-left origin walks away from you instead of toward you.
 * The critical corner is the one furthest from X0 Y0, which is the one that
 * finds a soft endstop first whichever way the job runs.
 */
export function reachWalk(box: { x0: number; x1: number; y0: number; y1: number }): ReachStep[] {
  const positive = box.y0 + box.y1 > 0;
  const yNear = positive ? box.y0 : box.y1;
  const yFar = positive ? box.y1 : box.y0;
  const corner = (x: number, y: number) => `G0 X${g(round(x))} Y${g(round(y))}`;
  return [
    {
      code: "G90 G21",
      why: "Absolute mm (jogging can leave G91 set).",
    },
    { code: `G0 Z${g(SAFE_Z)}`, why: "Lift. After zeroing Z." },
    { code: corner(box.x0, yNear), why: "Near corner, origin side." },
    { code: corner(box.x1, yNear), why: "Near edge, far end." },
    {
      code: corner(box.x1, yFar),
      why: `Far corner (${positive ? "away from you" : "toward you"}): the one that hits the endstop.`,
      critical: true,
    },
    { code: corner(box.x0, yFar), why: "Far edge, back in X." },
    { code: "G0 X0 Y0", why: "Origin, ready." },
  ];
}

const round = (v: number) => Number(v.toFixed(2));

/**
 * The same thing as a comment block for the top of the .nc, so the file carries
 * its own instructions for checking it. Comments cost nothing at the controller
 * and the file is often read on the laptop before it is ever loaded.
 */
export function reachCheckComment(req: Pick<JobRequest, "width" | "height">): string[] {
  const steps = reachCheck(req);
  const width = Math.max(...steps.map((s) => s.code.length));
  // ASCII only, and no trailing whitespace. The controller skips comments, but
  // it is a byte parser on an embedded board and there is nothing to gain from
  // feeding it multi-byte punctuation in a file it has to read off a USB stick.
  return [
    "; Reach check - paste these into MDI before running, and watch the head get",
    "; to each one. Jogging there takes 10mm per press with a wait between; these",
    "; are one move each.",
    ...steps.map((s) =>
      (`;   ${s.code.padEnd(width)}` + (s.critical ? "   <-- the far corner, the one that fails first" : "")).trimEnd()),
    "; A relative hop, if you just want the head out of the way, is:",
    ";   G91",
    ";   G0 Z10",
    ";   G0 X-25",
    ";   G90",
    "; Z and X only, deliberately. Y is the axis with no slack on this machine:",
    "; a job already runs the gantry most of the way toward you, so a relative Y",
    "; move in either direction is the one that finds an endstop.",
    "; G91 is modal and stays set until G90 puts it back. Leaving it set is how a",
    "; later absolute move ends up 80mm from where it should be.",
  ];
}
